//! The apply queue and its log (`migrations/007_alerts.sql`). Every query
//! takes the user's id. Status rules live in the API (`crates/api/src/queue.rs`);
//! this module only reads and writes.

use serde::Serialize;
use sqlx::postgres::PgExecutor;
use sqlx::{FromRow, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::Result;
use crate::alerts::JobRow;

#[derive(Debug, Clone, FromRow)]
pub struct QueueRow {
    pub id: Uuid,
    pub job_id: i32,
    pub company: String,
    pub title: String,
    pub apply_url: String,
    pub status: String,
    pub note: Option<Vec<u8>>,
    pub added_via: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

const QUEUE_COLUMNS: &str =
    "id, job_id, company, title, apply_url, status, note, added_via, created_at, updated_at";

/// The user's queue, most recently changed first. `statuses` narrows it.
pub async fn list_queue(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    statuses: Option<&[String]>,
    limit: i64,
) -> Result<Vec<QueueRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {QUEUE_COLUMNS} FROM apply_queue
         WHERE user_id = $1 AND ($2::TEXT[] IS NULL OR status = ANY ($2))
         ORDER BY updated_at DESC LIMIT $3"
    ))
    .bind(user_id)
    .bind(statuses)
    .bind(limit)
    .fetch_all(db)
    .await?)
}

pub async fn count_queue(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM apply_queue WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?,
    )
}

/// Adds the job, or returns the item already there. The bool says it's new.
pub async fn add_to_queue(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    job: &JobRow,
    via: &str,
) -> Result<(QueueRow, bool)> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        item: QueueRow,
        inserted: bool,
    }
    let row: Row = sqlx::query_as(&format!(
        "INSERT INTO apply_queue (user_id, job_id, company, title, apply_url, added_via)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, job_id) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING {QUEUE_COLUMNS}, (xmax = 0) AS inserted"
    ))
    .bind(user_id)
    .bind(job.id)
    .bind(&job.company_name)
    .bind(&job.job_title)
    .bind(&job.apply_url)
    .bind(via)
    .fetch_one(db)
    .await?;
    Ok((row.item, row.inserted))
}

/// The item, locked for the rest of the transaction.
pub async fn lock_item(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<QueueRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {QUEUE_COLUMNS} FROM apply_queue WHERE id = $1 AND user_id = $2 FOR UPDATE"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?)
}

/// Sets the status, and the note when `note` is `Some` (`Some(None)` clears it).
pub async fn update_item(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    id: Uuid,
    status: &str,
    note: Option<Option<&[u8]>>,
) -> Result<QueueRow> {
    let (set_note, value) = match note {
        Some(v) => (true, v),
        None => (false, None),
    };
    Ok(sqlx::query_as(&format!(
        "UPDATE apply_queue SET status = $3, note = CASE WHEN $4 THEN $5 ELSE note END, updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING {QUEUE_COLUMNS}"
    ))
    .bind(id)
    .bind(user_id)
    .bind(status)
    .bind(set_note)
    .bind(value)
    .fetch_one(&mut **tx)
    .await?)
}

pub async fn delete_item(db: impl PgExecutor<'_>, user_id: Uuid, id: Uuid) -> Result<bool> {
    Ok(
        sqlx::query("DELETE FROM apply_queue WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}

pub struct Event<'a> {
    pub user_id: Uuid,
    pub item_id: Uuid,
    pub actor: &'a str,
    pub action: &'a str,
    pub from_status: Option<&'a str>,
    pub to_status: Option<&'a str>,
}

pub async fn log_event(db: impl PgExecutor<'_>, e: &Event<'_>) -> Result<()> {
    sqlx::query(
        "INSERT INTO apply_events (user_id, item_id, actor, action, from_status, to_status)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(e.user_id)
    .bind(e.item_id)
    .bind(e.actor)
    .bind(e.action)
    .bind(e.from_status)
    .bind(e.to_status)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub actor: String,
    pub action: String,
    pub from_status: Option<String>,
    pub to_status: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

/// The log of one item, newest first.
pub async fn list_events(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    item_id: Uuid,
) -> Result<Vec<EventRow>> {
    Ok(sqlx::query_as(
        "SELECT actor, action, from_status, to_status, created_at FROM apply_events
         WHERE user_id = $1 AND item_id = $2 ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .bind(user_id)
    .bind(item_id)
    .fetch_all(db)
    .await?)
}

/// A token for the apply agent: like the extension's, with scope `agent`.
pub async fn create_agent_token(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    hash: &[u8; 32],
    prefix: &str,
    label: &str,
    expires_at: Option<OffsetDateTime>,
) -> Result<crate::ApiToken> {
    Ok(sqlx::query_as(
        "INSERT INTO api_tokens (user_id, token_hash, token_prefix, label, scopes, expires_at)
         VALUES ($1, $2, $3, $4, '{agent}', $5)
         RETURNING id, token_prefix, label, scopes, created_at, last_used_at, expires_at",
    )
    .bind(user_id)
    .bind(&hash[..])
    .bind(prefix)
    .bind(label)
    .bind(expires_at)
    .fetch_one(db)
    .await?)
}
