//! Google sign-in and browser sessions.
//!
//! - `GET /api/auth/config` hands the page Google's client id and a nonce,
//!   also set in a short-lived HttpOnly cookie. The ID token Google returns
//!   must carry the same nonce, which ties it to this browser.
//! - `POST /api/auth/google {credential}` verifies the ID token and starts a
//!   session: a random token in an HttpOnly cookie (`__Host-jb_sid` in
//!   production), stored only as its SHA-256. 30 days, extended at most once a
//!   day while used, never past 90 days from sign-in.
//! - A non-secret `jb_li=1` cookie tells the web app someone is signed in, so
//!   anonymous visitors never call `/api/auth/me` (and never wake Neon).

use std::convert::Infallible;

use axum::Json;
use axum::extract::{FromRequestParts, OptionalFromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::middleware::Next;
use axum::response::{AppendHeaders, IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use time::{Duration, OffsetDateTime};

use accounts::google::GoogleError;
use accounts::token::{
    hex, looks_like_session_token, new_nonce, new_session_token, sha256, sha256_parts,
};

use crate::AppState;
use crate::error::{ApiError, ApiResult};
use crate::http::{CookieSpec, JsonBody, client_ip, cookie, set_cookie, today, user_agent};
use crate::roles::Role;

pub const SESSION_DAYS: i64 = 30;
pub const ABSOLUTE_DAYS: i64 = 90;
pub const MAX_SESSIONS: i64 = 20;
/// Creating tokens, exporting and deleting the account need a session this new.
pub const REAUTH_MINUTES: i64 = 10;
pub const HINT_COOKIE: &str = "jb_li";

/// The signed-in user, put on the request by [`session_layer`].
#[derive(Clone)]
pub struct Signed {
    pub user: db::User,
    pub session: db::Session,
}

impl Signed {
    pub fn require_recent(&self) -> ApiResult<()> {
        if OffsetDateTime::now_utc() - self.session.created_at > Duration::minutes(REAUTH_MINUTES) {
            return Err(ApiError::Reauth);
        }
        Ok(())
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Signed {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Signed>()
            .cloned()
            .ok_or(ApiError::Unauthorized)
    }
}

impl<S: Send + Sync> OptionalFromRequestParts<S> for Signed {
    type Rejection = Infallible;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Option<Self>, Self::Rejection> {
        Ok(parts.extensions.get::<Signed>().cloned())
    }
}

fn session_cookie(state: &AppState, value: &str, max_age: i64) -> String {
    set_cookie(CookieSpec {
        name: state.config.session_cookie(),
        value,
        max_age,
        http_only: true,
        secure: state.config.secure_cookies,
        strict: true,
    })
}

fn hint_cookie(state: &AppState, on: bool) -> String {
    set_cookie(CookieSpec {
        name: HINT_COOKIE,
        value: if on { "1" } else { "0" },
        max_age: if on { ABSOLUTE_DAYS * 86_400 } else { 0 },
        http_only: false,
        secure: state.config.secure_cookies,
        strict: false,
    })
}

fn nonce_cookie(state: &AppState, value: &str, max_age: i64) -> String {
    set_cookie(CookieSpec {
        name: state.config.nonce_cookie(),
        value,
        max_age,
        http_only: true,
        secure: state.config.secure_cookies,
        strict: true,
    })
}

/// Cookies that sign the browser out.
pub fn clear_cookies(state: &AppState) -> [(header::HeaderName, String); 2] {
    [
        (header::SET_COOKIE, session_cookie(state, "", 0)),
        (header::SET_COOKIE, hint_cookie(state, false)),
    ]
}

/// Looks up the session cookie, if any, and puts [`Signed`] on the request.
/// Extends the session (and its cookie) at most once a day.
pub async fn session_layer(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let name = state.config.session_cookie();
    let token = cookie(req.headers(), name).map(str::to_owned);
    let mut extra_cookies: Vec<String> = Vec::new();

    if let (Some(token), Some(pool)) = (token.as_deref(), state.db.as_ref()) {
        if !looks_like_session_token(token) {
            extra_cookies.extend(clear_cookies(&state).map(|(_, v)| v));
        } else {
            let hash = sha256(token.as_bytes());
            match db::session_user(pool, &hash).await {
                Ok(Some((session, user))) => {
                    let now = OffsetDateTime::now_utc();
                    if now - session.last_seen_at > Duration::days(1) {
                        let expires =
                            (now + Duration::days(SESSION_DAYS)).min(session.absolute_expires_at);
                        if db::touch_session(pool, &hash, expires).await.is_ok() {
                            extra_cookies.push(session_cookie(
                                &state,
                                token,
                                (expires - now).whole_seconds(),
                            ));
                        }
                    }
                    req.extensions_mut().insert(Signed { user, session });
                }
                // Expired or unknown: drop the cookies so the app stops asking.
                Ok(None) => extra_cookies.extend(clear_cookies(&state).map(|(_, v)| v)),
                Err(e) => return ApiError::from(e).into_response(),
            }
        }
    }

    let mut res = next.run(req).await;
    // A handler that set the session cookie itself (sign-in, sign-out) wins.
    let handler_set = res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .any(|v| v.to_str().is_ok_and(|v| v.starts_with(&format!("{name}="))));
    if !handler_set {
        for c in extra_cookies {
            if let Ok(v) = HeaderValue::from_str(&c) {
                res.headers_mut().append(header::SET_COOKIE, v);
            }
        }
    }
    res
}

/// Counts one use of `bucket` today and refuses past `max`.
pub async fn rate_limit(
    state: &AppState,
    subject: &str,
    bucket: &str,
    max: i64,
    message: &str,
) -> ApiResult<()> {
    let n = db::bump_counter(state.pool()?, subject, bucket, &today(), 1).await?;
    if n > max {
        return Err(ApiError::TooMany(message.into()));
    }
    Ok(())
}

fn ip_subject(state: &AppState, headers: &HeaderMap) -> String {
    let ip = client_ip(headers);
    let salt = state
        .keys
        .as_ref()
        .map(|k| k.derive("ip-subject"))
        .unwrap_or([0; 32]);
    format!(
        "ip:{}",
        hex(&sha256_parts(&[b"ip/v1", &salt, ip.as_bytes()])[..16])
    )
}

pub async fn config(State(state): State<AppState>) -> Response {
    let nonce = new_nonce();
    let body = Json(json!({
        "clientId": state.google.client_id(),
        "nonce": nonce,
        "signupsOpen": state.config.signups_open,
        "devLogin": state.config.dev_login,
    }));
    (
        [(header::SET_COOKIE, nonce_cookie(&state, &nonce, 600))],
        body,
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct GoogleBody {
    credential: String,
}

fn google_error(e: GoogleError) -> ApiError {
    match e {
        GoogleError::NotConfigured => {
            ApiError::Unavailable("Google sign-in isn't configured on this server.".into())
        }
        GoogleError::KeysUnavailable(why) => {
            eprintln!("google keys: {why}");
            ApiError::Unavailable("Google sign-in is unavailable. Try again shortly.".into())
        }
        GoogleError::EmailUnverified => {
            ApiError::Forbidden("Your Google account's email isn't verified.".into())
        }
        GoogleError::NonceMismatch => {
            ApiError::bad("The sign-in expired. Reload the page and try again.")
        }
        GoogleError::Invalid(_) => ApiError::Forbidden("Google sign-in failed. Try again.".into()),
    }
}

pub async fn google_sign_in(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<GoogleBody>,
) -> ApiResult<Response> {
    let pool = state.pool()?;
    let subject = ip_subject(&state, &headers);
    rate_limit(
        &state,
        &subject,
        "signin",
        state.config.signins_per_ip_per_day,
        "Too many sign-in attempts today.",
    )
    .await?;

    let nonce = cookie(&headers, state.config.nonce_cookie()).unwrap_or("");
    let id = state
        .google
        .verify(body.credential.trim(), nonce)
        .await
        .map_err(google_error)?;

    let existing = db::user_by_sub(pool, &id.sub).await?;
    let is_new = existing.is_none();
    match existing {
        Some(u) if u.disabled_at.is_some() => {
            return Err(ApiError::Forbidden("This account is disabled.".into()));
        }
        Some(_) => {}
        None => {
            let allowed = state.config.signups_open
                || state.config.signup_allowlist.iter().any(|s| s == &id.sub);
            if !allowed {
                return Err(ApiError::Forbidden("Sign-ups aren't open yet.".into()));
            }
            if let Some(max) = state.config.max_users
                && db::count_users(pool).await? >= max
            {
                return Err(ApiError::Forbidden("Sign-ups are full for now.".into()));
            }
        }
    }
    let name = accounts::truncate_chars(&accounts::clean_line(&id.name), 100).to_owned();
    let avatar = if id.picture.starts_with("https://") && id.picture.len() < 500 {
        id.picture.as_str()
    } else {
        ""
    };
    let user = db::upsert_user(pool, &id.sub, &id.email, &name, avatar).await?;
    start_session(&state, &headers, user, "signin", is_new).await
}

#[derive(Deserialize)]
pub struct DevLoginBody {
    email: String,
    #[serde(default)]
    name: String,
}

/// Local sign-in without Google. Only the dev binary turns it on, and it is
/// refused on Vercel whatever the config says.
pub async fn dev_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<DevLoginBody>,
) -> ApiResult<Response> {
    if !state.config.dev_login || std::env::var_os("VERCEL").is_some() {
        return Err(ApiError::NotFound);
    }
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 200 {
        return Err(ApiError::bad("Enter an email address."));
    }
    let name = if body.name.trim().is_empty() {
        email.split('@').next().unwrap_or("").to_owned()
    } else {
        body.name
    };
    let is_new = db::user_by_sub(state.pool()?, &format!("dev:{email}"))
        .await?
        .is_none();
    let user = db::upsert_user(
        state.pool()?,
        &format!("dev:{email}"),
        &email,
        &accounts::clean_line(&name),
        "",
    )
    .await?;
    start_session(&state, &headers, user, "signin_dev", is_new).await
}

async fn start_session(
    state: &AppState,
    headers: &HeaderMap,
    user: db::User,
    kind: &str,
    is_new: bool,
) -> ApiResult<Response> {
    let pool = state.pool()?;
    // Rotate: the old session, if any, ends here.
    if let Some(old) = cookie(headers, state.config.session_cookie()) {
        db::delete_session(pool, &sha256(old.as_bytes())).await?;
    }
    let token = new_session_token();
    let now = OffsetDateTime::now_utc();
    let expires = now + Duration::days(SESSION_DAYS);
    let absolute = now + Duration::days(ABSOLUTE_DAYS);
    db::create_session(
        pool,
        &sha256(token.as_bytes()),
        user.id,
        expires,
        absolute,
        &user_agent(headers),
    )
    .await?;
    db::trim_sessions(pool, user.id, MAX_SESSIONS).await?;
    db::audit(pool, Some(user.id), kind).await?;

    let role = Role::of(&state.config, &user);
    let cookies = [
        (
            header::SET_COOKIE,
            session_cookie(state, &token, SESSION_DAYS * 86_400),
        ),
        (header::SET_COOKIE, hint_cookie(state, true)),
        (header::SET_COOKIE, nonce_cookie(state, "", 0)),
    ];
    Ok((
        AppendHeaders(cookies),
        Json(json!({
            "user": user,
            "role": role,
            "owner": role == Role::Owner,
            "isNew": is_new,
        })),
    )
        .into_response())
}

pub async fn me(State(state): State<AppState>, signed: Option<Signed>) -> Json<serde_json::Value> {
    match signed {
        Some(s) => {
            let role = Role::of(&state.config, &s.user);
            let reauth_until = s.session.created_at + Duration::minutes(REAUTH_MINUTES);
            Json(json!({
                "user": s.user,
                "role": role,
                "owner": role == Role::Owner,
                "recentSignIn": OffsetDateTime::now_utc() < reauth_until,
            }))
        }
        None => Json(json!({ "user": null })),
    }
}

pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
    signed: Option<Signed>,
) -> ApiResult<Response> {
    if let (Some(token), Ok(pool)) = (
        cookie(&headers, state.config.session_cookie()),
        state.pool(),
    ) {
        db::delete_session(pool, &sha256(token.as_bytes())).await?;
        if let Some(s) = &signed {
            db::audit(pool, Some(s.user.id), "signout").await?;
        }
    }
    Ok((
        AppendHeaders(clear_cookies(&state)),
        Json(json!({ "ok": true })),
    )
        .into_response())
}

pub async fn logout_all(State(state): State<AppState>, signed: Signed) -> ApiResult<Response> {
    let pool = state.pool()?;
    let ended = db::delete_user_sessions(pool, signed.user.id).await?;
    db::audit(pool, Some(signed.user.id), "signout_all").await?;
    Ok((
        AppendHeaders(clear_cookies(&state)),
        Json(json!({ "ok": true, "sessionsEnded": ended })),
    )
        .into_response())
}
