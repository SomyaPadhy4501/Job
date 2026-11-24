//! Deleting resume files, the daily cleanup (Vercel Cron), and the owner's
//! usage page.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, header};
use serde_json::{Value, json};

use accounts::token::ct_eq;

use crate::AppState;
use crate::error::{ApiError, ApiResult};
use crate::roles::Owner;

/// Deletes queued files. Each success clears its queue row; each failure is
/// counted and retried by the cleanup. Returns (deleted, failed).
pub async fn delete_objects(state: &AppState, keys: &[String]) -> (usize, usize) {
    let Ok(pool) = state.pool() else {
        return (0, keys.len());
    };
    let (mut deleted, mut failed) = (0, 0);
    for key in keys {
        match state.storage.delete(key).await {
            Ok(()) => {
                db::deletion_done(pool, key).await.ok();
                deleted += 1;
            }
            Err(e) => {
                db::deletion_failed(pool, key, &e.to_string()).await.ok();
                failed += 1;
            }
        }
    }
    (deleted, failed)
}

/// `GET /api/cron/cleanup`, called daily by Vercel Cron with
/// `Authorization: Bearer $CRON_SECRET`. Without a secret configured it
/// doesn't exist.
pub async fn cleanup(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let Some(secret) = state.config.cron_secret.as_deref() else {
        return Err(ApiError::NotFound);
    };
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !ct_eq(given.as_bytes(), secret.as_bytes()) {
        return Err(ApiError::Unauthorized);
    }
    let pool = state.pool()?;
    let sweep = db::sweep(pool).await?;
    let keys = db::pending_deletions(pool, None, 200).await?;
    let (deleted, failed) = delete_objects(&state, &keys).await;
    Ok(Json(
        json!({ "ok": true, "sweep": sweep, "filesDeleted": deleted, "filesFailed": failed }),
    ))
}

/// `GET /api/admin/usage`: counts only, no personal data. Owner only
/// (see `roles`).
pub async fn usage(State(state): State<AppState>, _owner: Owner) -> ApiResult<Json<Value>> {
    let usage = db::usage(state.pool()?).await?;
    let c = &state.config;
    Ok(Json(json!({
        "usage": usage,
        "storage": state.storage.driver(),
        "signupsOpen": c.signups_open,
        "maxUsers": c.max_users,
        "maxStorageBytes": c.max_storage_bytes,
    })))
}
