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
    TEST_CLIENT_ID, TEST_DATA_KEY, TEST_KID, docx_resume, sign_google_token, test_verifier,
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
        let mut req = Request::builder()
            .method(method.clone())
            .uri(path)
            .header(header::HOST, "localhost")
            .header("x-forwarded-for", self.ip.as_str());
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
