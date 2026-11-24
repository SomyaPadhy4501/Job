//! The `/api/*` HTTP surface, shared by the Vercel function (`api/server.rs`)
//! and the local dev server (`src/bin/dev.rs`).
//!
//! - `/api/auth/*`: Google sign-in and browser sessions (cookie).
//! - `/api/me/*`: the signed-in user's resumes, profile, answers, extension
//!   tokens, export and account deletion (cookie + CSRF check).
//! - `/api/autofill/*`: what the extension reads and writes (bearer token).
//! - `/api/cron/*`, `/api/admin/*`: housekeeping, the alert run and the
//!   owner's usage page.
//! - `/api/me/alerts`, `/api/me/chat`, `/api/me/queue`: job alerts, the linked
//!   Telegram chat and the apply queue; `/api/telegram/webhook` takes the
//!   bot's messages, `/api/agent/*` is for an apply agent (bearer token,
//!   scope `agent`).
//!
//! Every response is `Cache-Control: private, no-store`. The Node routes
//! (`/jobs`, `/companies`, …) are edge-cached for 30 s; nothing under `/api`
//! may ever be, because it serves one signed-in user's data.

pub mod account;
pub mod alerts;
pub mod answers;
pub mod auth;
pub mod autofill;
pub mod capture;
pub mod chat;
pub mod error;
pub mod form_schema;
pub mod housekeeping;
pub mod http;
pub mod notify;
pub mod profile;
pub mod queue;
pub mod resumes;
pub mod roles;
pub mod telegram;

use std::sync::Arc;
use std::time::Duration;

use accounts::crypto::{CryptoError, Keyring};
use accounts::google::GoogleVerifier;
use accounts::storage::Storage;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router, middleware};
use serde_json::{Value, json};
use sqlx::postgres::{PgPool, PgPoolOptions};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::error::ApiError;

/// JSON bodies are small; only the upload route takes more.
pub const MAX_JSON_BODY: usize = 256 * 1024;
/// A 4 MB file plus the multipart framing. Vercel refuses bodies over 4.5 MB
/// before the function runs.
pub const MAX_UPLOAD_BODY: usize = accounts::upload::MAX_FILE_BYTES + 64 * 1024;

/// Settings read once at start-up.
#[derive(Debug, Clone)]
pub struct Config {
    /// New accounts may be created. Existing accounts can always sign in.
    pub signups_open: bool,
    /// Google `sub`s that may create an account while sign-ups are closed.
    pub signup_allowlist: Vec<String>,
    /// Google `sub`s that see the usage page.
    pub owner_subs: Vec<String>,
    /// Refuse new accounts past this many users.
    pub max_users: Option<i64>,
    /// `Secure` cookies with the `__Host-` prefix. On whenever `VERCEL` is set.
    pub secure_cookies: bool,
    /// `POST /api/auth/dev-login`: only the local dev binary turns this on, and
    /// never when `VERCEL` is set.
    pub dev_login: bool,
    /// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`.
    pub cron_secret: Option<String>,
    pub max_resumes: i64,
    pub max_user_bytes: i64,
    pub uploads_per_day: i64,
    /// Saves from the LaTeX editor that replace a resume's file, per user per day.
    pub replaces_per_day: i64,
    pub uploads_per_month_global: i64,
    /// Total resume bytes across all users before uploads are refused.
    pub max_storage_bytes: i64,
    pub max_tokens: i64,
    pub signins_per_ip_per_day: i64,
    /// Users may share the listings their extension sees ("Share job
    /// listings I browse"). Needs `ingest_url` and `collect_token` too.
    pub sharing_open: bool,
    /// The Node backend's ingest route, e.g. `https://<site>/admin/ingest`.
    pub ingest_url: Option<String>,
    /// The owner's `COLLECT_TOKEN`; used only server to server.
    pub collect_token: Option<String>,
    pub shares_per_day: i64,
    /// Workday rows a user's extension may send per day, counted apart: the
    /// owner's Workday collection reads ~256 employers every 6 hours.
    pub workday_shares_per_day: i64,
    /// Telegram settings for alerts and chat.
    pub notify: notify::Settings,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            signups_open: false,
            signup_allowlist: Vec::new(),
            owner_subs: Vec::new(),
            max_users: Some(500),
            secure_cookies: false,
            dev_login: false,
            cron_secret: None,
            max_resumes: 10,
            max_user_bytes: 12 * 1024 * 1024,
            uploads_per_day: 5,
            replaces_per_day: 50,
            uploads_per_month_global: 3000,
            max_storage_bytes: 9 * 1024 * 1024 * 1024,
            max_tokens: 5,
            signins_per_ip_per_day: 40,
            sharing_open: true,
            ingest_url: None,
            collect_token: None,
            shares_per_day: 3000,
            workday_shares_per_day: 20_000,
            notify: notify::Settings::default(),
        }
    }
}

