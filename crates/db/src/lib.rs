//! Postgres queries for the accounts tables (`migrations/004_accounts.sql`).
//!
//! Every query that reads or changes a user's data takes that user's id and
//! puts it in the `WHERE` clause, so a handler can't fetch another user's row
//! by guessing its id: it simply isn't found.
//!
//! Queries are checked at run time (`sqlx::query_as`, not the `query!`
//! macros), so building needs no live database.

use serde::Serialize;
use sqlx::postgres::{PgExecutor, PgPool};
use sqlx::{FromRow, Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

pub use sqlx;

pub mod alerts;
pub mod chat;
pub mod connectors;
pub mod queue;
pub mod workday;

pub type Tx<'a> = Transaction<'a, Postgres>;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// A table the query needs doesn't exist: a migration in `migrations/`
    /// hasn't been applied to this database.
    #[error("a table is missing; apply the pending migrations in migrations/")]
    NotMigrated,
    /// A unique constraint refused the write. Carries the constraint name.
    #[error("already exists ({0})")]
    Conflict(String),
    #[error("database error: {0}")]
    Other(sqlx::Error),
}

impl From<sqlx::Error> for DbError {
    fn from(err: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &err {
            match db.code().as_deref() {
                Some("42P01") => {
                    // Postgres says `relation "<table>" does not exist`: the
                    // table's name only, no values, so it's safe to log. It
                    // tells the owner which migration is missing.
                    eprintln!("db error: {} (apply the pending migrations)", db.message());
                    return DbError::NotMigrated;
                }
                Some("23505") => {
                    return DbError::Conflict(db.constraint().unwrap_or("unique").to_owned());
                }
                _ => {}
            }
        }
        DbError::Other(err)
    }
}

pub type Result<T> = std::result::Result<T, DbError>;

// ---------------------------------------------------------------------------
// Users

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    #[serde(skip)]
    pub google_sub: String,
    pub email: String,
    pub email_verified: bool,
    pub name: String,
    pub avatar_url: String,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub last_login_at: OffsetDateTime,
    #[serde(skip)]
    pub disabled_at: Option<OffsetDateTime>,
}

const USER_COLUMNS: &str = "id, google_sub, email, email_verified, name, avatar_url, created_at, last_login_at, disabled_at";

pub async fn user_by_sub(db: impl PgExecutor<'_>, sub: &str) -> Result<Option<User>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {USER_COLUMNS} FROM users WHERE google_sub = $1"
    ))
    .bind(sub)
    .fetch_optional(db)
    .await?)
}

