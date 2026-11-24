//! Extension tokens, data export and account deletion. Creating a token,
//! exporting and deleting need a sign-in from the last few minutes.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{AppendHeaders, IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use accounts::token::new_api_token;

use crate::AppState;
use crate::auth::{Signed, clear_cookies};
use crate::error::{ApiError, ApiResult};
use crate::housekeeping::delete_objects;
use crate::http::{JsonBody, parse_id};
use crate::resumes::parsed_of;

pub const TOKEN_DAYS: i64 = 365;

pub async fn list_tokens(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let tokens = db::list_tokens(state.pool()?, signed.user.id).await?;
    Ok(Json(
        json!({ "tokens": tokens, "max": state.config.max_tokens }),
    ))
}

#[derive(Deserialize, Default)]
pub struct CreateTokenBody {
    #[serde(default)]
    label: String,
}

pub async fn create_token(
    State(state): State<AppState>,
    signed: Signed,
    JsonBody(body): JsonBody<CreateTokenBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    signed.require_recent()?;
    let pool = state.pool()?;
    let user_id = signed.user.id;
    if db::list_tokens(pool, user_id).await?.len() as i64 >= state.config.max_tokens {
        return Err(ApiError::Forbidden(format!(
            "You can have {} extension tokens. Revoke one first.",
            state.config.max_tokens
        )));
    }
    let label = accounts::clean_line(&body.label);
    let label = if label.is_empty() {
        "Chrome extension".to_owned()
    } else {
        accounts::truncate_chars(&label, 60).to_owned()
    };
    let new = new_api_token();
    let expires = OffsetDateTime::now_utc() + Duration::days(TOKEN_DAYS);
    let info =
        db::create_token(pool, user_id, &new.hash, &new.prefix, &label, Some(expires)).await?;
    db::audit(pool, Some(user_id), "token_create").await?;
    // The only time the token itself is ever shown.
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": new.token, "info": info })),
    ))
}

pub async fn revoke_token(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    let pool = state.pool()?;
    if !db::revoke_token(pool, signed.user.id, id).await? {
        return Err(ApiError::NotFound);
    }
    db::audit(pool, Some(signed.user.id), "token_revoke").await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Everything stored about the user, as one JSON file. Resume files are
/// listed with their download paths rather than embedded (a response over
/// 4.5 MB would fail on Vercel).
pub async fn export(State(state): State<AppState>, signed: Signed) -> ApiResult<Response> {
    signed.require_recent()?;
    let pool = state.pool()?;
    let user_id = signed.user.id;
    let profile = crate::profile::load(&state, user_id).await?;
    let mut resumes = Vec::new();
    for r in db::list_resumes(pool, user_id).await? {
        let parsed = parsed_of(&state, user_id, &r)?;
        // LaTeX source, for resumes made in the editor (at most 100 KB each).
        let latex = match db::get_source(pool, user_id, r.id).await? {
            Some(row) => Some(
                String::from_utf8(state.keyring()?.decrypt(
                    accounts::crypto::Field::ResumeSource,
                    &user_id,
                    &row.source,
                )?)
                .map_err(|_| ApiError::Internal)?,
            ),
            None => None,
        };
        resumes.push(json!({
            "resume": r,
            "parsed": parsed,
            "latexSource": latex,
            "download": format!("/api/me/resumes/{}/file", r.id),
        }));
    }
    let mut alerts = Vec::new();
    for row in db::alerts::list_alerts(pool, user_id).await? {
        let spec = crate::alerts::spec_of(&state, &row)?;
        alerts.push(json!({
            "name": spec.name, "filters": spec.filters, "frequency": row.frequency,
            "channels": row.channels, "paused": row.paused,
        }));
    }
    let queue = db::queue::list_queue(pool, user_id, None, crate::queue::MAX_ITEMS).await?;
    let body = json!({
        "exportedAt": OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
        "user": signed.user,
        "profile": profile.profile,
        "profileSources": profile.sources,
        "resumes": resumes,
        "answers": crate::answers::all(&state, user_id).await?,
        "extensionTokens": db::list_tokens(pool, user_id).await?,
        "alerts": alerts,
        "applyQueue": crate::queue::items_json(&state, user_id, &queue)?,
        "telegramLinked": db::chat::chat_link(pool, user_id, "telegram").await?.is_some(),
        "gmailConnection": crate::connectors::export_json(&state, user_id).await?,
        "workdayLogin": crate::workday_login::export_json(&state, user_id).await?,
    });
    db::audit(pool, Some(user_id), "export").await?;
    let headers = [(
        header::CONTENT_DISPOSITION,
        "attachment; filename=\"jobboard-export.json\"",
    )];
    Ok((headers, Json(body)).into_response())
}

/// Hard delete: the user row goes and every table cascades; the trigger
/// queues each resume file, and the files are deleted right after commit
/// (the daily cleanup retries any that fail).
pub async fn delete_account(State(state): State<AppState>, signed: Signed) -> ApiResult<Response> {
    signed.require_recent()?;
    let pool = state.pool()?;
    let user_id = signed.user.id;
    // Read before the cascade deletes it, to revoke the grant at Google after.
    let gmail = db::connectors::gmail_connection(pool, user_id)
        .await
        .ok()
        .flatten();
    let mut tx = pool.begin().await.map_err(db::DbError::from)?;
    let keys = db::delete_user(&mut tx, user_id).await?;
    tx.commit().await.map_err(db::DbError::from)?;
    db::audit(pool, Some(user_id), "account_delete").await?;
    if let Some(row) = gmail {
        crate::connectors::revoke_row(&state, user_id, &row).await;
    }
    let (deleted, failed) = delete_objects(&state, &keys).await;
    Ok((
        AppendHeaders(clear_cookies(&state)),
        Json(json!({ "ok": true, "filesDeleted": deleted, "filesPending": failed })),
    )
        .into_response())
}