fn env_list(name: &str) -> Vec<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn env_int(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn env_flag(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref().map(str::trim),
        Some("1" | "true" | "yes" | "on")
    )
}

impl Config {
    pub fn from_env() -> Self {
        let d = Config::default();
        let on_vercel = std::env::var_os("VERCEL").is_some();
        let max_users = env_int("MAX_USERS", d.max_users.unwrap_or(0));
        Self {
            signups_open: env_flag("SIGNUPS_OPEN"),
            signup_allowlist: env_list("SIGNUP_ALLOWLIST"),
            owner_subs: env_list("OWNER_SUBS"),
            max_users: (max_users > 0).then_some(max_users),
            secure_cookies: on_vercel || env_flag("COOKIE_SECURE"),
            dev_login: false,
            cron_secret: std::env::var("CRON_SECRET").ok().filter(|s| s.len() >= 16),
            max_resumes: env_int("MAX_RESUMES", d.max_resumes),
            max_user_bytes: env_int("MAX_USER_BYTES", d.max_user_bytes),
            uploads_per_day: env_int("UPLOADS_PER_DAY", d.uploads_per_day),
            replaces_per_day: env_int("REPLACES_PER_DAY", d.replaces_per_day),
            uploads_per_month_global: env_int("UPLOADS_PER_MONTH", d.uploads_per_month_global),
            max_storage_bytes: env_int("R2_MAX_BYTES", d.max_storage_bytes),
            max_tokens: d.max_tokens,
            signins_per_ip_per_day: env_int("SIGNINS_PER_IP_PER_DAY", d.signins_per_ip_per_day),
            sharing_open: std::env::var("SHARING_OPEN")
                .map_or(true, |v| !matches!(v.trim(), "0" | "false" | "no" | "off")),
            ingest_url: std::env::var("INGEST_URL")
                .ok()
                .filter(|u| u.starts_with("https://") || u.starts_with("http://")),
            collect_token: std::env::var("COLLECT_TOKEN")
                .ok()
                .filter(|t| !t.trim().is_empty()),
            shares_per_day: env_int("SHARES_PER_USER_PER_DAY", d.shares_per_day),
            workday_shares_per_day: env_int(
                "WORKDAY_SHARES_PER_USER_PER_DAY",
                d.workday_shares_per_day,
            ),
            notify: notify::Settings::from_env(),
        }
    }

    pub fn session_cookie(&self) -> &'static str {
        if self.secure_cookies {
            "__Host-jb_sid"
        } else {
            "jb_sid"
        }
    }

    pub fn nonce_cookie(&self) -> &'static str {
        if self.secure_cookies {
            "__Host-jb_nonce"
        } else {
            "jb_nonce"
        }
    }
}

