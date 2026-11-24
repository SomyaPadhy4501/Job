//! Connectors: outside accounts a user links to theirs. Gmail today.
//!
//! Connecting (Alerts & Connectors -> Connect Gmail), OAuth 2.0
//! authorization code with PKCE plus OpenID Connect (`accounts::gmail`):
//! - `POST /api/me/connectors/gmail/start` (session + CSRF) makes the PKCE
//!   verifier, `state` and `nonce`, seals them with the user's id in an
//!   AES-GCM cookie (`__Host-jb_gmail`, HttpOnly, SameSite=Lax, 10 minutes)
//!   and returns Google's consent URL. Nothing is written to the database.
//! - `GET /api/connectors/gmail/callback` is where Google sends the browser.
//!   The session cookie is SameSite=Strict, so it isn't sent on that
//!   cross-site redirect; the sealed cookie is what ties the callback to the
//!   browser and account that started it. `state` must match it (constant
//!   time), the code is traded with the verifier and the client secret, the
//!   ID token must carry the nonce and this client as audience, and the grant
//!   must include `gmail.readonly`. The cookie is cleared whatever happens,
//!   and the browser goes back to Settings with only a result word.
//! - `DELETE /api/me/connectors/gmail` revokes the grant at Google and
//!   deletes it.
//!
//! Using it (the extension, bearer token): `POST /api/autofill/gmail/code`
//! and `/verify-link` read only this site's mail from the last 15 minutes and
//! answer one code or one Workday verify link. The refresh token never leaves
//! the server; access tokens are cached encrypted until a minute before they
//! expire.

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use accounts::crypto::Field;
use accounts::gmail::{
    self, CodeShape, GmailClient, GmailError, MAX_AGE_MINUTES, Message, Pkce, SCOPE_GMAIL, Site,
};
use accounts::google::GoogleError;
use accounts::token::{ct_eq, new_nonce};

use crate::AppState;
use crate::auth::{Signed, rate_limit};
use crate::autofill::TokenUser;
use crate::error::{ApiError, ApiResult};
use crate::http::{CookieSpec, JsonBody, cookie, set_cookie};

pub const FLOW_SECONDS: i64 = 600;
/// Connect attempts per user per day.
pub const STARTS_PER_DAY: i64 = 20;
/// Gmail lookups per user per day. The extension asks every 5 s for up to
/// 3 minutes while a code box is open: 36 per code.
pub const READS_PER_DAY: i64 = 600;
/// Message ids the extension may say it already used.
pub const MAX_SKIP: usize = 50;
const CONNECTORS_PAGE: &str = "/alerts";

const NOT_CONNECTED: &str = "Connect Gmail in Alerts & Connectors on the job board to fill codes.";
const RECONNECT: &str = "Gmail access was removed. Reconnect it in Alerts & Connectors.";

/// A connect in progress, sealed in the flow cookie.
#[derive(Serialize, Deserialize)]
struct Flow {
    state: String,
    verifier: String,
    nonce: String,
    /// Unix seconds.
    exp: i64,
}

/// The lasting part of a connection (encrypted `grant_data`).
#[derive(Serialize, Deserialize)]
struct Grant {
    sub: String,
    email: String,
    refresh_token: String,
}

/// The cached access token (encrypted `access_data`).
#[derive(Serialize, Deserialize)]
struct Access {
    token: String,
    /// Unix seconds.
    exp: i64,
}

fn flow_cookie_name(state: &AppState) -> &'static str {
    if state.config.secure_cookies {
        "__Host-jb_gmail"
    } else {
        "jb_gmail"
    }
}

fn flow_cookie(state: &AppState, value: &str, max_age: i64) -> String {
    set_cookie(CookieSpec {
        name: flow_cookie_name(state),
        value,
        max_age,
        http_only: true,
        secure: state.config.secure_cookies,
        // Lax: sent on Google's top-level redirect back, never on a
        // cross-site subrequest or form post.
        strict: false,
    })
}

fn client(state: &AppState) -> ApiResult<&GmailClient> {
    state
        .gmail
        .as_ref()
        .ok_or_else(|| ApiError::Unavailable("Gmail isn't set up on this server yet.".into()))
}

fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn gmail_error(e: GmailError) -> ApiError {
    match e {
        GmailError::Revoked | GmailError::Unauthorized => ApiError::Conflict(RECONNECT.into()),
        GmailError::Unavailable(why) => {
            eprintln!("gmail: unavailable: {why}");
            ApiError::Unavailable("Couldn't reach Gmail. Try again shortly.".into())
        }
        GmailError::Refused(why) => {
            eprintln!("gmail: refused: {why}");
            ApiError::Unavailable(
                "Gmail refused the request. Reconnect it in Alerts & Connectors.".into(),
            )
        }
        GmailError::BadResponse => {
            eprintln!("gmail: bad response");
            ApiError::Unavailable("Gmail gave an unexpected answer. Try again shortly.".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Alerts & Connectors (session)

/// `GET /api/me/connectors`
pub async fn list(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let available = state.gmail.is_some();
    let row = match state.db.as_ref() {
        Some(pool) if available => db::connectors::gmail_connection(pool, signed.user.id).await?,
        _ => None,
    };
    let gmail = match row {
        Some(row) => {
            let grant: Grant = state.keyring()?.decrypt_json(
                Field::GmailGrant,
                &signed.user.id,
                &row.grant_data,
            )?;
            json!({
                "available": true,
                "connected": true,
                "email": grant.email,
                "scopes": row.scopes.split_whitespace().collect::<Vec<_>>(),
                "connectedAt": rfc3339(row.created_at),
                "lastUsedAt": row.last_used_at.map(rfc3339),
            })
        }
        None => json!({ "available": available, "connected": false }),
    };
    Ok(Json(json!({ "gmail": gmail })))
}

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// `POST /api/me/connectors/gmail/start` -> `{ url }`, Google's consent page.
pub async fn gmail_start(State(state): State<AppState>, signed: Signed) -> ApiResult<Response> {
    let gmail = client(&state)?;
    let keys = state.keyring()?;
    rate_limit(
        &state,
        &signed.user.id.to_string(),
        "gmail_connect",
        STARTS_PER_DAY,
        "Too many Gmail connect attempts today.",
    )
    .await?;
    let pkce = Pkce::new();
    let flow = Flow {
        state: new_nonce(),
        verifier: pkce.verifier,
        nonce: new_nonce(),
        exp: now() + FLOW_SECONDS,
    };
    let url = gmail.authorize_url(
        &flow.state,
        &flow.nonce,
        &pkce.challenge,
        Some(&signed.user.email),
    );
    let sealed = keys.encrypt_json(Field::GmailFlow, &signed.user.id, &flow);
    let value = format!("{}.{}", signed.user.id, URL_SAFE_NO_PAD.encode(sealed));
    Ok((
        [(
            header::SET_COOKIE,
            flow_cookie(&state, &value, FLOW_SECONDS),
        )],
        Json(json!({ "url": url })),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// `GET /api/connectors/gmail/callback`: Google's redirect back. Always ends
/// in a redirect to Settings with `?gmail=<result>`.
pub async fn gmail_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let result = match finish(&state, &headers, &q).await {
        Ok(()) => "connected",
        Err(word) => word,
    };
    (
        StatusCode::SEE_OTHER,
        [
            (
                header::LOCATION,
                format!("{CONNECTORS_PAGE}?gmail={result}#connectors"),
            ),
            (header::SET_COOKIE, flow_cookie(&state, "", 0)),
            // The callback URL holds the code: never pass it on as a referrer.
            (header::REFERRER_POLICY, "no-referrer".to_owned()),
        ],
    )
        .into_response()
}

/// The callback's checks, in order. The error is the word Settings shows.
async fn finish(
    state: &AppState,
    headers: &HeaderMap,
    q: &CallbackQuery,
) -> Result<(), &'static str> {
    let (Ok(gmail), Ok(keys), Ok(pool)) = (client(state), state.keyring(), state.pool()) else {
        return Err("unavailable");
    };
    // 1. The sealed cookie: this browser started a connect, for this user.
    let raw = cookie(headers, flow_cookie_name(state)).ok_or("expired")?;
    let (user, sealed) = raw.split_once('.').ok_or("expired")?;
    let user_id = Uuid::parse_str(user).map_err(|_| "expired")?;
    let sealed = URL_SAFE_NO_PAD.decode(sealed).map_err(|_| "expired")?;
    // The user id is bound into the seal: a swapped id won't decrypt.
    let flow: Flow = keys
        .decrypt_json(Field::GmailFlow, &user_id, &sealed)
        .map_err(|_| "expired")?;
    if flow.exp < now() {
        return Err("expired");
    }
    // 2. `state` matches: the redirect answers this browser's own request.
    let returned = q.state.as_deref().unwrap_or("");
    if returned.is_empty() || !ct_eq(returned.as_bytes(), flow.state.as_bytes()) {
        return Err("state");
    }
    if let Some(err) = q.error.as_deref() {
        return Err(if err == "access_denied" {
            "denied"
        } else {
            "error"
        });
    }
    let code = q
        .code
        .as_deref()
        .filter(|c| !c.is_empty() && c.len() <= 2048)
        .ok_or("error")?;
    // 3. Trade the code (with the verifier and the secret).
    let grant = gmail.exchange(code, &flow.verifier).await.map_err(|e| {
        eprintln!("gmail connect: exchange failed: {e}");
        "error"
    })?;
    // 4. The ID token: Google's signature, this client, this flow's nonce.
    let id_token = grant.id_token.as_deref().ok_or("error")?;
    let identity = state
        .gmail_ids
        .verify(id_token, &flow.nonce)
        .await
        .map_err(|e| {
            eprintln!(
                "gmail connect: id token: {}",
                match e {
                    GoogleError::NonceMismatch => "nonce mismatch".to_owned(),
                    other => other.to_string(),
                }
            );
            "error"
        })?;
    // 5. Only a grant that can read Gmail is worth keeping.
    let revoke_new = |token: String| {
        let gmail = gmail.clone();
        async move { gmail.revoke(&token).await.ok() }
    };
    if !grant.has_scope(SCOPE_GMAIL) {
        revoke_new(grant.access_token.clone()).await;
        return Err("scope");
    }
    let Some(refresh_token) = grant.refresh_token.clone() else {
        revoke_new(grant.access_token.clone()).await;
        return Err("error");
    };
    // The account must still exist (it may have been deleted meanwhile).
    match db::user_by_id(pool, user_id).await {
        Ok(Some(u)) if u.disabled_at.is_none() => {}
        _ => {
            revoke_new(refresh_token).await;
            return Err("error");
        }
    }
    let previous = db::connectors::gmail_connection(pool, user_id)
        .await
        .ok()
        .flatten()
        .and_then(|row| {
            keys.decrypt_json::<Grant>(Field::GmailGrant, &user_id, &row.grant_data)
                .ok()
        });
    let stored = Grant {
        sub: identity.sub,
        email: identity.email,
        refresh_token,
    };
    let access = Access {
        token: grant.access_token.clone(),
        exp: now() + grant.expires_in.clamp(60, 3600) - 60,
    };
    let scopes: Vec<&str> = grant.scope.split_whitespace().collect();
    db::connectors::put_gmail_connection(
        pool,
        user_id,
        &keys.encrypt_json(Field::GmailGrant, &user_id, &stored),
        &keys.encrypt_json(Field::GmailAccess, &user_id, &access),
        &scopes.join(" "),
    )
    .await
    .map_err(|_| "unavailable")?;
    // A reconnect replaces the old grant; revoke it unless Google reused it.
    if let Some(old) = previous
        && old.refresh_token != stored.refresh_token
    {
        gmail.revoke(&old.refresh_token).await.ok();
    }
    db::audit(pool, Some(user_id), "gmail_connect").await.ok();
    Ok(())
}

/// `DELETE /api/me/connectors/gmail`
pub async fn gmail_disconnect(
    State(state): State<AppState>,
    signed: Signed,
) -> ApiResult<Json<Value>> {
    let pool = state.pool()?;
    let user_id = signed.user.id;
    if let Some(row) = db::connectors::delete_gmail_connection(pool, user_id).await? {
        revoke_row(&state, user_id, &row).await;
        db::audit(pool, Some(user_id), "gmail_disconnect").await?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// Revokes a deleted connection's grant at Google, best effort (deleting it
/// here already cut off this site's access).
pub async fn revoke_row(state: &AppState, user_id: Uuid, row: &db::connectors::GmailConnection) {
    let (Some(gmail), Ok(keys)) = (state.gmail.as_ref(), state.keyring()) else {
        return;
    };
    if let Ok(grant) = keys.decrypt_json::<Grant>(Field::GmailGrant, &user_id, &row.grant_data)
        && let Err(e) = gmail.revoke(&grant.refresh_token).await
    {
        eprintln!("gmail: revoke failed: {e}");
    }
}

/// For the account export: which Gmail account is connected, never tokens.
pub async fn export_json(state: &AppState, user_id: Uuid) -> ApiResult<Value> {
    let Some(pool) = state.db.as_ref() else {
        return Ok(Value::Null);
    };
    Ok(
        match db::connectors::gmail_connection(pool, user_id).await {
            Ok(Some(row)) => {
                let grant: Grant =
                    state
                        .keyring()?
                        .decrypt_json(Field::GmailGrant, &user_id, &row.grant_data)?;
                json!({ "email": grant.email, "scopes": row.scopes, "connectedAt": rfc3339(row.created_at) })
            }
            // Not connected, or the table isn't there yet.
            _ => Value::Null,
        },
    )
}

// ---------------------------------------------------------------------------
// The extension (bearer token)

/// A usable access token, refreshed when the cached one is about to expire.
/// A revoked grant is deleted, so Settings shows it as not connected.
async fn access_token(state: &AppState, user_id: Uuid, force: bool) -> ApiResult<String> {
    let gmail = client(state)?;
    let keys = state.keyring()?;
    let pool = state.pool()?;
    let row = db::connectors::gmail_connection(pool, user_id)
        .await?
        .ok_or_else(|| ApiError::Conflict(NOT_CONNECTED.into()))?;
    if !force
        && let Some(data) = &row.access_data
        && let Ok(access) = keys.decrypt_json::<Access>(Field::GmailAccess, &user_id, data)
        && access.exp > now()
    {
        db::connectors::touch_gmail(pool, user_id).await.ok();
        return Ok(access.token);
    }
    let mut grant: Grant = keys.decrypt_json(Field::GmailGrant, &user_id, &row.grant_data)?;
    let fresh = match gmail.refresh(&grant.refresh_token).await {
        Ok(fresh) => fresh,
        Err(GmailError::Revoked) => {
            db::connectors::delete_gmail_connection(pool, user_id).await?;
            db::audit(pool, Some(user_id), "gmail_revoked").await.ok();
            return Err(ApiError::Conflict(RECONNECT.into()));
        }
        Err(e) => return Err(gmail_error(e)),
    };
    let rotated = fresh
        .refresh_token
        .clone()
        .filter(|t| *t != grant.refresh_token);
    let grant_data = rotated.map(|t| {
        grant.refresh_token = t;
        keys.encrypt_json(Field::GmailGrant, &user_id, &grant)
    });
    let access = Access {
        token: fresh.access_token,
        exp: now() + fresh.expires_in.clamp(60, 3600) - 60,
    };
    db::connectors::set_gmail_access(
        pool,
        user_id,
        &keys.encrypt_json(Field::GmailAccess, &user_id, &access),
        grant_data.as_deref(),
    )
    .await?;
    Ok(access.token)
}

/// This site's unused mail from the last 15 minutes, newest first. Workday
/// mail only from this company (`<tenant>@myworkday.com`).
/// Which company's mail: the Workday tenant, or the Greenhouse board slug
/// and the company name on the page.
struct For<'a> {
    tenant: &'a str,
    company: &'a str,
}

async fn recent(
    state: &AppState,
    user_id: Uuid,
    site: Site,
    who: For<'_>,
    skip: &[String],
) -> ApiResult<Vec<Message>> {
    let gmail = client(state)?;
    let mut access = access_token(state, user_id, false).await?;
    let query = site.query(now() - MAX_AGE_MINUTES * 60);
    let ids = match gmail.search(&access, &query).await {
        Err(GmailError::Unauthorized) => {
            access = access_token(state, user_id, true).await?;
            gmail.search(&access, &query).await
        }
        other => other,
    }
    .map_err(gmail_error)?;
    let cutoff = (now() - MAX_AGE_MINUTES * 60) * 1000;
    let mut out = Vec::new();
    for id in ids.iter().filter(|id| !skip.contains(id)) {
        let m = gmail.message(&access, id).await.map_err(gmail_error)?;
        if m.received_ms < cutoff {
            continue;
        }
        let ours = match site {
            Site::Workday => gmail::workday_sender(&m.from).as_deref() == Some(who.tenant),
            // One sender for every Greenhouse company: the mail must name ours.
            Site::Greenhouse => gmail::greenhouse_company_matches(&m, who.tenant, who.company),
        };
        if !ours {
            continue;
        }
        out.push(m);
    }
    Ok(out)
}

fn parse_tenant(site: Site, tenant: Option<&str>) -> ApiResult<String> {
    let tenant = tenant.unwrap_or("").trim().to_ascii_lowercase();
    if site == Site::Workday
        && (tenant.is_empty()
            || tenant.len() > 64
            || !tenant
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    {
        return Err(ApiError::bad("Unknown Workday company."));
    }
    // A Greenhouse board slug is optional; anything odd is dropped.
    let plain = tenant.len() <= 64
        && tenant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    Ok(if plain { tenant } else { String::new() })
}

/// The company name the page shows, as plain short text.
fn parse_company(company: Option<&str>) -> String {
    accounts::truncate_chars(&accounts::clean_line(company.unwrap_or("")), 100).to_owned()
}

fn parse_skip(skip: &[String]) -> Vec<String> {
    skip.iter()
        .filter(|id| gmail::is_message_id(id))
        .take(MAX_SKIP)
        .cloned()
        .collect()
}

async fn count_read(state: &AppState, user_id: Uuid) -> ApiResult<()> {
    rate_limit(
        state,
        &user_id.to_string(),
        "gmail_read",
        READS_PER_DAY,
        "Gmail was checked too often today. Enter the code yourself.",
    )
    .await
}

/// `GET /api/autofill/gmail`: whether codes can be read.
pub async fn ext_status(State(state): State<AppState>, who: TokenUser) -> ApiResult<Json<Value>> {
    if state.gmail.is_none() {
        return Ok(Json(json!({ "available": false, "connected": false })));
    }
    let row = db::connectors::gmail_connection(state.pool()?, who.user.id).await?;
    let email = match row {
        Some(row) => Some(
            state
                .keyring()?
                .decrypt_json::<Grant>(Field::GmailGrant, &who.user.id, &row.grant_data)?
                .email,
        ),
        None => None,
    };
    Ok(Json(
        json!({ "available": true, "connected": email.is_some(), "email": email }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeBody {
    site: String,
    /// The Workday tenant, or the Greenhouse board slug.
    #[serde(default)]
    tenant: Option<String>,
    /// The company name on the page (Greenhouse).
    #[serde(default)]
    company: Option<String>,
    #[serde(default)]
    length: Option<usize>,
    #[serde(default)]
    charset: Option<String>,
    /// Message ids already used on this browser.
    #[serde(default)]
    skip: Vec<String>,
}

/// `POST /api/autofill/gmail/code` -> `{ code, messageId }` (both null when
/// no fitting mail arrived yet).
pub async fn ext_code(
    State(state): State<AppState>,
    who: TokenUser,
    JsonBody(body): JsonBody<CodeBody>,
) -> ApiResult<Json<Value>> {
    let site = Site::parse(&body.site)
        .ok_or_else(|| ApiError::bad("Codes are read only for Workday and Greenhouse."))?;
    let tenant = parse_tenant(site, body.tenant.as_deref())?;
    let company = parse_company(body.company.as_deref());
    let shape = CodeShape {
        length: body.length.filter(|l| (4..=10).contains(l)),
        digits_only: body.charset.as_deref() == Some("digits"),
    };
    client(&state)?;
    count_read(&state, who.user.id).await?;
    let mail_for = For {
        tenant: &tenant,
        company: &company,
    };
    for m in recent(&state, who.user.id, site, mail_for, &parse_skip(&body.skip)).await? {
        if let Some(code) = gmail::pick_code(&m.text, shape) {
            return Ok(Json(json!({ "code": code, "messageId": m.id })));
        }
    }
    Ok(Json(json!({ "code": null, "messageId": null })))
}

#[derive(Deserialize)]
pub struct LinkBody {
    tenant: String,
    #[serde(default)]
    skip: Vec<String>,
}

/// `POST /api/autofill/gmail/verify-link` -> `{ link, messageId }`: this
/// Workday company's own verification link, for the extension's worker to
/// open (the page never sees it).
pub async fn ext_verify_link(
    State(state): State<AppState>,
    who: TokenUser,
    JsonBody(body): JsonBody<LinkBody>,
) -> ApiResult<Json<Value>> {
    let tenant = parse_tenant(Site::Workday, Some(&body.tenant))?;
    client(&state)?;
    count_read(&state, who.user.id).await?;
    for m in recent(
        &state,
        who.user.id,
        Site::Workday,
        For {
            tenant: &tenant,
            company: "",
        },
        &parse_skip(&body.skip),
    )
    .await?
    {
        if let Some(link) = gmail::verify_link(&m.hrefs, &tenant) {
            return Ok(Json(json!({ "link": link, "messageId": m.id })));
        }
    }
    Ok(Json(json!({ "link": null, "messageId": null })))
}
