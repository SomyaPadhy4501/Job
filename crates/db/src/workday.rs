//! Workday login (`migrations/010_workday_login.sql`): the one email and
//! password a user sets for every company's Workday site. Stored encrypted;
//! only the date it was saved is in the clear.

use sqlx::FromRow;
use sqlx::postgres::PgExecutor;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::Result;

#[derive(Debug, Clone, FromRow)]
pub struct WorkdayLogin {
    pub user_id: Uuid,
    /// Encrypted: `{email, password}`.
    pub login_data: Vec<u8>,
    pub updated_at: OffsetDateTime,
}

pub async fn workday_login(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<Option<WorkdayLogin>> {
    Ok(sqlx::query_as(
        "SELECT user_id, login_data, updated_at FROM workday_logins WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

/// Saves the login, replacing any earlier one. Returns the saved row.
pub async fn put_workday_login(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    login_data: &[u8],
) -> Result<WorkdayLogin> {
    Ok(sqlx::query_as(
        "INSERT INTO workday_logins (user_id, login_data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET login_data = EXCLUDED.login_data, updated_at = now()
         RETURNING user_id, login_data, updated_at",
    )
    .bind(user_id)
    .bind(login_data)
    .fetch_one(db)
    .await?)
}

/// Removes the login. Returns whether there was one.
pub async fn delete_workday_login(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<bool> {
    Ok(sqlx::query("DELETE FROM workday_logins WHERE user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected()
        > 0)
}