pub struct Inner {
    /// `None` when `DATABASE_URL` is unset.
    pub db: Option<PgPool>,
    /// `Err` when `DATA_KEYS` is missing or malformed: account data routes 503.
    pub keys: Result<Keyring, CryptoError>,
    pub storage: Storage,
    pub google: GoogleVerifier,
    pub config: Config,
    /// For server-to-server calls (forwarding shared listings to ingest).
    pub http: reqwest::Client,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(
        db: Option<PgPool>,
        keys: Result<Keyring, CryptoError>,
        storage: Storage,
        google: GoogleVerifier,
        config: Config,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        AppState(Arc::new(Inner {
            db,
            keys,
            storage,
            google,
            config,
            http,
        }))
    }

    /// Lazy pool: no connection is opened until a handler needs one, so a cold
    /// start that only serves `/api/health` never waits on Neon.
    pub fn from_env() -> Self {
        Self::from_env_with(Config::from_env())
    }

    pub fn from_env_with(config: Config) -> Self {
        let db = std::env::var("DATABASE_URL").ok().and_then(|url| {
            PgPoolOptions::new()
                .max_connections(5)
                .acquire_timeout(Duration::from_secs(10))
                .connect_lazy(&url)
                .ok()
        });
        let keys = Keyring::from_env();
        if let Err(e) = &keys {
            eprintln!("DATA_KEYS: {e}; account data routes will answer 503");
        }
        let google = GoogleVerifier::new(std::env::var("GOOGLE_CLIENT_ID").ok());
        Self::new(db, keys, Storage::from_env(), google, config)
    }

    pub fn pool(&self) -> Result<&PgPool, ApiError> {
        self.db
            .as_ref()
            .ok_or_else(|| ApiError::Unavailable("The database isn't configured.".into()))
    }

    pub fn keyring(&self) -> Result<&Keyring, ApiError> {
        self.keys.as_ref().map_err(|e| e.clone().into())
    }
}

pub fn router(state: AppState) -> Router {
    // Cookie routes: CSRF check first, then the session lookup.
    let cookie_routes = Router::new()
        .route("/api/auth/config", get(auth::config))
        .route("/api/auth/google", post(auth::google_sign_in))
        .route("/api/auth/dev-login", post(auth::dev_login))
        .route("/api/auth/me", get(auth::me))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/logout-all", post(auth::logout_all))
        .route(
            "/api/me/resumes",
            get(resumes::list)
                .post(resumes::upload)
                .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY)),
        )
        .route(
            "/api/me/resumes/{id}",
            get(resumes::show)
                .patch(resumes::update)
                .delete(resumes::remove),
        )
        .route("/api/me/resumes/{id}/file", get(resumes::file))
        .route("/api/me/resumes/{id}/reparse", post(resumes::reparse))
        .route("/api/me/resumes/{id}/history", put(resumes::put_history))
        .route(
            "/api/me/resumes/{id}/latex",
            put(resumes::save_latex).layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY)),
        )
        .route(
            "/api/me/resumes/{id}/source",
            get(resumes::get_source).put(resumes::put_source),
        )
        .route("/api/me/profile", get(profile::show).put(profile::save))
        .route("/api/me/profile/import/{resume_id}", post(profile::import))
        .route("/api/me/answers", get(answers::list).put(answers::save))
        .route("/api/me/answers/{id}", delete(answers::remove))
        .route(
            "/api/me/tokens",
            get(account::list_tokens).post(account::create_token),
        )
        .route("/api/me/tokens/{id}", delete(account::revoke_token))
        .route("/api/me/export", get(account::export))
        .route("/api/me", delete(account::delete_account))
        .route("/api/admin/usage", get(housekeeping::usage))
        .route("/api/me/alerts", get(alerts::list).post(alerts::create))
        .route(
            "/api/me/alerts/{id}",
            put(alerts::update).delete(alerts::remove),
        )
        .route("/api/me/alerts/{id}/preview", get(alerts::preview))
        .route("/api/me/chat", get(chat::status))
        .route(
            "/api/me/chat/telegram",
            post(chat::new_telegram_code).delete(chat::unlink_telegram),
        )
        .route("/api/me/queue", get(queue::list).post(queue::add_web))
        .route(
            "/api/me/queue/{id}",
            patch(queue::update).delete(queue::remove),
        )
        .route("/api/me/queue/{id}/events", get(queue::events))
        .route("/api/me/agent-tokens", post(queue::create_agent_token))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::session_layer,
        ))
        .layer(middleware::from_fn(http::csrf));

    // Bearer routes: the extension. No cookies are read, so no CSRF check.
    let token_routes = Router::new()
        .route("/api/autofill/profile", get(autofill::profile))
        .route("/api/autofill/resumes", get(autofill::resumes))
        .route(
            "/api/autofill/resumes/{id}/file",
            get(autofill::resume_file),
        )
        .route("/api/autofill/answers", post(autofill::save_answers))
        .route("/api/autofill/form-schema", get(form_schema::form_schema))
        .route("/api/capture/jobs", post(capture::share))
        .route("/api/autofill/queue", get(queue::for_extension))
        .route("/api/agent/queue", get(queue::agent_list))
        .route("/api/agent/queue/{id}", post(queue::agent_set))
        // Telegram and the alert run: their own secrets, no cookies.
        .route("/api/telegram/webhook", post(telegram::webhook))
        .route("/api/cron/alerts", post(alerts::run));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/health/db", get(health_db))
        .route("/api/cron/cleanup", get(housekeeping::cleanup))
        .merge(cookie_routes)
        .merge(token_routes)
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "runtime": "rust",
        "version": env!("CARGO_PKG_VERSION"),
        "database": state.db.is_some(),
        "encryption": state.keys.is_ok(),
        "storage": state.storage.driver(),
        "googleSignIn": state.google.client_id().is_some(),
    }))
}

