//! End-to-end tests of the `/api` Router against a real Postgres with the
//! migrations applied (`docker compose run --rm cargo test --workspace`, or
//! CI's postgres service), a folder for files and a fake Google key.
//!
//! Skipped when `DATABASE_URL` is unset. Each test signs in fresh users with
//! random Google ids, so tests don't see each other's data.

use std::sync::atomic::{AtomicU64, Ordering};

use accounts::crypto::Keyring;
use accounts::storage::{FsStore, Storage};
use accounts::testing::{
    TEST_CLIENT_ID, TEST_DATA_KEY, TEST_KID, docx_resume, pdf_resume, sign_google_token,
    test_verifier,
};
use api::{AppState, Config, router};
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;
use uuid::Uuid;

static SEQ: AtomicU64 = AtomicU64::new(0);

fn rand_octet() -> u8 {
    Uuid::new_v4().as_bytes()[0]
}

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        Uuid::new_v4().simple(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

struct TestApp {
    router: Router,
    pool: sqlx::PgPool,
}

fn app_with(tweak: impl FnOnce(&mut Config)) -> Option<TestApp> {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("DATABASE_URL is unset; skipping API tests");
        return None;
    };
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect_lazy(&url)
        .expect("database url");
    let keys = Keyring::parse(&format!("1:{TEST_DATA_KEY}"), None);
    let dir = std::env::temp_dir().join(unique("jobboard-blobs"));
    let mut config = Config {
        signups_open: true,
        ..Config::default()
    };
    config.uploads_per_day = 100;
    tweak(&mut config);
    let state = AppState::new(
        Some(pool.clone()),
        keys,
        Storage::Fs(FsStore::new(dir)),
        test_verifier(),
        config,
    );
    Some(TestApp {
        router: router(state),
        pool,
    })
}

fn app() -> Option<TestApp> {
    app_with(|_| {})
}

struct Res {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn cookies(&self) -> Vec<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().to_owned())
            .collect()
    }
}

/// A browser: keeps cookies, sends the CSRF header on writes.
struct Browser<'a> {
    app: &'a TestApp,
    jar: Vec<(String, String)>,
    bearer: Option<String>,
    csrf: bool,
    /// Each browser has its own address, so the per-IP sign-in limit (whose
    /// counters outlive a test run) only sees one test's sign-ins.
    ip: String,
}

impl<'a> Browser<'a> {
    fn new(app: &'a TestApp) -> Self {
        Browser {
            app,
            jar: Vec::new(),
            bearer: None,
            csrf: true,
            ip: format!("10.{}.{}.{}", rand_octet(), rand_octet(), rand_octet()),
        }
    }

    fn keep(&mut self, res: &Res) {
        for c in res.cookies() {
            let pair = c.split(';').next().unwrap();
            let (k, v) = pair.split_once('=').unwrap();
            self.jar.retain(|(n, _)| n != k);
            if !v.is_empty() && !c.contains("Max-Age=0") {
                self.jar.push((k.to_owned(), v.to_owned()));
            }
        }
    }