pub async fn user_by_id(db: impl PgExecutor<'_>, id: Uuid) -> Result<Option<User>> {
    Ok(
        sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1"))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

pub async fn count_users(db: impl PgExecutor<'_>) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(db)
        .await?)
}

/// Inserts a new account, or refreshes an existing one's email, name and
/// avatar from Google. Matched on `sub`, never email.
pub async fn upsert_user(
    db: impl PgExecutor<'_>,
    sub: &str,
    email: &str,
    name: &str,
    avatar_url: &str,
) -> Result<User> {
    Ok(sqlx::query_as(&format!(
        "INSERT INTO users (google_sub, email, email_verified, name, avatar_url)
         VALUES ($1, $2, TRUE, $3, $4)
         ON CONFLICT (google_sub) DO UPDATE
           SET email = EXCLUDED.email, email_verified = TRUE, name = EXCLUDED.name,
               avatar_url = EXCLUDED.avatar_url, last_login_at = now()
         RETURNING {USER_COLUMNS}"
    ))
    .bind(sub)
    .bind(email)
    .bind(name)
    .bind(avatar_url)
    .fetch_one(db)
    .await?)
}

/// Locks the user's row for the rest of the transaction, so concurrent
/// uploads by one user see each other's quota use.
pub async fn lock_user(tx: &mut Tx<'_>, id: Uuid) -> Result<()> {
    sqlx::query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Hard delete. Every other table cascades; the resumes trigger queues the
/// files for deletion. Returns the object keys queued.
pub async fn delete_user(tx: &mut Tx<'_>, id: Uuid) -> Result<Vec<String>> {
    let keys: Vec<String> = sqlx::query_scalar("SELECT object_key FROM resumes WHERE user_id = $1")
        .bind(id)
        .fetch_all(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(keys)
}

// ---------------------------------------------------------------------------
// Sessions

#[derive(Debug, Clone, FromRow)]
pub struct Session {
    pub user_id: Uuid,
    pub created_at: OffsetDateTime,
    pub last_seen_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub absolute_expires_at: OffsetDateTime,
}

pub async fn create_session(
    db: impl PgExecutor<'_>,
    id_hash: &[u8; 32],
    user_id: Uuid,
    expires_at: OffsetDateTime,
    absolute_expires_at: OffsetDateTime,
    user_agent: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO sessions (id_hash, user_id, expires_at, absolute_expires_at, user_agent)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&id_hash[..])
    .bind(user_id)
    .bind(expires_at)
    .bind(absolute_expires_at)
    .bind(user_agent)
    .execute(db)
    .await?;
    Ok(())
}

/// Keeps a user's newest `keep` sessions and deletes the rest.
pub async fn trim_sessions(db: impl PgExecutor<'_>, user_id: Uuid, keep: i64) -> Result<u64> {
    Ok(sqlx::query(
        "DELETE FROM sessions WHERE user_id = $1 AND id_hash NOT IN (
           SELECT id_hash FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)",
    )
    .bind(user_id)
    .bind(keep)
    .execute(db)
    .await?
    .rows_affected())
}

/// A live session and its user. Expired sessions and disabled users aren't
/// returned.
pub async fn session_user(
    db: impl PgExecutor<'_>,
    id_hash: &[u8; 32],
) -> Result<Option<(Session, User)>> {
    #[derive(FromRow)]
    struct Row {
        s_created_at: OffsetDateTime,
        s_last_seen_at: OffsetDateTime,
        s_expires_at: OffsetDateTime,
        s_absolute_expires_at: OffsetDateTime,
        #[sqlx(flatten)]
        user: User,
    }
    let row: Option<Row> = sqlx::query_as(
        "SELECT s.created_at AS s_created_at, s.last_seen_at AS s_last_seen_at, s.expires_at AS s_expires_at,
                s.absolute_expires_at AS s_absolute_expires_at,
                u.id, u.google_sub, u.email, u.email_verified, u.name, u.avatar_url,
                u.created_at, u.last_login_at, u.disabled_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = $1 AND s.expires_at > now() AND s.absolute_expires_at > now()
           AND u.disabled_at IS NULL",
    )
    .bind(&id_hash[..])
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| {
        let session = Session {
            user_id: r.user.id,
            created_at: r.s_created_at,
            last_seen_at: r.s_last_seen_at,
            expires_at: r.s_expires_at,
            absolute_expires_at: r.s_absolute_expires_at,
        };
        (session, r.user)
    }))
}