/// One query against the jobs table: proves the function reaches Neon over TLS.
async fn health_db(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let Some(pool) = &state.db else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "DATABASE_URL is not set" })),
        );
    };
    match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM jobs")
        .fetch_one(pool)
        .await
    {
        Ok(jobs) => (StatusCode::OK, Json(json!({ "ok": true, "jobs": jobs }))),
        Err(err) => {
            eprintln!("health_db: {err}");
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "ok": false, "error": "database unavailable" })),
            )
        }
    }
}

/// The path is echoed so a deploy can confirm what the function receives
/// through the vercel.json rewrite.
async fn not_found(uri: Uri) -> (StatusCode, Json<Value>) {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Not found", "code": "not_found", "path": uri.path() })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt;

    fn bare_state() -> AppState {
        AppState::new(
            None,
            Err(CryptoError::Missing),
            Storage::Disabled("tests".into()),
            GoogleVerifier::new(None),
            Config::default(),
        )
    }

    async fn get_json(path: &str) -> (StatusCode, Option<String>, Value) {
        let res = router(bare_state())
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let cache = res
            .headers()
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap().to_owned());
        let body = to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, cache, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn health_answers_and_is_never_cached() {
        let (status, cache, body) = get_json("/api/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["runtime"], "rust");
        assert_eq!(body["storage"], "disabled");
        assert_eq!(cache.as_deref(), Some("private, no-store"));
    }

    #[tokio::test]
    async fn db_health_without_a_database_is_503() {
        let (status, _, body) = get_json("/api/health/db").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body["ok"], false);
    }

    #[tokio::test]
    async fn unknown_paths_are_json_404s_that_echo_the_path() {
        let (status, cache, body) = get_json("/api/nope").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["path"], "/api/nope");
        assert_eq!(cache.as_deref(), Some("private, no-store"));
    }

    #[tokio::test]
    async fn signed_out_me_is_200_with_no_user() {
        let (status, _, body) = get_json("/api/auth/me").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["user"].is_null());
    }

    #[tokio::test]
    async fn private_routes_need_a_session() {
        let (status, _, body) = get_json("/api/me/resumes").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["code"], "unauthorized");
        let (status, _, _) = get_json("/api/autofill/profile").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