    fn cookie(&self, name: &str) -> Option<&str> {
        self.jar
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    async fn send(
        &mut self,
        method: Method,
        path: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> Res {
        self.send_with(method, path, content_type, body, &[]).await
    }

    async fn send_with(
        &mut self,
        method: Method,
        path: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
        extra: &[(&str, &str)],
    ) -> Res {
        let mut req = Request::builder()
            .method(method.clone())
            .uri(path)
            .header(header::HOST, "localhost")
            .header("x-forwarded-for", self.ip.as_str());
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        if self.csrf && method != Method::GET {
            req = req
                .header("x-requested-with", "fetch")
                .header(header::ORIGIN, "http://localhost");
        }
        if !self.jar.is_empty() {
            let cookie = self
                .jar
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; ");
            req = req.header(header::COOKIE, cookie);
        }
        if let Some(t) = &self.bearer {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        if let Some(ct) = content_type {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        let res = self
            .app
            .router
            .clone()
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = to_bytes(res.into_body(), 16 << 20).await.unwrap().to_vec();
        let res = Res {
            status,
            headers,
            body,
        };
        self.keep(&res);
        assert_eq!(
            res.headers
                .get(header::CACHE_CONTROL)
                .and_then(|v| v.to_str().ok()),
            Some("private, no-store"),
            "{path} must never be cached"
        );
        res
    }

    async fn get(&mut self, path: &str) -> Res {
        self.send(Method::GET, path, None, Vec::new()).await
    }

    async fn json(&mut self, method: Method, path: &str, body: Value) -> Res {
        self.send(
            method,
            path,
            Some("application/json"),
            serde_json::to_vec(&body).unwrap(),
        )
        .await
    }

    async fn upload(&mut self, file_name: &str, bytes: &[u8], title: &str, tags: &str) -> Res {
        let boundary = "XboundaryX";
        let mut body = Vec::new();
        let mut text = |name: &str, value: &str| {
            body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").bytes());
        };
        text("title", title);
        text("tags", tags);
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
            )
            .bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend(format!("\r\n--{boundary}--\r\n").bytes());
        self.send(
            Method::POST,
            "/api/me/resumes",
            Some(&format!("multipart/form-data; boundary={boundary}")),
            body,
        )
        .await
    }

    /// Signs in as a new Google account. Returns the `sub`.
    async fn sign_in(&mut self) -> String {
        let sub = unique("sub");
        let res = self.sign_in_as(&sub).await;
        assert_eq!(
            res.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&res.body)
        );
        sub
    }

    async fn sign_in_as(&mut self, sub: &str) -> Res {
        let config = self.get("/api/auth/config").await;
        assert_eq!(config.status, StatusCode::OK);
        let nonce = config.json()["nonce"].as_str().unwrap().to_owned();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let token = sign_google_token(
            &json!({
                "iss": "https://accounts.google.com", "aud": TEST_CLIENT_ID, "sub": sub,
                "email": format!("{sub}@example.com"), "email_verified": true, "name": "Jane Doe",
                "iat": now, "exp": now + 600, "nonce": nonce,
            }),
            TEST_KID,
        );
        self.json(
            Method::POST,
            "/api/auth/google",
            json!({ "credential": token }),
        )
        .await
    }
}

const RESUME: &[&str] = &[
    "Jane Doe",
    "Boston, MA | (617) 555-0100 | jane.doe@example.com | linkedin.com/in/janedoe | github.com/janedoe",
    "EDUCATION",
    "Northeastern University Boston, MA",
    "Master of Science in Computer Science Sep 2024 – May 2026",
    "EXPERIENCE",
    "Software Engineer Intern Jun 2025 – Aug 2025",
    "Acme Corp Boston, MA",
    "- Built a caching layer that cut latency by 40%",
    "SKILLS",
    "Rust, Python, Go, PostgreSQL, Kubernetes",
];

#[tokio::test]
async fn sign_in_sets_cookies_and_me_answers() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    assert!(b.get("/api/auth/me").await.json()["user"].is_null());
    b.sign_in().await;
    assert!(b.cookie("jb_sid").is_some(), "session cookie");
    assert_eq!(
        b.cookie("jb_li"),
        Some("1"),
        "signed-in hint for the web app"
    );
    let me = b.get("/api/auth/me").await.json();
    assert_eq!(me["user"]["name"], "Jane Doe");
    assert!(
        me["user"].get("googleSub").is_none(),
        "the Google id stays server-side"
    );
    assert_eq!(me["recentSignIn"], true);

    let out = b.json(Method::POST, "/api/auth/logout", json!({})).await;
    assert_eq!(out.status, StatusCode::OK);
    assert!(b.cookie("jb_sid").is_none());
    assert!(b.get("/api/auth/me").await.json()["user"].is_null());
}

#[tokio::test]
async fn sign_in_rejects_a_token_from_another_page() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    b.get("/api/auth/config").await;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let token = sign_google_token(
        &json!({"iss": "accounts.google.com", "aud": TEST_CLIENT_ID, "sub": unique("s"), "email": "x@example.com",
                "email_verified": true, "exp": now + 600, "nonce": "someone-elses-nonce"}),
        TEST_KID,
    );
    let res = b
        .json(
            Method::POST,
            "/api/auth/google",
            json!({ "credential": token }),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(b.cookie("jb_sid").is_none());
}

#[tokio::test]
async fn closed_signups_admit_only_the_allowlist() {
    let owner = unique("owner");
    let allow = owner.clone();
    let Some(app) = app_with(|c| {
        c.signups_open = false;
        c.signup_allowlist = vec![allow];
    }) else {
        return;
    };
    let mut stranger = Browser::new(&app);
    let res = stranger.sign_in_as(&unique("stranger")).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let mut me = Browser::new(&app);
    assert_eq!(me.sign_in_as(&owner).await.status, StatusCode::OK);
}

#[tokio::test]
async fn writes_need_the_csrf_header_and_a_same_site_origin() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    b.sign_in().await;
    b.csrf = false;
    let res = b
        .json(
            Method::PUT,
            "/api/me/answers",
            json!({"question": "q", "answer": "a"}),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    b.csrf = true;
    let res = b
        .json(
            Method::PUT,
            "/api/me/answers",
            json!({"question": "Why us?", "answer": "Because."}),
        )
        .await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    // JSON routes refuse other content types.
    let res = b
        .send(
            Method::PUT,
            "/api/me/answers",
            Some("text/plain"),
            b"{}".to_vec(),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
async fn upload_parses_fills_the_profile_and_downloads_safely() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let file = docx_resume(RESUME);

    let res = b
        .upload("Jane Doe – SWE.docx", &file, "", "SWE, Backend, swe")
        .await;
    assert_eq!(
        res.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    let body = res.json();
    let resume = &body["resume"];
    assert_eq!(resume["parseStatus"], "parsed");
    assert_eq!(resume["isDefault"], true, "the first resume is the default");
    assert_eq!(resume["tags"], json!(["SWE", "Backend"]));
    assert_eq!(resume["title"], "Jane Doe – SWE");
    assert!(resume.get("objectKey").is_none());
    assert!(
        !body["imported"].as_array().unwrap().is_empty(),
        "an empty profile is filled"
    );
    let id = resume["id"].as_str().unwrap().to_owned();

    let profile = b.get("/api/me/profile").await.json();
    assert_eq!(profile["profile"]["identity"]["firstName"], "Jane");
    assert_eq!(
        profile["profile"]["contact"]["email"],
        "jane.doe@example.com"
    );
    assert_eq!(
        profile["sources"]["identity.firstName"],
        format!("resume:{id}")
    );
    assert_eq!(profile["version"], 1);

    // Same file again: refused. Not a resume: refused.
    assert_eq!(
        b.upload("again.docx", &file, "", "").await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        b.upload("page.pdf", b"<html>hi</html>", "", "")
            .await
            .status,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );

    let dl = b.get(&format!("/api/me/resumes/{id}/file")).await;
    assert_eq!(dl.status, StatusCode::OK);
    assert_eq!(dl.body, file);
    let cd = dl
        .headers
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cd.starts_with("attachment;"), "{cd}");
    assert_eq!(
        dl.headers.get(header::CONTENT_SECURITY_POLICY).unwrap(),
        "sandbox"
    );

    let shown = b.get(&format!("/api/me/resumes/{id}")).await.json();
    assert_eq!(shown["parsed"]["firstName"], "Jane");

    let list = b.get("/api/me/resumes").await.json();
    assert_eq!(list["resumes"].as_array().unwrap().len(), 1);
    assert_eq!(list["limits"]["uploadsToday"], 1);
}

#[tokio::test]
async fn retitle_retag_default_and_delete() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let one = b
        .upload("a.docx", &docx_resume(&["Jane Doe", "one"]), "General", "")
        .await
        .json()["resume"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let two = b
        .upload(
            "b.docx",
            &docx_resume(&["Jane Doe", "two"]),
            "ML",
            "AI Engineer",
        )
        .await
        .json()["resume"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let res = b.json(Method::PATCH, &format!("/api/me/resumes/{two}"), json!({"title": "  ML  resume ", "tags": ["ML", "ai engineer", "AI Engineer"], "isDefault": true})).await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    assert_eq!(res.json()["resume"]["title"], "ML resume");
    assert_eq!(res.json()["resume"]["tags"], json!(["ML", "ai engineer"]));
    let list = b.get("/api/me/resumes").await.json();
    let defaults: Vec<_> = list["resumes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["isDefault"] == true)
        .collect();
    assert_eq!(defaults.len(), 1);
    assert_eq!(defaults[0]["id"], two.as_str());

    // Deleting the default hands it to the other resume.
    assert_eq!(
        b.send(
            Method::DELETE,
            &format!("/api/me/resumes/{two}"),
            None,
            vec![]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    let list = b.get("/api/me/resumes").await.json();
    assert_eq!(list["resumes"][0]["id"], one.as_str());
    assert_eq!(list["resumes"][0]["isDefault"], true);
    assert_eq!(
        b.get(&format!("/api/me/resumes/{two}/file")).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn another_users_ids_are_not_found() {
    let Some(app) = app() else { return };
    let mut alice = Browser::new(&app);
    alice.sign_in().await;
    let id = alice
        .upload("a.docx", &docx_resume(RESUME), "", "")
        .await
        .json()["resume"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let answer = alice
        .json(
            Method::PUT,
            "/api/me/answers",
            json!({"question": "Why us?", "answer": "secret"}),
        )
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut bob = Browser::new(&app);
    bob.sign_in().await;
    for path in [
        format!("/api/me/resumes/{id}"),
        format!("/api/me/resumes/{id}/file"),
    ] {
        assert_eq!(bob.get(&path).await.status, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        bob.json(
            Method::PATCH,
            &format!("/api/me/resumes/{id}"),
            json!({"title": "mine"})
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        bob.send(
            Method::DELETE,
            &format!("/api/me/resumes/{id}"),
            None,
            vec![]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        bob.send(
            Method::DELETE,
            &format!("/api/me/answers/{answer}"),
            None,
            vec![]
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        bob.json(
            Method::POST,
            &format!("/api/me/profile/import/{id}"),
            json!({})
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
    assert!(
        bob.get("/api/me/answers").await.json()["answers"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        bob.get("/api/me/resumes/not-a-uuid").await.status,
        StatusCode::NOT_FOUND
    );
    // Alice still has hers.
    assert_eq!(
        alice
            .get(&format!("/api/me/resumes/{id}/file"))
            .await
            .status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn profile_edits_are_versioned_and_win_over_resumes() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let mut profile = b.get("/api/me/profile").await.json();
    assert_eq!(profile["version"], 0);
    profile["profile"]["identity"]["firstName"] = json!("Janie");
    profile["profile"]["workAuth"]["requiresSponsorshipFuture"] = json!(true);
    profile["profile"]["unknownKey"] = json!("dropped");
    let saved = b
        .json(
            Method::PUT,
            "/api/me/profile",
            json!({"profile": profile["profile"], "version": 0}),
        )
        .await;
    assert_eq!(
        saved.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&saved.body)
    );
    assert_eq!(saved.json()["version"], 1);
    assert_eq!(saved.json()["sources"]["identity.firstName"], "user");

    // A stale version is refused.
    let stale = b
        .json(
            Method::PUT,
            "/api/me/profile",
            json!({"profile": profile["profile"], "version": 0}),
        )
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    // Bad values are refused with a message.
    let mut bad = saved.json()["profile"].clone();
    bad["contact"]["email"] = json!("not an email");
    let res = b
        .json(
            Method::PUT,
            "/api/me/profile",
            json!({"profile": bad, "version": 1}),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    // Importing a resume keeps the name the user typed, fills the rest.
    let id = b
        .upload("r.docx", &docx_resume(RESUME), "", "")
        .await
        .json()["resume"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let imported = b
        .json(
            Method::POST,
            &format!("/api/me/profile/import/{id}"),
            json!({}),
        )
        .await;
    assert_eq!(
        imported.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&imported.body)
    );
    let p = imported.json();
    assert_eq!(p["profile"]["identity"]["firstName"], "Janie");
    assert_eq!(p["profile"]["identity"]["lastName"], "Doe");
    assert_eq!(p["profile"]["workAuth"]["requiresSponsorshipFuture"], true);
    assert_eq!(p["version"], 2);
}

#[tokio::test]
async fn extension_tokens_reach_only_the_autofill_routes() {
    let Some(app) = app() else { return };
    let mut web = Browser::new(&app);
    web.sign_in().await;
    let id = web
        .upload(
            "ml.docx",
            &docx_resume(RESUME),
            "ML resume",
            "AI Engineer, ML",
        )
        .await
        .json()["resume"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    web.upload(
        "swe.docx",
        &docx_resume(&["Jane Doe", "generalist"]),
        "General SWE",
        "SWE",
    )
    .await;
    let created = web
        .json(Method::POST, "/api/me/tokens", json!({"label": "Laptop"}))
        .await;
    assert_eq!(
        created.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&created.body)
    );
    let token = created.json()["token"].as_str().unwrap().to_owned();
    assert!(token.starts_with("jbt_"));
    let token_id = created.json()["info"]["id"].as_str().unwrap().to_owned();
    assert!(
        web.get("/api/me/tokens").await.json()["tokens"][0]
            .get("token")
            .is_none(),
        "never shown again"
    );

    let mut ext = Browser::new(&app);
    ext.bearer = Some(token.clone());
    ext.csrf = false;
    let profile = ext.get("/api/autofill/profile").await;
    assert_eq!(profile.status, StatusCode::OK);
    let p = profile.json();
    assert_eq!(p["profile"]["identity"]["firstName"], "Jane");
    assert_eq!(p["resumes"].as_array().unwrap().len(), 2);
    for key in [
        "id",
        "title",
        "tags",
        "isDefault",
        "fileName",
        "mimeType",
        "sizeBytes",
    ] {
        assert!(p["resumes"][0].get(key).is_some(), "resume field {key}");
    }

    let ranked = ext
        .get("/api/autofill/resumes?title=Machine%20Learning%20Engineer%2C%20New%20Grad")
        .await
        .json();
    assert_eq!(
        ranked["resumes"][0]["id"],
        id.as_str(),
        "the ML resume ranks first for an ML job"
    );

    let file = ext.get(&format!("/api/autofill/resumes/{id}/file")).await;
    assert_eq!(file.status, StatusCode::OK);

    let saved = ext
        .json(
            Method::POST,
            "/api/autofill/answers",
            json!({"answers": [
                {"question": "How did you hear about us?", "answer": "Job board"},
                {"question": "Why Acme?", "answer": "Caching.", "company": "Acme"},
                {"question": "", "answer": "skipped"}
            ]}),
        )
        .await;
    assert_eq!(
        saved.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&saved.body)
    );
    assert_eq!(saved.json()["saved"], 2);
    let answers = web.get("/api/me/answers").await.json();
    assert_eq!(answers["answers"].as_array().unwrap().len(), 2);

    // A token can't use the cookie routes, and a cookie can't use the token routes.
    assert_eq!(
        ext.get("/api/me/resumes").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        web.get("/api/autofill/profile").await.status,
        StatusCode::UNAUTHORIZED
    );

    assert_eq!(
        web.send(
            Method::DELETE,
            &format!("/api/me/tokens/{token_id}"),
            None,
            vec![]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        ext.get("/api/autofill/profile").await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn sensitive_actions_need_a_recent_sign_in() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    let sub = b.sign_in().await;
    sqlx::query(
        "UPDATE sessions SET created_at = now() - interval '1 hour'
         WHERE user_id = (SELECT id FROM users WHERE google_sub = $1)",
    )
    .bind(&sub)
    .execute(&app.pool)
    .await
    .unwrap();
    for res in [
        b.json(Method::POST, "/api/me/tokens", json!({})).await,
        b.get("/api/me/export").await,
        b.send(Method::DELETE, "/api/me", None, vec![]).await,
    ] {
        assert_eq!(res.status, StatusCode::FORBIDDEN);
        assert_eq!(res.json()["code"], "reauth");
    }
    // Signing in again makes them possible.
    b.sign_in_as(&sub).await;
    assert_eq!(b.get("/api/me/export").await.status, StatusCode::OK);
}

#[tokio::test]
async fn export_then_delete_the_account() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    let sub = b.sign_in().await;
    b.upload("r.docx", &docx_resume(RESUME), "", "SWE").await;
    b.json(
        Method::PUT,
        "/api/me/answers",
        json!({"question": "Why us?", "answer": "Because."}),
    )
    .await;

    let export = b.get("/api/me/export").await;
    assert_eq!(export.status, StatusCode::OK);
    let e = export.json();
    assert_eq!(e["resumes"].as_array().unwrap().len(), 1);
    assert_eq!(e["answers"][0]["answer"], "Because.");
    assert_eq!(e["profile"]["identity"]["firstName"], "Jane");

    let gone = b.send(Method::DELETE, "/api/me", None, vec![]).await;
    assert_eq!(
        gone.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&gone.body)
    );
    assert_eq!(gone.json()["filesDeleted"], 1);
    assert!(b.get("/api/auth/me").await.json()["user"].is_null());
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE google_sub = $1")
        .bind(&sub)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn sign_out_everywhere_ends_every_session() {
    let Some(app) = app() else { return };
    let mut laptop = Browser::new(&app);
    let sub = laptop.sign_in().await;
    let mut phone = Browser::new(&app);
    phone.sign_in_as(&sub).await;
    assert!(!phone.get("/api/auth/me").await.json()["user"].is_null());
    let res = laptop
        .json(Method::POST, "/api/auth/logout-all", json!({}))
        .await;
    assert_eq!(res.json()["sessionsEnded"], 2);
    assert!(phone.get("/api/auth/me").await.json()["user"].is_null());
}

#[tokio::test]
async fn cleanup_needs_the_cron_secret() {
    let Some(app) = app_with(|c| c.cron_secret = Some("a-long-enough-cron-secret".into())) else {
        return;
    };
    let mut b = Browser::new(&app);
    assert_eq!(
        b.get("/api/cron/cleanup").await.status,
        StatusCode::UNAUTHORIZED
    );
    b.bearer = Some("a-long-enough-cron-secret".into());
    let res = b.get("/api/cron/cleanup").await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    assert_eq!(res.json()["ok"], true);
}

#[tokio::test]
async fn sign_ins_are_limited_per_address() {
    let Some(app) = app_with(|c| c.signins_per_ip_per_day = 2) else {
        return;
    };
    let mut b = Browser::new(&app);
    b.ip = format!("fd00::{}", Uuid::new_v4().simple());
    assert_eq!(b.sign_in_as(&unique("a")).await.status, StatusCode::OK);
    assert_eq!(b.sign_in_as(&unique("b")).await.status, StatusCode::OK);
    let third = b.sign_in_as(&unique("c")).await;
    assert_eq!(third.status, StatusCode::TOO_MANY_REQUESTS);
    // Another address is unaffected.
    let mut other = Browser::new(&app);
    other.ip = format!("fd00::{}", Uuid::new_v4().simple());
    assert_eq!(other.sign_in_as(&unique("d")).await.status, StatusCode::OK);
}

/// A stand-in for the Node backend's /admin/ingest: records what it gets.
async fn fake_ingest() -> (
    String,
    std::sync::Arc<std::sync::Mutex<Vec<(Option<String>, Value)>>>,
) {
    use axum::routing::post;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    let app = axum::Router::new().route(
        "/admin/ingest",
        post(
            move |headers: HeaderMap, axum::Json(body): axum::Json<Value>| {
                let log = log.clone();
                async move {
                    let token = headers
                        .get("x-collect-token")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned);
                    let n = body["jobs"].as_array().map_or(0, Vec::len);
                    log.lock().unwrap().push((token, body));
                    axum::Json(json!({ "ok": true, "inserted": n, "updated": 0, "rejected": 0 }))
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/admin/ingest", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

async fn extension_token(app: &TestApp) -> String {
    let mut web = Browser::new(app);
    web.sign_in().await;
    web.json(Method::POST, "/api/me/tokens", json!({}))
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn shared_listings_are_checked_and_forwarded_with_the_owners_token() {
    let (url, seen) = fake_ingest().await;
    let Some(app) = app_with(|c| {
        c.ingest_url = Some(url);
        c.collect_token = Some("owner-collect-token".into());
        c.shares_per_day = 3;
    }) else {
        return;
    };
    let mut ext = Browser::new(&app);
    ext.bearer = Some(extension_token(&app).await);
    ext.csrf = false;

    let res = ext
        .json(
            Method::POST,
            "/api/capture/jobs",
            json!({ "pageUrl": "https://www.tesla.com/careers/search/?country=US", "jobs": [
                { "job_title": "Software Engineer, New Grad", "apply_url": "https://www.tesla.com/careers/search/job/1", "location": "Palo Alto, CA", "secret": "dropped" },
                { "job_title": "Software Engineer", "apply_url": "https://boards.greenhouse.io/tesla/jobs/2", "location": "Austin, TX" },
                { "job_title": "Totally real job", "apply_url": "https://evil.example/phish", "location": "Remote" }
            ]}),
        )
        .await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    assert_eq!(res.json()["sent"], 2);
    assert_eq!(res.json()["refused"], 1);
    {
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0.as_deref(), Some("owner-collect-token"));
        assert_eq!(seen[0].1["source"], "extension");
        assert!(seen[0].1["jobs"][0].get("secret").is_none());
    }

    // Sites whose terms forbid it are refused outright.
    let li = ext
        .json(
            Method::POST,
            "/api/capture/jobs",
            json!({ "pageUrl": "https://www.linkedin.com/jobs/", "jobs": [] }),
        )
        .await;
    assert_eq!(li.status, StatusCode::FORBIDDEN);

    // The daily cap (3 here): 2 used, 2 more is over.
    let over = ext
        .json(
            Method::POST,
            "/api/capture/jobs",
            json!({ "pageUrl": "https://www.tesla.com/careers", "jobs": [
                { "job_title": "A", "apply_url": "https://www.tesla.com/a" },
                { "job_title": "B", "apply_url": "https://www.tesla.com/b" }
            ]}),
        )
        .await;
    assert_eq!(over.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "nothing forwarded past the cap"
    );

    // A cookie session can't share; only an extension token can.
    let mut web = Browser::new(&app);
    web.sign_in().await;
    let res = web
        .json(
            Method::POST,
            "/api/capture/jobs",
            json!({ "pageUrl": "https://www.tesla.com/", "jobs": [] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn sharing_is_unavailable_until_configured() {
    let Some(app) = app() else { return };
    let mut ext = Browser::new(&app);
    ext.bearer = Some(extension_token(&app).await);
    ext.csrf = false;
    let res = ext
        .json(
            Method::POST,
            "/api/capture/jobs",
            json!({ "pageUrl": "https://www.tesla.com/", "jobs": [] }),
        )
        .await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn the_first_sign_in_is_marked_new() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    let sub = unique("first");
    assert_eq!(b.sign_in_as(&sub).await.json()["isNew"], true);
    assert_eq!(b.sign_in_as(&sub).await.json()["isNew"], false);
}

#[tokio::test]
async fn form_schema_needs_a_token_and_skips_unknown_pages() {
    let Some(app) = app() else { return };
    let mut ext = Browser::new(&app);
    ext.csrf = false;
    let path = "/api/autofill/form-schema?url=https%3A%2F%2Fwww.tesla.com%2Fcareers";
    assert_eq!(ext.get(path).await.status, StatusCode::UNAUTHORIZED);
    ext.bearer = Some(extension_token(&app).await);
    // Pages with no public schema answer with no fields and fetch nothing.
    let res = ext.get(path).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json(), json!({ "fields": [] }));
}

/// Multipart body with text parts and an optional PDF `file` part.
fn multipart(parts: &[(&str, &str)], pdf: Option<&[u8]>) -> (String, Vec<u8>) {
    let boundary = "XlatexX";
    let mut body = Vec::new();
    for (name, value) in parts {
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .bytes(),
        );
    }
    if let Some(bytes) = pdf {
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"resume.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
            )
            .bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend(b"\r\n");
    }
    body.extend(format!("--{boundary}--\r\n").bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

const SOURCE_V1: &str = r"\documentclass{article}\begin{document}Jane Doe v1\end{document}";
const SOURCE_V2: &str = r"\documentclass{article}\begin{document}Jane Doe v2\end{document}";

fn pdf_v(version: &str) -> Vec<u8> {
    let mut lines: Vec<&str> = RESUME.to_vec();
    lines.push(version);
    pdf_resume(&lines)
}

async fn new_latex_resume(b: &mut Browser<'_>) -> (String, String) {
    let (ct, body) = multipart(
        &[
            ("title", "LaTeX resume"),
            ("tags", ""),
            ("source", SOURCE_V1),
        ],
        Some(&pdf_v("v1")),
    );
    let res = b
        .send(Method::POST, "/api/me/resumes", Some(&ct), body)
        .await;
    assert_eq!(
        res.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    let r = &res.json()["resume"];
    assert_eq!(r["hasSource"], true);
    assert_eq!(r["sourceStale"], false);
    assert_eq!(
        r["parseStatus"], "parsed",
        "the pdfTeX-style PDF is readable"
    );
    (
        r["id"].as_str().unwrap().to_owned(),
        r["fileSha256"].as_str().unwrap().to_owned(),
    )
}

#[tokio::test]
async fn latex_save_replaces_the_pdf_and_keeps_the_source() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let (id, sha1) = new_latex_resume(&mut b).await;
    let old_key: String = sqlx::query_scalar("SELECT object_key FROM resumes WHERE id = $1::uuid")
        .bind(&id)
        .fetch_one(&app.pool)
        .await
        .unwrap();

    let src = b.get(&format!("/api/me/resumes/{id}/source")).await;
    assert_eq!(src.status, StatusCode::OK);
    assert_eq!(src.json()["source"], SOURCE_V1);
    assert_eq!(src.json()["compiledSha256"], sha1.as_str());

    // Replace with a new PDF and source.
    let path = format!("/api/me/resumes/{id}/latex");
    let (ct, body) = multipart(&[("source", SOURCE_V2)], Some(&pdf_v("v2")));
    let res = b.send(Method::PUT, &path, Some(&ct), body).await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    let r = &res.json()["resume"];
    assert_eq!(r["id"], id.as_str(), "same resume, not a new one");
    assert_eq!(r["title"], "LaTeX resume");
    assert_eq!(r["parseStatus"], "parsed");
    assert_ne!(r["fileSha256"], sha1.as_str());
    let sha2 = r["fileSha256"].as_str().unwrap().to_owned();
    assert_eq!(
        b.get(&format!("/api/me/resumes/{id}/file")).await.body,
        pdf_v("v2")
    );
    assert_eq!(
        b.get(&format!("/api/me/resumes/{id}/source")).await.json()["source"],
        SOURCE_V2
    );
    // The old object was queued by the trigger and deleted straight away.
    let queued: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM object_deletions WHERE object_key = $1")
            .bind(&old_key)
            .fetch_one(&app.pool)
            .await
            .unwrap();
    assert_eq!(queued, 0, "old file deleted");
    let list = b.get("/api/me/resumes").await.json();
    assert_eq!(list["resumes"].as_array().unwrap().len(), 1);
    assert_eq!(list["limits"]["uploadsToday"], 1, "a save isn't an upload");

    // Stale If-Match: refused.
    let (ct, body) = multipart(&[("source", SOURCE_V1)], Some(&pdf_v("v3")));
    let stale = b
        .send_with(Method::PUT, &path, Some(&ct), body, &[("if-match", &sha1)])
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);

    // Same PDF again: only the source is saved, no quota.
    let (ct, body) = multipart(&[("source", SOURCE_V1)], Some(&pdf_v("v2")));
    let same = b
        .send_with(Method::PUT, &path, Some(&ct), body, &[("if-match", &sha2)])
        .await;
    assert_eq!(same.status, StatusCode::OK);
    assert_eq!(same.json()["unchanged"], true);
    assert_eq!(
        b.get(&format!("/api/me/resumes/{id}/source")).await.json()["source"],
        SOURCE_V1
    );

    // Source only: the PDF is now out of date.
    let res = b
        .json(
            Method::PUT,
            &format!("/api/me/resumes/{id}/source"),
            json!({ "source": SOURCE_V2 }),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json()["resume"]["sourceStale"], true);

    // The export carries the source.
    let export = b.get("/api/me/export").await.json();
    assert_eq!(export["resumes"][0]["latexSource"], SOURCE_V2);
}

#[tokio::test]
async fn latex_save_refuses_big_sources_quota_and_other_users() {
    let Some(app) = app_with(|c| c.replaces_per_day = 1) else {
        return;
    };
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let (id, _) = new_latex_resume(&mut b).await;
    assert_eq!(
        b.upload("other.docx", &docx_resume(RESUME), "", "")
            .await
            .status,
        StatusCode::CREATED
    );
    let list = b.get("/api/me/resumes").await.json();
    let other_id = list["resumes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] != id.as_str())
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/me/resumes/{id}/latex");

    let big = "x".repeat(101 * 1024);
    let (ct, body) = multipart(&[("source", &big)], Some(&pdf_v("big")));
    assert_eq!(
        b.send(Method::PUT, &path, Some(&ct), body).await.status,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let (ct, body) = multipart(&[("source", SOURCE_V2)], None);
    assert_eq!(
        b.send(Method::PUT, &path, Some(&ct), body).await.status,
        StatusCode::BAD_REQUEST,
        "no PDF"
    );

    // One save a day here: the second is refused.
    let (ct, body) = multipart(&[("source", SOURCE_V2)], Some(&pdf_v("v2")));
    assert_eq!(
        b.send(Method::PUT, &path, Some(&ct), body).await.status,
        StatusCode::OK
    );
    let (ct, body) = multipart(&[("source", SOURCE_V2)], Some(&pdf_v("v3")));
    assert_eq!(
        b.send(Method::PUT, &path, Some(&ct), body).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );

    // Another user can neither read nor replace it.
    let mut eve = Browser::new(&app);
    eve.sign_in().await;
    assert_eq!(
        eve.get(&format!("/api/me/resumes/{id}/source"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let (ct, body) = multipart(&[("source", SOURCE_V2)], Some(&pdf_v("eve")));
    assert_eq!(
        eve.send(Method::PUT, &path, Some(&ct), body).await.status,
        StatusCode::NOT_FOUND
    );
    // A resume that wasn't made in the editor has no source.
    assert_eq!(
        b.get(&format!("/api/me/resumes/{other_id}/source"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn latex_save_refuses_a_pdf_another_resume_has() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let (id, _) = new_latex_resume(&mut b).await;
    let taken = pdf_v("taken");
    assert_eq!(
        b.upload("taken.pdf", &taken, "", "").await.status,
        StatusCode::CREATED
    );
    let (ct, body) = multipart(&[("source", SOURCE_V2)], Some(&taken));
    let res = b
        .send(
            Method::PUT,
            &format!("/api/me/resumes/{id}/latex"),
            Some(&ct),
            body,
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn each_resume_keeps_its_own_history_for_the_extension() {
    let Some(app) = app() else { return };
    let mut web = Browser::new(&app);
    web.sign_in().await;
    let id = web
        .upload("ml.docx", &docx_resume(RESUME), "ML resume", "ML")
        .await
        .json()["resume"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/me/resumes/{id}/history");
    let job = json!({
        "company": "Acme", "title": "ML Intern", "location": "Boston, MA",
        "startDate": "2025-06", "endDate": "2025-08", "current": false,
        "description": "Built the ranking model."
    });
    let res = web
        .json(
            Method::PUT,
            &path,
            json!({ "education": [], "experience": [job] }),
        )
        .await;
    assert_eq!(
        res.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&res.body)
    );
    let shown = web.get(&format!("/api/me/resumes/{id}")).await.json();
    assert_eq!(shown["parsed"]["experience"][0]["company"], "Acme");
    assert_eq!(shown["parsed"]["education"], json!([]));

    // Same date rules as the profile.
    let bad = json!({ "education": [], "experience": [{ "company": "X", "startDate": "June" }] });
    assert_eq!(
        web.json(Method::PUT, &path, bad).await.status,
        StatusCode::BAD_REQUEST
    );
    // Another user's resume isn't found.
    let mut other = Browser::new(&app);
    other.sign_in_as("someone-else").await;
    let theirs = other
        .json(
            Method::PUT,
            &path,
            json!({ "education": [], "experience": [] }),
        )
        .await;
    assert_eq!(theirs.status, StatusCode::NOT_FOUND);

    let token = web
        .json(Method::POST, "/api/me/tokens", json!({}))
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut ext = Browser::new(&app);
    ext.bearer = Some(token);
    ext.csrf = false;
    let p = ext.get("/api/autofill/profile").await.json();
    assert_eq!(p["history"][&id]["experience"][0]["title"], "ML Intern");
}

/// Every per-user route, called by another user with Alice's ids: nothing is
/// found, nothing changes, and lists show only the caller's own data.
#[tokio::test]
async fn every_per_user_route_refuses_another_users_data() {
    let Some(app) = app() else { return };
    let mut alice = Browser::new(&app);
    alice.sign_in().await;
    let (id, sha) = new_latex_resume(&mut alice).await;
    let answer = alice
        .json(
            Method::PUT,
            "/api/me/answers",
            json!({"question": "Why us?", "answer": "alice-secret-answer"}),
        )
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let created = alice.json(Method::POST, "/api/me/tokens", json!({})).await;
    let alice_token = created.json()["token"].as_str().unwrap().to_owned();
    let alice_token_id = created.json()["info"]["id"].as_str().unwrap().to_owned();
    let alice_profile = alice.get("/api/me/profile").await.json();
    let alert = alice
        .json(
            Method::POST,
            "/api/me/alerts",
            alert_body("alice-secret-alert", "Alice Co", &["email"]),
        )
        .await
        .json()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let job = insert_job(&app.pool, &unique("Alice Co"), "Engineer").await;
    let item = alice
        .json(Method::POST, "/api/me/queue", json!({ "jobId": job }))
        .await
        .json()["item"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut bob = Browser::new(&app);
    bob.sign_in().await;
    let (latex_ct, latex_body) = multipart(&[("source", SOURCE_V2)], Some(&pdf_v("bob")));
    let json_ct = Some("application/json");
    let refused: Vec<(Method, String, Option<&str>, Vec<u8>)> = vec![
        (Method::GET, format!("/api/me/resumes/{id}"), None, vec![]),
        (
            Method::GET,
            format!("/api/me/resumes/{id}/file"),
            None,
            vec![],
        ),
        (
            Method::GET,
            format!("/api/me/resumes/{id}/source"),
            None,
            vec![],
        ),
        (
            Method::PATCH,
            format!("/api/me/resumes/{id}"),
            json_ct,
            br#"{"title":"mine"}"#.to_vec(),
        ),
        (
            Method::PATCH,
            format!("/api/me/resumes/{id}"),
            json_ct,
            br#"{"isDefault":true}"#.to_vec(),
        ),
        (
            Method::POST,
            format!("/api/me/resumes/{id}/reparse"),
            None,
            vec![],
        ),
        (
            Method::PUT,
            format!("/api/me/resumes/{id}/history"),
            json_ct,
            br#"{"education":[],"experience":[]}"#.to_vec(),
        ),
        (
            Method::PUT,
            format!("/api/me/resumes/{id}/source"),
            json_ct,
            br#"{"source":"\\documentclass{article}"}"#.to_vec(),
        ),
        (
            Method::PUT,
            format!("/api/me/resumes/{id}/latex"),
            Some(latex_ct.as_str()),
            latex_body.clone(),
        ),
        (
            Method::POST,
            format!("/api/me/profile/import/{id}"),
            json_ct,
            b"{}".to_vec(),
        ),
        (
            Method::DELETE,
            format!("/api/me/answers/{answer}"),
            None,
            vec![],
        ),
        (
            Method::DELETE,
            format!("/api/me/tokens/{alice_token_id}"),
            None,
            vec![],
        ),
        (
            Method::PUT,
            format!("/api/me/alerts/{alert}"),
            json_ct,
            br#"{"name":"mine"}"#.to_vec(),
        ),
        (
            Method::GET,
            format!("/api/me/alerts/{alert}/preview"),
            None,
            vec![],
        ),
        (
            Method::DELETE,
            format!("/api/me/alerts/{alert}"),
            None,
            vec![],
        ),
        (
            Method::PATCH,
            format!("/api/me/queue/{item}"),
            json_ct,
            br#"{"status":"skipped"}"#.to_vec(),
        ),
        (
            Method::DELETE,
            format!("/api/me/queue/{item}"),
            None,
            vec![],
        ),
        (
            Method::DELETE,
            "/api/me/chat/telegram".to_owned(),
            None,
            vec![],
        ),
        (
            Method::DELETE,
            format!("/api/me/resumes/{id}"),
            None,
            vec![],
        ),
    ];
    for (method, path, ct, body) in refused {
        let res = bob.send(method.clone(), &path, ct, body).await;
        assert_eq!(
            res.status,
            StatusCode::NOT_FOUND,
            "{method} {path}: {}",
            String::from_utf8_lossy(&res.body)
        );
    }

    // Bob's own lists and export hold nothing of Alice's.
    for (path, key) in [
        ("/api/me/resumes", "resumes"),
        ("/api/me/answers", "answers"),
        ("/api/me/tokens", "tokens"),
        ("/api/me/alerts", "alerts"),
        ("/api/me/queue", "items"),
    ] {
        assert_eq!(bob.get(path).await.json()[key], json!([]), "{path}");
    }
    assert_eq!(bob.get("/api/me/profile").await.json()["version"], 0);
    let export = bob.get("/api/me/export").await;
    assert_eq!(export.status, StatusCode::OK);
    let text = String::from_utf8_lossy(&export.body);
    assert!(!text.contains(&id) && !text.contains("alice-secret-answer"));
    assert!(!text.contains("alice-secret-alert") && !text.contains(&item));

    // Bob's extension token sees only Bob.
    let bob_token = bob
        .json(Method::POST, "/api/me/tokens", json!({}))
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut bob_ext = Browser::new(&app);
    bob_ext.bearer = Some(bob_token);
    bob_ext.csrf = false;
    assert_eq!(
        bob_ext
            .get(&format!("/api/autofill/resumes/{id}/file"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let p = bob_ext.get("/api/autofill/profile").await.json();
    assert_eq!(p["resumes"], json!([]));
    assert_eq!(p["answers"], json!([]));
    assert_eq!(p["history"], json!({}));
    assert_eq!(
        bob_ext.get("/api/autofill/resumes?title=x").await.json()["resumes"],
        json!([])
    );
    assert_eq!(
        bob_ext.get("/api/autofill/queue").await.json()["items"],
        json!([])
    );
    // Answers saved with Bob's token land in Bob's bank only.
    let saved = bob_ext
        .json(
            Method::POST,
            "/api/autofill/answers",
            json!({"answers": [{"question": "Why us?", "answer": "bob"}]}),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK);

    // Alice's data is untouched, and her token still works.
    let shown = alice.get(&format!("/api/me/resumes/{id}")).await.json();
    assert_eq!(shown["resume"]["title"], "LaTeX resume");
    assert_eq!(shown["resume"]["fileSha256"], sha.as_str());
    assert_eq!(
        alice
            .get(&format!("/api/me/resumes/{id}/source"))
            .await
            .json()["source"],
        SOURCE_V1
    );
    let answers = alice.get("/api/me/answers").await.json();
    assert_eq!(answers["answers"].as_array().unwrap().len(), 1);
    assert_eq!(answers["answers"][0]["answer"], "alice-secret-answer");
    assert_eq!(alice.get("/api/me/profile").await.json(), alice_profile);
    let alerts = alice.get("/api/me/alerts").await.json();
    assert_eq!(alerts["alerts"][0]["name"], "alice-secret-alert");
    let queue = alice.get("/api/me/queue").await.json();
    assert_eq!(queue["items"][0]["status"], "queued");
    alice
        .send(
            Method::DELETE,
            &format!("/api/me/alerts/{alert}"),
            None,
            vec![],
        )
        .await;
    let mut alice_ext = Browser::new(&app);
    alice_ext.bearer = Some(alice_token);
    alice_ext.csrf = false;
    assert_eq!(
        alice_ext.get("/api/autofill/profile").await.status,
        StatusCode::OK
    );
}

/// Roles: the owner page is for `OWNER_SUBS` only; everyone else, signed in or
/// not, cookie or token, is refused.
#[tokio::test]
async fn owner_routes_deny_everyone_else() {
    let owner_sub = unique("owner");
    let allow = owner_sub.clone();
    let Some(app) = app_with(move |c| c.owner_subs = vec![allow]) else {
        return;
    };
    let mut owner = Browser::new(&app);
    assert_eq!(owner.sign_in_as(&owner_sub).await.status, StatusCode::OK);
    let me = owner.get("/api/auth/me").await.json();
    assert_eq!(me["role"], "owner");
    assert_eq!(me["owner"], true);
    assert_eq!(owner.get("/api/admin/usage").await.status, StatusCode::OK);

    let mut user = Browser::new(&app);
    user.sign_in().await;
    let me = user.get("/api/auth/me").await.json();
    assert_eq!(me["role"], "user");
    assert_eq!(me["owner"], false);
    assert_eq!(
        user.get("/api/admin/usage").await.status,
        StatusCode::NOT_FOUND
    );

    let mut anon = Browser::new(&app);
    assert_eq!(
        anon.get("/api/admin/usage").await.status,
        StatusCode::UNAUTHORIZED
    );
    let token = owner
        .json(Method::POST, "/api/me/tokens", json!({}))
        .await
        .json()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut ext = Browser::new(&app);
    ext.bearer = Some(token);
    ext.csrf = false;
    assert_eq!(
        ext.get("/api/admin/usage").await.status,
        StatusCode::UNAUTHORIZED,
        "an extension token is never the owner"
    );
}

/// Session and nonce cookies: HttpOnly, SameSite=Strict, `__Host-` + Secure in
/// production; signing in again replaces the old session.
#[tokio::test]
async fn session_cookies_are_locked_down_and_rotate() {
    let Some(app) = app_with(|c| c.secure_cookies = true) else {
        return;
    };
    let mut b = Browser::new(&app);
    let config = b.get("/api/auth/config").await;
    let nonce = config
        .cookies()
        .into_iter()
        .find(|c| c.starts_with("__Host-jb_nonce="))
        .expect("nonce cookie");
    for flag in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"] {
        assert!(nonce.contains(flag), "nonce cookie {flag}: {nonce}");
    }
    let sub = unique("sub");
    let res = b.sign_in_as(&sub).await;
    assert_eq!(res.status, StatusCode::OK);
    let sid = res
        .cookies()
        .into_iter()
        .find(|c| c.starts_with("__Host-jb_sid="))
        .expect("session cookie");
    for flag in ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"] {
        assert!(sid.contains(flag), "session cookie {flag}: {sid}");
    }
    assert!(!sid.contains("Domain="), "{sid}");
    let old = b.cookie("__Host-jb_sid").unwrap().to_owned();

    // Signing in again in the same browser ends the old session.
    assert_eq!(b.sign_in_as(&sub).await.status, StatusCode::OK);
    assert_ne!(b.cookie("__Host-jb_sid").unwrap(), old);
    let mut stolen = Browser::new(&app);
    stolen.jar.push(("__Host-jb_sid".into(), old));
    assert!(stolen.get("/api/auth/me").await.json()["user"].is_null());
}

/// The dev sign-in doesn't exist unless the dev binary turns it on.
#[tokio::test]
async fn dev_login_is_off_by_default() {
    let Some(app) = app() else { return };
    let mut b = Browser::new(&app);
    let res = b
        .json(
            Method::POST,
            "/api/auth/dev-login",
            json!({"email": "owner@example.com"}),
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert!(b.cookie("jb_sid").is_none());
    assert_eq!(b.get("/api/auth/config").await.json()["devLogin"], false);
}

// ---------------------------------------------------------------------------
// Job alerts, linked chats and the apply queue (migrations/007_alerts.sql)

/// A job row as the Node collectors write it, first seen now.
async fn insert_job(pool: &sqlx::PgPool, company: &str, title: &str) -> i32 {
    let now = api::alerts::iso(time::OffsetDateTime::now_utc());
    sqlx::query_scalar(
        "INSERT INTO jobs (dedupe_key, source, company_name, job_title, location, apply_url,
                           date_posted, sponsorship, role_type, restriction, is_entry_level,
                           first_seen_at, last_seen_at)
         VALUES ($1, 'test', $2, $3, 'Boston, MA', $4, $5, 'YES', 'SWE', '', 1, $5, $5)
         RETURNING id",
    )
    .bind(unique("job"))
    .bind(company)
    .bind(title)
    .bind(format!("https://jobs.example/{}", unique("apply")))
    .bind(now)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Records every request a fake Resend / Telegram gets: (path, JSON body).
type Outbox = std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>;

async fn fake_outbox() -> (String, Outbox) {
    let got: Outbox = Default::default();
    let seen = got.clone();
    let app = Router::new().fallback(move |uri: axum::http::Uri, body: axum::body::Bytes| {
        let seen = seen.clone();
        async move {
            let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
            seen.lock().unwrap().push((uri.path().to_owned(), json));
            axum::Json(json!({ "id": "fake", "ok": true }))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), got)
}

const CRON: &str = "cron-secret-for-tests-0123456789";
const HOOK: &str = "telegram-hook-secret-0123456789";

fn alert_body(name: &str, company: &str, channels: &[&str]) -> Value {
    json!({
        "name": name,
        "filters": { "role": "SWE", "sponsorship": "YES", "companies": [company] },
        "frequency": "instant",
        "channels": channels,
    })
}

/// A message to the bot from `chat`, through the webhook.
async fn say(hook: &mut Browser<'_>, chat: i64, kind: &str, text: &str, secret: &str) -> Res {
    let body = json!({ "update_id": 1, "message": { "message_id": 1, "text": text,
                       "chat": { "id": chat, "type": kind } } });
    hook.send_with(
        Method::POST,
        "/api/telegram/webhook",
        Some("application/json"),
        serde_json::to_vec(&body).unwrap(),
        &[("x-telegram-bot-api-secret-token", secret)],
    )
    .await
}

/// A tap on an inline button (`callback_data`) in a chat.
async fn tap(hook: &mut Browser<'_>, chat: i64, kind: &str, data: &str) -> Res {
    let body = json!({ "update_id": 2, "callback_query": { "id": "tap-1", "data": data,
                       "from": { "id": chat },
                       "message": { "message_id": 1, "chat": { "id": chat, "type": kind } } } });
    hook.send_with(
        Method::POST,
        "/api/telegram/webhook",
        Some("application/json"),
        serde_json::to_vec(&body).unwrap(),
        &[("x-telegram-bot-api-secret-token", HOOK)],
    )
    .await
}

/// A random private chat id, so parallel tests never share a chat.
fn new_chat_id() -> i64 {
    (Uuid::new_v4().as_u128() % 1_000_000_000_000) as i64 + 1
}

fn reply(res: &Res) -> String {
    res.json()["text"].as_str().unwrap_or("").to_owned()
}

/// Other tests' alerts may be due too: runs batches until `alert` ran.
async fn run_alerts_until(cron: &mut Browser<'_>, pool: &sqlx::PgPool, alert: &str) {
    for _ in 0..50 {
        let res = cron
            .send(Method::POST, "/api/cron/alerts", None, vec![])
            .await;
        assert_eq!(
            res.status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&res.body)
        );
        let ran: bool = sqlx::query_scalar(
            "SELECT last_run_at > now() - interval '5 minutes' FROM job_alerts WHERE id = $1::uuid",
        )
        .bind(alert)
        .fetch_one(pool)
        .await
        .unwrap_or(false);
        if ran {
            return;
        }
    }
    panic!("the alert never ran");
}

#[tokio::test]
async fn alerts_belong_to_their_owner_only() {
    let Some(app) = app() else { return };
    let mut a = Browser::new(&app);
    a.sign_in().await;
    let mut b = Browser::new(&app);
    b.sign_in().await;

    let company = unique("Acme");
    let created = a
        .json(
            Method::POST,
            "/api/me/alerts",
            alert_body("Backend", &company, &["email"]),
        )
        .await;
    assert_eq!(
        created.status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&created.body)
    );
    let id = created.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(created.json()["filters"]["restriction"], "hide");
    let bad = a
        .json(
            Method::POST,
            "/api/me/alerts",
            json!({ "filters": { "level": "senior" } }),
        )
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);

    // B can't see, change, preview or delete A's alert.
    assert_eq!(b.get("/api/me/alerts").await.json()["alerts"], json!([]));
    let path = format!("/api/me/alerts/{id}");
    let stolen = b
        .json(
            Method::PUT,
            &path,
            alert_body("Mine now", "Other", &["email"]),
        )
        .await;
    assert_eq!(stolen.status, StatusCode::NOT_FOUND);
    assert_eq!(
        b.get(&format!("{path}/preview")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.send(Method::DELETE, &path, None, vec![]).await.status,
        StatusCode::NOT_FOUND
    );

    let mine = a.get("/api/me/alerts").await.json();
    assert_eq!(mine["alerts"][0]["name"], "Backend", "untouched by B");
    // The name and filters are stored encrypted.
    let raw: Vec<u8> = sqlx::query_scalar("SELECT spec FROM job_alerts WHERE id = $1::uuid")
        .bind(&id)
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains(&company));

    let job = insert_job(&app.pool, &company, "Backend Engineer").await;
    let preview = a.get(&format!("{path}/preview")).await.json();
    assert_eq!(preview["jobs"][0]["id"], job);

    let edited = a
        .json(
            Method::PUT,
            &path,
            json!({ "name": "Renamed", "frequency": "weekly", "channels": [], "paused": true }),
        )
        .await;
    assert_eq!(edited.status, StatusCode::OK);
    assert_eq!(edited.json()["frequency"], "weekly");
    assert_eq!(
        a.send(Method::DELETE, &path, None, vec![]).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(a.get("/api/me/alerts").await.json()["alerts"], json!([]));
}

#[tokio::test]
async fn the_queue_is_private_and_an_agent_stops_at_prepared() {
    let Some(app) = app() else { return };
    let mut a = Browser::new(&app);
    a.sign_in().await;
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let job = insert_job(&app.pool, &unique("Queue Co"), "Software Engineer").await;

    let added = a
        .json(Method::POST, "/api/me/queue", json!({ "jobId": job }))
        .await;
    assert_eq!(added.status, StatusCode::CREATED);
    let item = added.json()["item"]["id"].as_str().unwrap().to_owned();
    let again = a
        .json(Method::POST, "/api/me/queue", json!({ "jobId": job }))
        .await;
    assert_eq!(again.status, StatusCode::OK, "added once");
    assert_eq!(again.json()["added"], false);

    // B sees none of it and can't change it.
    assert_eq!(b.get("/api/me/queue").await.json()["items"], json!([]));
    let path = format!("/api/me/queue/{item}");
    let res = b
        .json(Method::PATCH, &path, json!({ "status": "skipped" }))
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(
        b.send(Method::DELETE, &path, None, vec![]).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        b.get(&format!("{path}/events")).await.json()["events"],
        json!([])
    );

    // An agent token for A, one for B, and A's extension token.
    let token = |res: Res| res.json()["token"].as_str().unwrap().to_owned();
    let agent_a = token(
        a.json(Method::POST, "/api/me/agent-tokens", json!({}))
            .await,
    );
    let agent_b = token(
        b.json(Method::POST, "/api/me/agent-tokens", json!({}))
            .await,
    );
    let ext_a = token(a.json(Method::POST, "/api/me/tokens", json!({})).await);
    let bearer = |t: &str| {
        let mut x = Browser::new(&app);
        x.bearer = Some(t.to_owned());
        x.csrf = false;
        x
    };
    let mut agent = bearer(&agent_a);
    let mut other_agent = bearer(&agent_b);
    let mut ext = bearer(&ext_a);

    let listed = agent.get("/api/agent/queue").await;
    assert_eq!(listed.status, StatusCode::OK);
    assert_eq!(listed.json()["items"][0]["id"], item.as_str());
    assert_eq!(
        other_agent.get("/api/agent/queue").await.json()["items"],
        json!([])
    );
    let agent_path = format!("/api/agent/queue/{item}");
    let res = other_agent
        .json(Method::POST, &agent_path, json!({ "status": "prepared" }))
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND, "another user's item");

    // Tokens stay in their lane.
    assert_eq!(
        agent.get("/api/autofill/profile").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        ext.get("/api/agent/queue").await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        ext.get("/api/autofill/queue").await.json()["items"][0]["id"],
        item.as_str()
    );

    let prepared = agent
        .json(
            Method::POST,
            &agent_path,
            json!({ "status": "prepared", "note": "Filled the form; cover letter attached." }),
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK);
    assert_eq!(prepared.json()["status"], "prepared");
    assert_eq!(
        prepared.json()["note"],
        "Filled the form; cover letter attached."
    );
    for status in ["submitted_by_you", "skipped"] {
        let res = agent
            .json(Method::POST, &agent_path, json!({ "status": status }))
            .await;
        assert_eq!(
            res.status,
            StatusCode::FORBIDDEN,
            "agent can't set {status}"
        );
    }

    // Only the user submits. After that the agent can't touch it.
    let done = a
        .json(
            Method::PATCH,
            &path,
            json!({ "status": "submitted_by_you" }),
        )
        .await;
    assert_eq!(done.json()["status"], "submitted_by_you");
    let res = agent
        .json(Method::POST, &agent_path, json!({ "status": "prepared" }))
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);

    // Every step is in the log, refusals included.
    let events = a.get(&format!("{path}/events")).await.json()["events"].clone();
    let actions: Vec<String> = events
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            format!(
                "{}:{}",
                e["actor"].as_str().unwrap(),
                e["action"].as_str().unwrap()
            )
        })
        .collect();
    for want in ["you:add", "agent:status", "agent:refused", "you:status"] {
        assert!(actions.contains(&want.to_owned()), "{want} in {actions:?}");
    }
    assert_eq!(
        a.send(Method::DELETE, &path, None, vec![]).await.status,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn the_alert_run_sends_new_jobs_once_and_unsubscribes() {
    let (outbox_url, outbox) = fake_outbox().await;
    let Some(app) = app_with(|c| {
        c.cron_secret = Some(CRON.into());
        c.notify.resend_api_key = Some("re_test".into());
        c.notify.alerts_from = Some("Alerts <alerts@example.com>".into());
        c.notify.resend_base = outbox_url.clone();
        c.notify.telegram_bot_token = Some("123:test".into());
        c.notify.telegram_base = outbox_url.clone();
        c.notify.telegram_webhook_secret = Some(HOOK.into());
        // The test database's counters outlive runs.
        c.notify.emails_per_day = i64::MAX;
        c.notify.emails_per_month = i64::MAX;
    }) else {
        return;
    };
    let mut a = Browser::new(&app);
    let sub = a.sign_in().await;
    let email = format!("{sub}@example.com");

    // Link a Telegram chat so the alert goes there too.
    let code = a
        .json(Method::POST, "/api/me/chat/telegram", json!({}))
        .await;
    let code = code.json()["code"].as_str().unwrap().to_owned();
    let chat_id = new_chat_id();
    let mut hook = Browser::new(&app);
    hook.csrf = false;
    let linked = say(
        &mut hook,
        chat_id,
        "private",
        &format!("/start {code}"),
        HOOK,
    )
    .await;
    assert!(reply(&linked).starts_with("Linked"), "{}", reply(&linked));

    let company = unique("Alertco");
    let created = a
        .json(
            Method::POST,
            "/api/me/alerts",
            alert_body("Backend", &company, &["email", "telegram"]),
        )
        .await;
    let alert = created.json()["id"].as_str().unwrap().to_owned();
    let first = insert_job(&app.pool, &company, "Backend Engineer").await;
    let second = insert_job(&app.pool, &company, "Platform Engineer").await;

    let mut cron = Browser::new(&app);
    cron.csrf = false;
    assert_eq!(
        cron.send(Method::POST, "/api/cron/alerts", None, vec![])
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    cron.bearer = Some(CRON.into());
    run_alerts_until(&mut cron, &app.pool, &alert).await;

    let mine = |outbox: &Outbox| -> Vec<Value> {
        outbox
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, v)| p == "/emails" && v["to"][0] == email.as_str())
            .map(|(_, v)| v.clone())
            .collect()
    };
    let mails = mine(&outbox);
    assert_eq!(mails.len(), 1, "one email");
    let mail = &mails[0];
    assert_eq!(mail["from"], "Alerts <alerts@example.com>");
    assert!(mail["subject"].as_str().unwrap().starts_with("2 new jobs"));
    let html = mail["html"].as_str().unwrap();
    assert!(html.contains("Backend Engineer") && html.contains("Platform Engineer"));
    assert!(html.contains(&format!("/queue?add={first}")));
    assert_eq!(
        mail["headers"]["List-Unsubscribe-Post"],
        "List-Unsubscribe=One-Click"
    );
    let unsub = mail["headers"]["List-Unsubscribe"]
        .as_str()
        .unwrap()
        .trim_matches(['<', '>'])
        .to_owned();
    let chat_key = chat_id.to_string();
    let chats: Vec<Value> = outbox
        .lock()
        .unwrap()
        .iter()
        .filter(|(p, v)| p == "/bot123:test/sendMessage" && v["chat_id"] == chat_key.as_str())
        .map(|(_, v)| v.clone())
        .collect();
    assert_eq!(chats.len(), 1, "one Telegram message");
    assert!(
        chats[0]["text"]
            .as_str()
            .unwrap()
            .contains(&format!("#{second}"))
    );

    // Next run: only the job that's new since.
    sqlx::query(
        "UPDATE job_alerts SET last_run_at = now() - interval '1 hour' WHERE id = $1::uuid",
    )
    .bind(&alert)
    .execute(&app.pool)
    .await
    .unwrap();
    insert_job(&app.pool, &company, "Data Engineer").await;
    run_alerts_until(&mut cron, &app.pool, &alert).await;
    let mails = mine(&outbox);
    assert_eq!(mails.len(), 2);
    let html = mails[1]["html"].as_str().unwrap();
    assert!(
        mails[1]["subject"]
            .as_str()
            .unwrap()
            .starts_with("1 new job:")
    );
    assert!(html.contains("Data Engineer") && !html.contains("Backend Engineer"));

    // The unsubscribe link: GET only asks, a tampered one is refused, POST stops email.
    let path = unsub
        .split_once(".app")
        .map_or(unsub.as_str(), |(_, p)| p)
        .to_owned();
    assert!(path.starts_with("/api/alerts/unsubscribe?t="), "{path}");
    let mut anon = Browser::new(&app);
    anon.csrf = false;
    let page = anon.get(&path).await;
    assert!(String::from_utf8_lossy(&page.body).contains("<form method=\"post\""));
    let mut tampered = path.clone();
    let last = tampered.pop().unwrap();
    tampered.push(if last == '0' { '1' } else { '0' });
    assert_eq!(
        anon.send(Method::POST, &tampered, None, vec![])
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let channels = a.get("/api/me/alerts").await.json()["alerts"][0]["channels"].clone();
    assert_eq!(channels, json!(["email", "telegram"]), "still on");
    let done = anon
        .send(
            Method::POST,
            &path,
            Some("application/x-www-form-urlencoded"),
            b"List-Unsubscribe=One-Click".to_vec(),
        )
        .await;
    assert_eq!(done.status, StatusCode::OK);
    let channels = a.get("/api/me/alerts").await.json()["alerts"][0]["channels"].clone();
    assert_eq!(channels, json!(["telegram"]));

    assert_eq!(
        a.send(
            Method::DELETE,
            &format!("/api/me/alerts/{alert}"),
            None,
            vec![]
        )
        .await
        .status,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn telegram_links_one_account_per_chat_and_answers_commands() {
    let Some(app) = app_with(|c| {
        c.notify.telegram_webhook_secret = Some(HOOK.into());
        c.notify.telegram_bot_username = Some("JobBoardTestBot".into());
    }) else {
        return;
    };
    let mut a = Browser::new(&app);
    a.sign_in().await;
    let mut b = Browser::new(&app);
    b.sign_in().await;
    let company = unique("Chatco");
    a.json(
        Method::POST,
        "/api/me/alerts",
        alert_body("A's alert", &company, &["telegram"]),
    )
    .await;
    b.json(
        Method::POST,
        "/api/me/alerts",
        alert_body("B's alert", "Other", &["email"]),
    )
    .await;

    let mut hook = Browser::new(&app);
    hook.csrf = false;
    let chat_a = new_chat_id();
    let chat_b = new_chat_id();

    let wrong = say(
        &mut hook,
        chat_a,
        "private",
        "/jobs",
        "wrong-secret-0123456789",
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let res = say(&mut hook, chat_a, "private", "/jobs", HOOK).await;
    assert!(reply(&res).contains("isn’t linked"), "{}", reply(&res));

    let code_a = a
        .json(Method::POST, "/api/me/chat/telegram", json!({}))
        .await;
    assert_eq!(code_a.status, StatusCode::CREATED);
    let link = code_a.json()["link"].as_str().unwrap().to_owned();
    assert!(link.starts_with("https://t.me/JobBoardTestBot?start="));
    let code_a = code_a.json()["code"].as_str().unwrap().to_owned();
    // A group chat is ignored, even with a valid code.
    let group = say(
        &mut hook,
        chat_a,
        "group",
        &format!("/start {code_a}"),
        HOOK,
    )
    .await;
    assert_eq!(group.json(), json!({}));
    let lowered = code_a.to_lowercase();
    let res = say(
        &mut hook,
        chat_a,
        "private",
        &format!("/start {lowered}"),
        HOOK,
    )
    .await;
    assert!(reply(&res).starts_with("Linked"), "{}", reply(&res));
    assert_eq!(res.json()["parse_mode"], "HTML");
    assert_eq!(
        res.json()["reply_markup"]["keyboard"][0][0]["text"],
        "🔎 New jobs",
        "linking shows the menu"
    );
    assert_eq!(
        a.get("/api/me/chat").await.json()["telegram"]["linked"],
        true
    );
    let reused = say(
        &mut hook,
        chat_b,
        "private",
        &format!("/start {code_a}"),
        HOOK,
    )
    .await;
    assert!(reply(&reused).contains("didn’t work"), "a code works once");

    let code_b = b
        .json(Method::POST, "/api/me/chat/telegram", json!({}))
        .await;
    let code_b = code_b.json()["code"].as_str().unwrap().to_owned();
    say(
        &mut hook,
        chat_b,
        "private",
        &format!("/link {code_b}"),
        HOOK,
    )
    .await;

    // Each chat sees its own account only.
    let alerts_a = reply(&say(&mut hook, chat_a, "private", "/alerts", HOOK).await);
    assert!(
        alerts_a.contains("A's alert") && !alerts_a.contains("B's alert"),
        "{alerts_a}"
    );
    let alerts_b = reply(&say(&mut hook, chat_b, "private", "/alerts", HOOK).await);
    assert!(
        alerts_b.contains("B's alert") && !alerts_b.contains("A's alert"),
        "{alerts_b}"
    );

    let job = insert_job(&app.pool, &company, "Backend Engineer").await;
    let jobs_res = say(&mut hook, chat_a, "private", "🔎 New jobs", HOOK).await;
    let jobs = reply(&jobs_res);
    assert!(
        jobs.contains(&format!("#{job}")),
        "the menu button lists jobs: {jobs}"
    );
    assert!(jobs.contains("<b>"), "jobs are formatted: {jobs}");
    let buttons = jobs_res.json()["reply_markup"]["inline_keyboard"].to_string();
    assert!(
        buttons.contains(&format!("\"queue:{job}\"")),
        "each job has a Queue button: {buttons}"
    );
    let queued = reply(
        &say(
            &mut hook,
            chat_a,
            "private",
            &format!("/apply #{job}"),
            HOOK,
        )
        .await,
    );
    assert!(queued.starts_with("Added to your apply queue"), "{queued}");
    let items = a.get("/api/me/queue").await.json()["items"].clone();
    assert_eq!(items[0]["jobId"], job);
    assert_eq!(items[0]["addedVia"], "telegram");
    assert_eq!(b.get("/api/me/queue").await.json()["items"], json!([]));

    // Tapping "Queue" does what /apply does, and answers with a notice.
    let tapped = tap(&mut hook, chat_a, "private", &format!("queue:{job}")).await;
    assert_eq!(tapped.json()["method"], "answerCallbackQuery");
    assert_eq!(tapped.json()["callback_query_id"], "tap-1");
    let notice = tapped.json()["text"].as_str().unwrap_or("").to_owned();
    assert!(
        notice.starts_with("Already in your apply queue"),
        "{notice}"
    );
    // A tap from another, unlinked chat adds nothing to anyone's queue.
    let stranger = tap(&mut hook, new_chat_id(), "private", &format!("queue:{job}")).await;
    let notice = stranger.json()["text"].as_str().unwrap_or("").to_owned();
    assert!(notice.contains("isn’t linked"), "{notice}");
    assert_eq!(
        a.get("/api/me/queue").await.json()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let paused = reply(&say(&mut hook, chat_a, "private", "/pause", HOOK).await);
    assert!(paused.starts_with("Paused 1"), "{paused}");
    assert_eq!(
        a.get("/api/me/alerts").await.json()["alerts"][0]["paused"],
        true
    );
    assert_eq!(
        b.get("/api/me/alerts").await.json()["alerts"][0]["paused"],
        false
    );

    assert_eq!(
        a.send(Method::DELETE, "/api/me/chat/telegram", None, vec![])
            .await
            .status,
        StatusCode::NO_CONTENT
    );
    let res = say(&mut hook, chat_a, "private", "/jobs", HOOK).await;
    assert!(reply(&res).contains("isn’t linked"));
    let res = say(&mut hook, chat_b, "private", "/alerts", HOOK).await;
    assert!(reply(&res).contains("B's alert"), "B is still linked");
    let res = say(&mut hook, chat_b, "private", "/unlink", HOOK).await;
    assert!(reply(&res).contains("disconnected"), "{}", reply(&res));
    assert_eq!(
        res.json()["reply_markup"]["remove_keyboard"],
        true,
        "unlinking hides the menu"
    );

    // Leave no due alerts behind for the next run of the alert-run test.
    for who in [&mut a, &mut b] {
        let alerts = who.get("/api/me/alerts").await.json()["alerts"].clone();
        for alert in alerts.as_array().unwrap() {
            let path = format!("/api/me/alerts/{}", alert["id"].as_str().unwrap());
            who.send(Method::DELETE, &path, None, vec![]).await;
        }
    }
}
