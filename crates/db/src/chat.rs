//! Chats linked to accounts, and the one-time codes that link them
//! (`migrations/007_alerts.sql`). A chat is looked up by a keyed hash of its
//! id; the id itself is stored encrypted, for sending.

use sqlx::postgres::PgExecutor;
use sqlx::{FromRow, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{Result, User};

/// Replaces the user's live code for `channel`.
pub async fn put_link_code(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    channel: &str,
    code_hash: &[u8; 32],
    expires_at: OffsetDateTime,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO chat_link_codes (code_hash, user_id, channel, expires_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, channel) DO UPDATE SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at",
    )
    .bind(&code_hash[..])
    .bind(user_id)
    .bind(channel)
    .bind(expires_at)
    .execute(db)
    .await?;
    Ok(())
}

/// Uses up a live code: returns its user and deletes it.
pub async fn take_link_code(
    db: impl PgExecutor<'_>,
    channel: &str,
    code_hash: &[u8; 32],
) -> Result<Option<Uuid>> {
    Ok(sqlx::query_scalar(
        "DELETE FROM chat_link_codes WHERE code_hash = $1 AND channel = $2 AND expires_at > now()
         RETURNING user_id",
    )
    .bind(&code_hash[..])
    .bind(channel)
    .fetch_optional(db)
    .await?)
}

/// Links the chat to the user. A chat belongs to one account at a time, so a
/// link it had to someone else ends here.
pub async fn link_chat(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    channel: &str,
    address_hash: &[u8; 32],
    address: &[u8],
) -> Result<()> {
    sqlx::query(
        "DELETE FROM chat_links WHERE channel = $1 AND address_hash = $2 AND user_id <> $3",
    )
    .bind(channel)
    .bind(&address_hash[..])
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "INSERT INTO chat_links (user_id, channel, address_hash, address) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, channel) DO UPDATE SET address_hash = EXCLUDED.address_hash,
           address = EXCLUDED.address, created_at = now()",
    )
    .bind(user_id)
    .bind(channel)
    .bind(&address_hash[..])
    .bind(address)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// The account a chat is linked to, unless it's disabled.
pub async fn chat_user(
    db: impl PgExecutor<'_>,
    channel: &str,
    address_hash: &[u8; 32],
) -> Result<Option<User>> {
    Ok(sqlx::query_as(
        "SELECT u.id, u.google_sub, u.email, u.email_verified, u.name, u.avatar_url,
                u.created_at, u.last_login_at, u.disabled_at
         FROM chat_links c JOIN users u ON u.id = c.user_id
         WHERE c.channel = $1 AND c.address_hash = $2 AND u.disabled_at IS NULL",
    )
    .bind(channel)
    .bind(&address_hash[..])
    .fetch_optional(db)
    .await?)
}

#[derive(Debug, Clone, FromRow)]
pub struct ChatLink {
    pub address: Vec<u8>,
    pub created_at: OffsetDateTime,
}

pub async fn chat_link(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    channel: &str,
) -> Result<Option<ChatLink>> {
    Ok(sqlx::query_as(
        "SELECT address, created_at FROM chat_links WHERE user_id = $1 AND channel = $2",
    )
    .bind(user_id)
    .bind(channel)
    .fetch_optional(db)
    .await?)
}

pub async fn unlink_chat(db: impl PgExecutor<'_>, user_id: Uuid, channel: &str) -> Result<bool> {
    Ok(
        sqlx::query("DELETE FROM chat_links WHERE user_id = $1 AND channel = $2")
            .bind(user_id)
            .bind(channel)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}
