//! The apply queue: jobs a user means to apply to, and the groundwork for an
//! agent that prepares applications (see docs/agent-apply.md).
//!
//! Who can do what:
//! - the user (web page, cookie): add, remove, and set any status;
//! - a linked chat: add (`/apply`);
//! - the extension (autofill token): read;
//! - an agent (a token with scope `agent`): read, and move an item to
//!   `prepared` or `needs_you`. Nothing but the user ever sets
//!   `submitted_by_you`: the final submit is a human click, never the agent's.
//!
//! Every change, and every agent call, is written to `apply_events`.

use axum::Json;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{StatusCode, header};
use serde::Deserialize;
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use accounts::crypto::Field;
use accounts::token::{looks_like_api_token, new_api_token, sha256};
use db::alerts::JobRow;
use db::queue::{Event, QueueRow};

use crate::AppState;
use crate::account::TOKEN_DAYS;
use crate::auth::Signed;
use crate::autofill::TokenUser;
use crate::chat::Channel;
use crate::error::{ApiError, ApiResult};
use crate::http::{JsonBody, parse_id};

pub const MAX_ITEMS: i64 = 200;
pub const MAX_NOTE_CHARS: usize = 1000;
pub const AGENT_SCOPE: &str = "agent";
pub const STATUSES: &[&str] = &[
    "queued",
    "prepared",
    "needs_you",
    "submitted_by_you",
    "skipped",
];
/// Statuses an agent may set.
pub const AGENT_TARGETS: &[&str] = &["prepared", "needs_you"];
/// Statuses an agent may still work on.
pub const AGENT_OPEN: &[&str] = &["queued", "prepared", "needs_you"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    You,
    Chat(Channel),
    Extension,
    Agent,
}

impl Actor {
    pub fn as_str(self) -> &'static str {
        match self {
            Actor::You => "you",
            Actor::Chat(c) => c.as_str(),
            Actor::Extension => "extension",
            Actor::Agent => "agent",
        }
    }
}

/// Whether `actor` may move an item from `from` to `to`.
pub fn may_move(actor: Actor, from: &str, to: &str) -> Result<(), &'static str> {
    if !STATUSES.contains(&to) {
        return Err("Pick a status from the list.");
    }
    match actor {
        Actor::You => Ok(()),
        Actor::Agent if !AGENT_TARGETS.contains(&to) => {
            Err("Only you can mark an application submitted or skipped.")
        }
        Actor::Agent if !AGENT_OPEN.contains(&from) => {
            Err("This job is no longer waiting for the agent.")
        }
        Actor::Agent => Ok(()),
        Actor::Chat(_) | Actor::Extension => Err("Change the status on the queue page."),
    }
}

fn rfc(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap_or_default()
}

fn item_json(state: &AppState, user_id: Uuid, row: &QueueRow) -> ApiResult<Value> {
    let note = match &row.note {
        Some(enc) => Some(
            String::from_utf8(state.keyring()?.decrypt(Field::QueueNote, &user_id, enc)?)
                .map_err(|_| ApiError::Internal)?,
        ),
        None => None,
    };
    Ok(json!({
        "id": row.id,
        "jobId": row.job_id,
        "company": row.company,
        "title": row.title,
        "applyUrl": row.apply_url,
        "status": row.status,
        "note": note,
        "addedVia": row.added_via,
        "createdAt": rfc(row.created_at),
        "updatedAt": rfc(row.updated_at),
    }))
}

pub fn items_json(state: &AppState, user_id: Uuid, rows: &[QueueRow]) -> ApiResult<Vec<Value>> {
    rows.iter().map(|r| item_json(state, user_id, r)).collect()
}

