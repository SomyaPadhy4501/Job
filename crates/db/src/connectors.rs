//! Connected accounts (`migrations/009_gmail_connections.sql`): a user's
//! read-only Gmail grant. The grant and the cached access token are stored
//! encrypted; only the scopes and dates are in the clear.

use sqlx::FromRow;
use sqlx::postgres::PgExecutor;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::Result;

#[derive(Debug, Clone, FromRow)]
pub struct GmailConnection {
    pub user_id: Uuid,
    /// Encrypted: the Google account and refresh token.
    pub grant_data: Vec<u8>,
    /// Encrypted: the cached access token and its expiry.
    pub access_data: Option<Vec<u8>>,
    pub scopes: String,
    pub created_at: OffsetDateTime,
    pub last_used_at: Option<OffsetDateTime>,
}

const COLUMNS: &str = "user_id, grant_data, access_data, scopes, created_at, last_used_at";

pub async fn gmail_connection(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
) -> Result<Option<GmailConnection>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM gmail_connections WHERE user_id = $1"
    ))
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

/// Saves a new grant, replacing any earlier one (and its cached token).
pub async fn put_gmail_connection(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    grant_data: &[u8],
    access_data: &[u8],
    scopes: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO gmail_connections (user_id, grant_data, access_data, scopes) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET grant_data = EXCLUDED.grant_data,
           access_data = EXCLUDED.access_data, scopes = EXCLUDED.scopes,
           created_at = now(), last_used_at = NULL",
    )
    .bind(user_id)
    .bind(grant_data)
    .bind(access_data)
    .bind(scopes)
    .execute(db)
    .await?;
    Ok(())
}

/// Caches a fresh access token; `grant_data` too when Google rotated the
/// refresh token. Marks the connection used.
pub async fn set_gmail_access(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    access_data: &[u8],
    grant_data: Option<&[u8]>,
) -> Result<()> {
    sqlx::query(
        "UPDATE gmail_connections SET access_data = $2, grant_data = COALESCE($3, grant_data),
           last_used_at = now() WHERE user_id = $1",
    )
    .bind(user_id)
    .bind(access_data)
    .bind(grant_data)
    .execute(db)
    .await?;
    Ok(())
}

/// Marks the connection used, at most once a minute.
pub async fn touch_gmail(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE gmail_connections SET last_used_at = now()
         WHERE user_id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')",
    )
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Removes the connection and returns it, so its grant can be revoked.
pub async fn delete_gmail_connection(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
) -> Result<Option<GmailConnection>> {
    Ok(sqlx::query_as(&format!(
        "DELETE FROM gmail_connections WHERE user_id = $1 RETURNING {COLUMNS}"
    ))
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}