pub async fn touch_session(
    db: impl PgExecutor<'_>,
    id_hash: &[u8; 32],
    expires_at: OffsetDateTime,
) -> Result<()> {
    sqlx::query("UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id_hash = $1")
        .bind(&id_hash[..])
        .bind(expires_at)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_session(db: impl PgExecutor<'_>, id_hash: &[u8; 32]) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE id_hash = $1")
        .bind(&id_hash[..])
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_user_sessions(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<u64> {
    Ok(sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected())
}

// ---------------------------------------------------------------------------
// API tokens (the autofill extension)

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiToken {
    pub id: Uuid,
    #[serde(rename = "prefix")]
    pub token_prefix: String,
    pub label: String,
    pub scopes: Vec<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub last_used_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub expires_at: Option<OffsetDateTime>,
}

const TOKEN_COLUMNS: &str = "id, token_prefix, label, scopes, created_at, last_used_at, expires_at";

pub async fn list_tokens(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<Vec<ApiToken>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {TOKEN_COLUMNS} FROM api_tokens
         WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
         ORDER BY created_at DESC"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

pub async fn create_token(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    hash: &[u8; 32],
    prefix: &str,
    label: &str,
    expires_at: Option<OffsetDateTime>,
) -> Result<ApiToken> {
    Ok(sqlx::query_as(&format!(
        "INSERT INTO api_tokens (user_id, token_hash, token_prefix, label, scopes, expires_at)
         VALUES ($1, $2, $3, $4, '{{autofill}}', $5) RETURNING {TOKEN_COLUMNS}"
    ))
    .bind(user_id)
    .bind(&hash[..])
    .bind(prefix)
    .bind(label)
    .bind(expires_at)
    .fetch_one(db)
    .await?)
}

pub async fn revoke_token(db: impl PgExecutor<'_>, user_id: Uuid, id: Uuid) -> Result<bool> {
    Ok(sqlx::query("UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
        .bind(id)
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected()
        == 1)
}

/// The user behind a live token with `scope`, plus the token id and when it
/// was last used.
pub async fn token_user(
    db: impl PgExecutor<'_>,
    hash: &[u8; 32],
    scope: &str,
) -> Result<Option<(Uuid, Option<OffsetDateTime>, User)>> {
    #[derive(FromRow)]
    struct Row {
        token_id: Uuid,
        token_last_used_at: Option<OffsetDateTime>,
        #[sqlx(flatten)]
        user: User,
    }
    let row: Option<Row> = sqlx::query_as(
        "SELECT t.id AS token_id, t.last_used_at AS token_last_used_at,
                u.id, u.google_sub, u.email, u.email_verified, u.name, u.avatar_url,
                u.created_at, u.last_login_at, u.disabled_at
         FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND $2 = ANY (t.scopes)
           AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.disabled_at IS NULL",
    )
    .bind(&hash[..])
    .bind(scope)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| (r.token_id, r.token_last_used_at, r.user)))
}

pub async fn touch_token(db: impl PgExecutor<'_>, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Resumes

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub id: Uuid,
    pub title: String,
    pub tags: Vec<String>,
    pub is_default: bool,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: i32,
    #[serde(skip)]
    pub object_key: String,
    #[serde(skip)]
    pub status: String,
    pub parse_status: String,
    #[serde(skip)]
    pub parse_version: i16,
    #[serde(skip)]
    pub parsed: Option<Vec<u8>>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    /// SHA-256 of the file, hex. The LaTeX editor sends it back as `If-Match`.
    pub file_sha256: String,
    /// Made in the LaTeX editor: the source can be opened again.
    pub has_source: bool,
    /// The source changed after the PDF was last compiled from it.
    pub source_stale: bool,
}

const RESUME_COLUMNS: &str =
    "id, title, tags, is_default, file_name, mime_type, size_bytes, object_key, status,
     parse_status, parse_version, parsed, created_at, updated_at,
     encode(sha256, 'hex') AS file_sha256,
     EXISTS (SELECT 1 FROM resume_sources s WHERE s.resume_id = resumes.id) AS has_source,
     COALESCE((SELECT s.compiled_sha256 IS DISTINCT FROM encode(resumes.sha256, 'hex')
               FROM resume_sources s WHERE s.resume_id = resumes.id), FALSE) AS source_stale";

/// Stored resumes, default first, then newest.
pub async fn list_resumes(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<Vec<Resume>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {RESUME_COLUMNS} FROM resumes WHERE user_id = $1 AND status = 'stored'
         ORDER BY is_default DESC, created_at DESC"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

pub async fn get_resume(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<Resume>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {RESUME_COLUMNS} FROM resumes WHERE id = $1 AND user_id = $2 AND status = 'stored'"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

#[derive(Debug, Clone, Copy, FromRow)]
pub struct ResumeUsage {
    pub count: i64,
    pub bytes: i64,
}

/// Counts every row, including ones still uploading, so concurrent uploads
/// can't slip past the limits.
pub async fn resume_usage(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<ResumeUsage> {
    Ok(sqlx::query_as(
        "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0)::BIGINT AS bytes FROM resumes WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_one(db)
    .await?)
}

/// Resume bytes across every user: the global storage budget.
pub async fn total_resume_bytes(db: impl PgExecutor<'_>) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COALESCE(SUM(size_bytes), 0)::BIGINT FROM resumes")
            .fetch_one(db)
            .await?,
    )
}

pub struct NewResume<'a> {
    pub user_id: Uuid,
    pub title: &'a str,
    pub tags: &'a [String],
    pub is_default: bool,
    pub file_name: &'a str,
    pub mime_type: &'a str,
    pub size_bytes: i32,
    pub sha256: &'a [u8; 32],
    pub object_key: &'a str,
}

/// Inserts the row as `uploading`. A second copy of the same file for the
/// same user fails with `Conflict`.
pub async fn insert_resume(db: impl PgExecutor<'_>, r: &NewResume<'_>) -> Result<Uuid> {
    Ok(sqlx::query_scalar(
        "INSERT INTO resumes (user_id, title, tags, is_default, file_name, mime_type, size_bytes, sha256, object_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(r.user_id)
    .bind(r.title)
    .bind(r.tags)
    .bind(r.is_default)
    .bind(r.file_name)
    .bind(r.mime_type)
    .bind(r.size_bytes)
    .bind(&r.sha256[..])
    .bind(r.object_key)
    .fetch_one(db)
    .await?)
}

/// The id of a resume with the same content, if the user already has one.
pub async fn resume_by_sha(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    sha256: &[u8; 32],
) -> Result<Option<Uuid>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM resumes WHERE user_id = $1 AND sha256 = $2")
            .bind(user_id)
            .bind(&sha256[..])
            .fetch_optional(db)
            .await?,
    )
}

pub async fn mark_resume_stored(db: impl PgExecutor<'_>, user_id: Uuid, id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE resumes SET status = 'stored', updated_at = now() WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn set_resume_parse(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    id: Uuid,
    status: &str,
    version: i16,
    parsed: Option<&[u8]>,
) -> Result<()> {
    sqlx::query(
        "UPDATE resumes SET parse_status = $3, parse_version = $4, parsed = $5, updated_at = now()
         WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .bind(status)
    .bind(version)
    .bind(parsed)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn update_resume_meta(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    id: Uuid,
    title: Option<&str>,
    tags: Option<&[String]>,
) -> Result<bool> {
    Ok(sqlx::query(
        "UPDATE resumes SET title = COALESCE($3, title), tags = COALESCE($4, tags), updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'stored'",
    )
    .bind(id)
    .bind(user_id)
    .bind(title)
    .bind(tags)
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

/// Makes `id` the user's only default resume.
pub async fn set_default_resume(tx: &mut Tx<'_>, user_id: Uuid, id: Uuid) -> Result<bool> {
    let exists: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM resumes WHERE id = $1 AND user_id = $2 AND status = 'stored'",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Ok(false);
    }
    sqlx::query(
        "UPDATE resumes SET is_default = FALSE WHERE user_id = $1 AND is_default AND id <> $2",
    )
    .bind(user_id)
    .bind(id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE resumes SET is_default = TRUE, updated_at = now() WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    Ok(true)
}

/// Deletes the row (the trigger queues its file) and, if it was the default,
/// makes the newest remaining resume the default. Returns the object key.
pub async fn delete_resume(tx: &mut Tx<'_>, user_id: Uuid, id: Uuid) -> Result<Option<String>> {
    let gone: Option<(String, bool)> = sqlx::query_as(
        "DELETE FROM resumes WHERE id = $1 AND user_id = $2 RETURNING object_key, is_default",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((key, was_default)) = gone else {
        return Ok(None);
    };
    if was_default {
        sqlx::query(
            "UPDATE resumes SET is_default = TRUE WHERE id = (
               SELECT id FROM resumes WHERE user_id = $1 AND status = 'stored' ORDER BY created_at DESC LIMIT 1)",
        )
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(Some(key))
}

/// The resume row, locked for the rest of the transaction.
pub async fn lock_resume(tx: &mut Tx<'_>, user_id: Uuid, id: Uuid) -> Result<Option<Resume>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {RESUME_COLUMNS} FROM resumes WHERE id = $1 AND user_id = $2 AND status = 'stored' FOR UPDATE"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?)
}

pub struct ReplacedFile<'a> {
    pub file_name: &'a str,
    pub mime_type: &'a str,
    pub size_bytes: i32,
    pub sha256: &'a [u8; 32],
    pub object_key: &'a str,
}

/// Points the resume at a new file and clears the old parse. Only if it
/// still points at `old_key` (another save may have won). The trigger queues
/// the old object for deletion.
pub async fn replace_resume_file(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    id: Uuid,
    old_key: &str,
    f: &ReplacedFile<'_>,
) -> Result<bool> {
    Ok(sqlx::query(
        "UPDATE resumes SET file_name = $4, mime_type = $5, size_bytes = $6, sha256 = $7, object_key = $8,
                parse_status = 'pending', parse_version = 0, parsed = NULL, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND object_key = $3 AND status = 'stored'",
    )
    .bind(id)
    .bind(user_id)
    .bind(old_key)
    .bind(f.file_name)
    .bind(f.mime_type)
    .bind(f.size_bytes)
    .bind(&f.sha256[..])
    .bind(f.object_key)
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

// ---------------------------------------------------------------------------
// LaTeX sources

#[derive(Debug, Clone, FromRow)]
pub struct SourceRow {
    pub source: Vec<u8>,
    pub compiled_sha256: Option<String>,
    pub updated_at: OffsetDateTime,
}

pub async fn get_source(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    resume_id: Uuid,
) -> Result<Option<SourceRow>> {
    Ok(sqlx::query_as(
        "SELECT s.source, s.compiled_sha256, s.updated_at FROM resume_sources s
         JOIN resumes r ON r.id = s.resume_id
         WHERE s.resume_id = $1 AND r.user_id = $2 AND r.status = 'stored'",
    )
    .bind(resume_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

/// Saves the (encrypted) source. `compiled_sha256` is the hex SHA-256 of the
/// PDF compiled from it, or `None` when only the source was saved.
pub async fn put_source(
    db: impl PgExecutor<'_>,
    resume_id: Uuid,
    source: &[u8],
    compiled_sha256: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO resume_sources (resume_id, source, compiled_sha256) VALUES ($1, $2, $3)
         ON CONFLICT (resume_id) DO UPDATE SET source = EXCLUDED.source,
           compiled_sha256 = EXCLUDED.compiled_sha256, updated_at = now()",
    )
    .bind(resume_id)
    .bind(source)
    .bind(compiled_sha256)
    .execute(db)
    .await?;
    Ok(())
}

/// Deletes a row that never finished uploading (the object put failed).
pub async fn discard_upload(db: impl PgExecutor<'_>, user_id: Uuid, id: Uuid) -> Result<()> {
    sqlx::query("DELETE FROM resumes WHERE id = $1 AND user_id = $2 AND status = 'uploading'")
        .bind(id)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Profiles

#[derive(Debug, Clone, FromRow)]
pub struct ProfileRow {
    pub data: Vec<u8>,
    pub sources: serde_json::Value,
    pub version: i32,
    pub updated_at: OffsetDateTime,
}

pub async fn get_profile(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<Option<ProfileRow>> {
    Ok(
        sqlx::query_as(
            "SELECT data, sources, version, updated_at FROM profiles WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_optional(db)
        .await?,
    )
}

/// Writes the profile if its stored version is still `expected` (0 = no row
/// yet). Returns the new version, or `None` when someone else wrote first.
pub async fn save_profile(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    expected: i32,
    data: &[u8],
    sources: &serde_json::Value,
) -> Result<Option<i32>> {
    let version: Option<i32> = if expected == 0 {
        sqlx::query_scalar(
            "INSERT INTO profiles (user_id, data, sources, version) VALUES ($1, $2, $3, 1)
             ON CONFLICT (user_id) DO NOTHING RETURNING version",
        )
        .bind(user_id)
        .bind(data)
        .bind(sources)
        .fetch_optional(db)
        .await?
    } else {
        sqlx::query_scalar(
            "UPDATE profiles SET data = $3, sources = $4, version = version + 1, updated_at = now()
             WHERE user_id = $1 AND version = $2 RETURNING version",
        )
        .bind(user_id)
        .bind(expected)
        .bind(data)
        .bind(sources)
        .fetch_optional(db)
        .await?
    };
    Ok(version)
}

// ---------------------------------------------------------------------------
// Answers

#[derive(Debug, Clone, FromRow)]
pub struct AnswerRow {
    pub id: Uuid,
    pub scope: String,
    pub entry: Vec<u8>,
    pub updated_at: OffsetDateTime,
}

pub async fn list_answers(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<Vec<AnswerRow>> {
    Ok(sqlx::query_as("SELECT id, scope, entry, updated_at FROM answers WHERE user_id = $1 ORDER BY updated_at DESC")
        .bind(user_id)
        .fetch_all(db)
        .await?)
}

pub async fn count_answers(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM answers WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?,
    )
}

pub async fn answer_exists(db: impl PgExecutor<'_>, user_id: Uuid, key: &[u8; 32]) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM answers WHERE user_id = $1 AND entry_key = $2)",
    )
    .bind(user_id)
    .bind(&key[..])
    .fetch_one(db)
    .await?)
}

/// Inserts or replaces the answer with this key. Returns its id and whether
/// it was new.
pub async fn upsert_answer(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    key: &[u8; 32],
    scope: &str,
    entry: &[u8],
) -> Result<(Uuid, bool)> {
    Ok(sqlx::query_as(
        "INSERT INTO answers (user_id, entry_key, scope, entry) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, entry_key) DO UPDATE SET entry = EXCLUDED.entry, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted",
    )
    .bind(user_id)
    .bind(&key[..])
    .bind(scope)
    .bind(entry)
    .fetch_one(db)
    .await?)
}

pub async fn delete_answer(db: impl PgExecutor<'_>, user_id: Uuid, id: Uuid) -> Result<bool> {
    Ok(
        sqlx::query("DELETE FROM answers WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}

// ---------------------------------------------------------------------------
// Usage counters (quotas that survive deletes)

pub async fn get_counter(
    db: impl PgExecutor<'_>,
    subject: &str,
    bucket: &str,
    period: &str,
) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT count FROM usage_counters WHERE subject = $1 AND bucket = $2 AND period = $3",
    )
    .bind(subject)
    .bind(bucket)
    .bind(period)
    .fetch_optional(db)
    .await?
    .unwrap_or(0))
}

/// Adds `by` and returns the new count.
pub async fn bump_counter(
    db: impl PgExecutor<'_>,
    subject: &str,
    bucket: &str,
    period: &str,
    by: i64,
) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "INSERT INTO usage_counters (subject, bucket, period, count) VALUES ($1, $2, $3, $4)
         ON CONFLICT (subject, bucket, period) DO UPDATE SET count = usage_counters.count + EXCLUDED.count
         RETURNING count",
    )
    .bind(subject)
    .bind(bucket)
    .bind(period)
    .bind(by)
    .fetch_one(db)
    .await?)
}

// ---------------------------------------------------------------------------
// Audit events (no personal data: an opaque id and what happened)

pub async fn audit(db: impl PgExecutor<'_>, user_id: Option<Uuid>, kind: &str) -> Result<()> {
    sqlx::query("INSERT INTO audit_events (user_id, kind) VALUES ($1, $2)")
        .bind(user_id)
        .bind(kind)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Object deletion queue

pub async fn pending_deletions(
    db: impl PgExecutor<'_>,
    keys: Option<&[String]>,
    limit: i64,
) -> Result<Vec<String>> {
    Ok(match keys {
        Some(keys) => {
            sqlx::query_scalar(
                "SELECT object_key FROM object_deletions WHERE object_key = ANY ($1) LIMIT $2",
            )
            .bind(keys)
            .bind(limit)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_scalar(
                // An hour's grace: a save reserves its new key here before
                // storing the file, and drops the reservation once the row
                // points at it.
                "SELECT object_key FROM object_deletions WHERE attempts < 20
                   AND queued_at < now() - interval '1 hour' ORDER BY queued_at LIMIT $1",
            )
            .bind(limit)
            .fetch_all(db)
            .await?
        }
    })
}

/// Marks a key about to be written, so a failed save leaves nothing behind:
/// the daily cleanup deletes it unless the save drops the reservation.
pub async fn reserve_object(db: impl PgExecutor<'_>, key: &str) -> Result<()> {
    sqlx::query("INSERT INTO object_deletions (object_key) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn deletion_done(db: impl PgExecutor<'_>, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM object_deletions WHERE object_key = $1")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn deletion_failed(db: impl PgExecutor<'_>, key: &str, error: &str) -> Result<()> {
    sqlx::query("UPDATE object_deletions SET attempts = attempts + 1, last_error = $2 WHERE object_key = $1")
        .bind(key)
        .bind(error)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Housekeeping (the daily cron)

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sweep {
    pub stuck_uploads: u64,
    pub expired_sessions: u64,
    pub old_audit_events: u64,
    pub old_counters: u64,
}

/// Removes uploads stuck for over an hour, expired sessions, audit events
/// over 90 days old, and counters from periods long past.
pub async fn sweep(db: &PgPool) -> Result<Sweep> {
    let stuck_uploads = sqlx::query(
        "DELETE FROM resumes WHERE status = 'uploading' AND created_at < now() - interval '1 hour'",
    )
    .execute(db)
    .await?
    .rows_affected();
    let expired_sessions =
        sqlx::query("DELETE FROM sessions WHERE expires_at < now() OR absolute_expires_at < now()")
            .execute(db)
            .await?
            .rows_affected();
    let old_audit_events =
        sqlx::query("DELETE FROM audit_events WHERE created_at < now() - interval '90 days'")
            .execute(db)
            .await?
            .rows_affected();
    // Daily periods ('YYYY-MM-DD') older than 31 days; monthly ones ('YYYY-MM')
    // older than 13 months. Text comparison works because both sort as dates.
    let old_counters = sqlx::query(
        "DELETE FROM usage_counters WHERE
           (length(period) = 10 AND period < to_char(now() - interval '31 days', 'YYYY-MM-DD'))
        OR (length(period) = 7  AND period < to_char(now() - interval '13 months', 'YYYY-MM'))",
    )
    .execute(db)
    .await?
    .rows_affected();
    Ok(Sweep {
        stuck_uploads,
        expired_sessions,
        old_audit_events,
        old_counters,
    })
}

// ---------------------------------------------------------------------------
// Owner usage page

#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub users: i64,
    pub users_last_30_days: i64,
    pub resumes: i64,
    pub resume_bytes: i64,
    pub answers: i64,
    pub tokens: i64,
    pub pending_deletions: i64,
    pub accounts_table_bytes: i64,
}

pub async fn usage(db: impl PgExecutor<'_>) -> Result<Usage> {
    Ok(sqlx::query_as(
        "SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM users WHERE last_login_at > now() - interval '30 days') AS users_last_30_days,
           (SELECT COUNT(*) FROM resumes) AS resumes,
           (SELECT COALESCE(SUM(size_bytes), 0)::BIGINT FROM resumes) AS resume_bytes,
           (SELECT COUNT(*) FROM answers) AS answers,
           (SELECT COUNT(*) FROM api_tokens WHERE revoked_at IS NULL) AS tokens,
           (SELECT COUNT(*) FROM object_deletions) AS pending_deletions,
           (SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::BIGINT FROM pg_class c
              WHERE c.relname IN ('users','sessions','api_tokens','resumes','profiles','answers',
                                  'usage_counters','audit_events','object_deletions',
                                  'resume_sources')) AS accounts_table_bytes",
    )
    .fetch_one(db)
    .await?)
}