async fn log(
    state: &AppState,
    user_id: Uuid,
    item_id: Uuid,
    actor: Actor,
    action: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> ApiResult<()> {
    db::queue::log_event(
        state.pool()?,
        &Event {
            user_id,
            item_id,
            actor: actor.as_str(),
            action,
            from_status: from,
            to_status: to,
        },
    )
    .await?;
    Ok(())
}

/// A job by its board number (`1234` or `#1234`) or its apply link.
pub async fn find_job(state: &AppState, raw: &str) -> ApiResult<Option<JobRow>> {
    let raw = raw.trim();
    let pool = state.pool()?;
    if let Ok(id) = raw.trim_start_matches('#').parse::<i32>() {
        return Ok(db::alerts::job_by_id(pool, id).await?);
    }
    if raw.starts_with("https://") || raw.starts_with("http://") {
        return Ok(db::alerts::job_by_url(pool, accounts::truncate_chars(raw, 2000)).await?);
    }
    Ok(None)
}

/// Adds a job (or finds it already there). The bool says it's new.
pub async fn add(
    state: &AppState,
    user_id: Uuid,
    job: &JobRow,
    actor: Actor,
) -> ApiResult<(QueueRow, bool)> {
    let pool = state.pool()?;
    if db::queue::count_queue(pool, user_id).await? >= MAX_ITEMS {
        return Err(ApiError::Forbidden(format!(
            "Your queue holds {MAX_ITEMS} jobs. Remove some first."
        )));
    }
    let (row, added) = db::queue::add_to_queue(pool, user_id, job, actor.as_str()).await?;
    if added {
        log(state, user_id, row.id, actor, "add", None, Some("queued")).await?;
    }
    Ok((row, added))
}

fn clean_note(note: &str) -> ApiResult<Option<String>> {
    let note = note.trim();
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(ApiError::bad(format!(
            "Keep the note under {MAX_NOTE_CHARS} characters."
        )));
    }
    Ok((!note.is_empty()).then(|| note.to_owned()))
}

/// Moves an item, checking who may, and logs it (refusals too).
async fn change(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    actor: Actor,
    status: Option<&str>,
    note: Option<&str>,
) -> ApiResult<QueueRow> {
    let pool = state.pool()?;
    let note = note.map(clean_note).transpose()?;
    let mut tx = pool.begin().await.map_err(db::DbError::from)?;
    let current = db::queue::lock_item(&mut tx, user_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let to = status.unwrap_or(&current.status).to_owned();
    if let Err(why) = may_move(actor, &current.status, &to) {
        drop(tx);
        log(
            state,
            user_id,
            id,
            actor,
            "refused",
            Some(&current.status),
            Some(&to),
        )
        .await?;
        return Err(ApiError::Forbidden(why.into()));
    }
    // None: keep the note. Some(None): clear it. Some(Some(..)): replace it.
    let enc: Option<Option<Vec<u8>>> = match note {
        None => None,
        Some(None) => Some(None),
        Some(Some(n)) => Some(Some(state.keyring()?.encrypt(
            Field::QueueNote,
            &user_id,
            n.as_bytes(),
        ))),
    };
    let row = db::queue::update_item(
        &mut tx,
        user_id,
        id,
        &to,
        enc.as_ref().map(|n| n.as_deref()),
    )
    .await?;
    tx.commit().await.map_err(db::DbError::from)?;
    let action = if to == current.status {
        "note"
    } else {
        "status"
    };
    log(
        state,
        user_id,
        id,
        actor,
        action,
        Some(&current.status),
        Some(&to),
    )
    .await?;
    Ok(row)
}

// ---------------------------------------------------------------------------
// The user (cookie routes)

pub async fn list(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let rows = db::queue::list_queue(state.pool()?, signed.user.id, None, MAX_ITEMS).await?;
    Ok(Json(json!({
        "items": items_json(&state, signed.user.id, &rows)?,
        "statuses": STATUSES,
        "max": MAX_ITEMS,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddBody {
    #[serde(default)]
    job_id: Option<i32>,
    #[serde(default)]
    url: String,
}

pub async fn add_web(
    State(state): State<AppState>,
    signed: Signed,
    JsonBody(body): JsonBody<AddBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let wanted = match body.job_id {
        Some(id) => id.to_string(),
        None => body.url,
    };
    let job = find_job(&state, &wanted).await?.ok_or_else(|| {
        ApiError::bad("That job isn’t on the board. Paste its link from the board.")
    })?;
    let (row, added) = add(&state, signed.user.id, &job, Actor::You).await?;
    let status = if added {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(json!({ "item": item_json(&state, signed.user.id, &row)?, "added": added })),
    ))
}

#[derive(Deserialize)]
pub struct ChangeBody {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<ChangeBody>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let row = change(
        &state,
        signed.user.id,
        id,
        Actor::You,
        body.status.as_deref(),
        body.note.as_deref(),
    )
    .await?;
    Ok(Json(item_json(&state, signed.user.id, &row)?))
}

pub async fn remove(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    let user_id = signed.user.id;
    if !db::queue::delete_item(state.pool()?, user_id, id).await? {
        return Err(ApiError::NotFound);
    }
    log(&state, user_id, id, Actor::You, "remove", None, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn events(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let events = db::queue::list_events(state.pool()?, signed.user.id, id).await?;
    Ok(Json(json!({ "events": events })))
}

#[derive(Deserialize, Default)]
pub struct AgentTokenBody {
    #[serde(default)]
    label: String,
}

/// A token for an apply agent. Shown once, like an extension token, and
/// revoked the same way (`DELETE /api/me/tokens/{id}`).
pub async fn create_agent_token(
    State(state): State<AppState>,
    signed: Signed,
    JsonBody(body): JsonBody<AgentTokenBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    signed.require_recent()?;
    let pool = state.pool()?;
    let user_id = signed.user.id;
    if db::list_tokens(pool, user_id).await?.len() as i64 >= state.config.max_tokens {
        return Err(ApiError::Forbidden(format!(
            "You can have {} tokens. Revoke one first.",
            state.config.max_tokens
        )));
    }
    let label = accounts::clean_line(&body.label);
    let label = if label.is_empty() {
        "Apply agent".to_owned()
    } else {
        accounts::truncate_chars(&label, 60).to_owned()
    };
    let new = new_api_token();
    let expires = OffsetDateTime::now_utc() + Duration::days(TOKEN_DAYS);
    let info =
        db::queue::create_agent_token(pool, user_id, &new.hash, &new.prefix, &label, Some(expires))
            .await?;
    db::audit(pool, Some(user_id), "agent_token_create").await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": new.token, "info": info })),
    ))
}

// ---------------------------------------------------------------------------
// The extension (autofill token): read only

pub async fn for_extension(
    State(state): State<AppState>,
    who: TokenUser,
) -> ApiResult<Json<Value>> {
    let open: Vec<String> = AGENT_OPEN.iter().map(|s| (*s).to_owned()).collect();
    let rows = db::queue::list_queue(state.pool()?, who.user.id, Some(&open), 50).await?;
    Ok(Json(
        json!({ "items": items_json(&state, who.user.id, &rows)? }),
    ))
}

// ---------------------------------------------------------------------------
// An agent (token with scope `agent`)

/// The user behind a valid agent token. Extension tokens don't qualify, and
/// agent tokens can't reach the extension's routes.
pub struct AgentUser {
    pub user: db::User,
}

impl FromRequestParts<AppState> for AgentUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|t| looks_like_api_token(t))
            .ok_or(ApiError::Unauthorized)?;
        let pool = state.pool()?;
        let (token_id, last_used, user) =
            db::token_user(pool, &sha256(token.as_bytes()), AGENT_SCOPE)
                .await?
                .ok_or(ApiError::Unauthorized)?;
        if last_used.is_none_or(|t| OffsetDateTime::now_utc() - t > Duration::hours(1)) {
            db::touch_token(pool, token_id).await.ok();
        }
        Ok(AgentUser { user })
    }
}

/// Jobs waiting for the agent: queued, prepared, or needing the user.
pub async fn agent_list(State(state): State<AppState>, who: AgentUser) -> ApiResult<Json<Value>> {
    let user_id = who.user.id;
    let open: Vec<String> = AGENT_OPEN.iter().map(|s| (*s).to_owned()).collect();
    let rows = db::queue::list_queue(state.pool()?, user_id, Some(&open), 50).await?;
    log(
        &state,
        user_id,
        Uuid::nil(),
        Actor::Agent,
        "list",
        None,
        None,
    )
    .await?;
    Ok(Json(json!({
        "items": items_json(&state, user_id, &rows)?,
        "maySet": AGENT_TARGETS,
    })))
}

#[derive(Deserialize)]
pub struct AgentBody {
    status: String,
    #[serde(default)]
    note: Option<String>,
}

/// `POST /api/agent/queue/{id}`: `prepared` (ready for the user to review
/// and submit) or `needs_you` (the agent is stuck). Nothing else.
pub async fn agent_set(
    State(state): State<AppState>,
    who: AgentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<AgentBody>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let row = change(
        &state,
        who.user.id,
        id,
        Actor::Agent,
        Some(body.status.trim()),
        body.note.as_deref(),
    )
    .await?;
    Ok(Json(item_json(&state, who.user.id, &row)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_never_submits() {
        assert!(may_move(Actor::Agent, "queued", "prepared").is_ok());
        assert!(may_move(Actor::Agent, "prepared", "needs_you").is_ok());
        assert!(may_move(Actor::Agent, "queued", "submitted_by_you").is_err());
        assert!(may_move(Actor::Agent, "queued", "skipped").is_err());
        assert!(
            may_move(Actor::Agent, "submitted_by_you", "prepared").is_err(),
            "done is done"
        );
        assert!(may_move(Actor::Agent, "skipped", "prepared").is_err());
        assert!(may_move(Actor::You, "prepared", "submitted_by_you").is_ok());
        assert!(may_move(Actor::You, "queued", "nonsense").is_err());
        assert!(may_move(Actor::Extension, "queued", "prepared").is_err());
    }
}
