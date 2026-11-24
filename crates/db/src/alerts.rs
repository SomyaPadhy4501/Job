//! Job alerts and the public `jobs` table they match against
//! (`migrations/007_alerts.sql`).
//!
//! Alert queries take the user's id like every other user query. The alert
//! run (`due_alerts`, `claim_alert`, `mark_sent`) works across users: only the
//! token-gated cron route calls it. `unsubscribe_email` takes an alert id
//! from a signed link instead of a session.

use serde::Serialize;
use sqlx::postgres::PgExecutor;
use sqlx::{FromRow, Postgres, QueryBuilder};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::Result;

#[derive(Debug, Clone, FromRow)]
pub struct AlertRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub spec: Vec<u8>,
    pub frequency: String,
    pub channels: Vec<String>,
    pub paused: bool,
    pub last_run_at: Option<OffsetDateTime>,
    pub last_sent_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

const ALERT_COLUMNS: &str = "id, user_id, spec, frequency, channels, paused, last_run_at, last_sent_at, created_at, updated_at";

pub async fn list_alerts(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<Vec<AlertRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {ALERT_COLUMNS} FROM job_alerts WHERE user_id = $1 ORDER BY created_at"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await?)
}

pub async fn get_alert(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<AlertRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {ALERT_COLUMNS} FROM job_alerts WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await?)
}

pub async fn count_alerts(db: impl PgExecutor<'_>, user_id: Uuid) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM job_alerts WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(db)
            .await?,
    )
}

pub struct AlertWrite<'a> {
    pub spec: &'a [u8],
    pub frequency: &'a str,
    pub channels: &'a [String],
    pub paused: bool,
}

pub async fn insert_alert(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    a: &AlertWrite<'_>,
) -> Result<AlertRow> {
    Ok(sqlx::query_as(&format!(
        "INSERT INTO job_alerts (user_id, spec, frequency, channels, paused)
         VALUES ($1, $2, $3, $4, $5) RETURNING {ALERT_COLUMNS}"
    ))
    .bind(user_id)
    .bind(a.spec)
    .bind(a.frequency)
    .bind(a.channels)
    .bind(a.paused)
    .fetch_one(db)
    .await?)
}

pub async fn update_alert(
    db: impl PgExecutor<'_>,
    user_id: Uuid,
    id: Uuid,
    a: &AlertWrite<'_>,
) -> Result<Option<AlertRow>> {
    Ok(sqlx::query_as(&format!(
        "UPDATE job_alerts SET spec = $3, frequency = $4, channels = $5, paused = $6, updated_at = now()
         WHERE id = $1 AND user_id = $2 RETURNING {ALERT_COLUMNS}"
    ))
    .bind(id)
    .bind(user_id)
    .bind(a.spec)
    .bind(a.frequency)
    .bind(a.channels)
    .bind(a.paused)
    .fetch_optional(db)
    .await?)
}

pub async fn delete_alert(db: impl PgExecutor<'_>, user_id: Uuid, id: Uuid) -> Result<bool> {
    Ok(
        sqlx::query("DELETE FROM job_alerts WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}

/// Pauses or resumes every alert of the user. Returns how many changed.
pub async fn set_all_paused(db: impl PgExecutor<'_>, user_id: Uuid, paused: bool) -> Result<u64> {
    Ok(sqlx::query(
        "UPDATE job_alerts SET paused = $2, updated_at = now() WHERE user_id = $1 AND paused <> $2",
    )
    .bind(user_id)
    .bind(paused)
    .execute(db)
    .await?
    .rows_affected())
}

/// Turns email off for one alert: what an unsubscribe link does. The id
/// comes from a signed link, so no user id is needed.
pub async fn unsubscribe_email(db: impl PgExecutor<'_>, id: Uuid) -> Result<bool> {
    Ok(sqlx::query(
        "UPDATE job_alerts SET channels = array_remove(channels, 'email'), updated_at = now()
         WHERE id = $1 AND 'email' = ANY (channels)",
    )
    .bind(id)
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

// Instant alerts run after every collect; daily and weekly ones once their
// period has (nearly) passed. The slack keeps a 3-hourly collect from pushing
// a daily digest to every 27 hours.
const DUE: &str = "NOT a.paused AND cardinality(a.channels) > 0 AND u.disabled_at IS NULL AND (
       a.frequency = 'instant'
    OR a.last_run_at IS NULL
    OR (a.frequency = 'daily'  AND a.last_run_at < now() - interval '20 hours')
    OR (a.frequency = 'weekly' AND a.last_run_at < now() - interval '6 days 20 hours'))";

/// Alerts due to run, with their owner's email, longest-waiting first.
pub async fn due_alerts(db: impl PgExecutor<'_>, limit: i64) -> Result<Vec<(AlertRow, String)>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        alert: AlertRow,
        email: String,
    }
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT a.id, a.user_id, a.spec, a.frequency, a.channels, a.paused, a.last_run_at,
                a.last_sent_at, a.created_at, a.updated_at, u.email
         FROM job_alerts a JOIN users u ON u.id = a.user_id
         WHERE {DUE} ORDER BY a.last_run_at NULLS FIRST, a.created_at LIMIT $1"
    ))
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.alert, r.email)).collect())
}

pub async fn count_due(db: impl PgExecutor<'_>) -> Result<i64> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM job_alerts a JOIN users u ON u.id = a.user_id WHERE {DUE}"
    ))
    .fetch_one(db)
    .await?)
}

/// Takes the alert for this run: moves its watermark to `now` only if no
/// other run moved it first. Two overlapping runs can't both send it.
pub async fn claim_alert(
    db: impl PgExecutor<'_>,
    id: Uuid,
    seen_last_run: Option<OffsetDateTime>,
    now: OffsetDateTime,
) -> Result<bool> {
    Ok(sqlx::query(
        "UPDATE job_alerts SET last_run_at = $3 WHERE id = $1 AND last_run_at IS NOT DISTINCT FROM $2",
    )
    .bind(id)
    .bind(seen_last_run)
    .bind(now)
    .execute(db)
    .await?
    .rows_affected()
        == 1)
}

/// Gives a claimed alert its old watermark back (nothing could be sent), so
/// the next run looks at the same jobs again.
pub async fn unclaim_alert(
    db: impl PgExecutor<'_>,
    id: Uuid,
    claimed_at: OffsetDateTime,
    old: Option<OffsetDateTime>,
) -> Result<()> {
    sqlx::query("UPDATE job_alerts SET last_run_at = $3 WHERE id = $1 AND last_run_at = $2")
        .bind(id)
        .bind(claimed_at)
        .bind(old)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn mark_sent(db: impl PgExecutor<'_>, alert_id: Uuid, job_ids: &[i32]) -> Result<()> {
    sqlx::query(
        "WITH s AS (INSERT INTO alert_sent_jobs (alert_id, job_id)
                    SELECT $1, unnest($2::INTEGER[]) ON CONFLICT DO NOTHING)
         UPDATE job_alerts SET last_sent_at = now() WHERE id = $1",
    )
    .bind(alert_id)
    .bind(job_ids)
    .execute(db)
    .await?;
    Ok(())
}

/// Forgets sent jobs after 30 days: they have left the board by then.
pub async fn prune_sent(db: impl PgExecutor<'_>) -> Result<u64> {
    Ok(
        sqlx::query("DELETE FROM alert_sent_jobs WHERE sent_at < now() - interval '30 days'")
            .execute(db)
            .await?
            .rows_affected(),
    )
}

// ---------------------------------------------------------------------------
// Jobs (public data, written by the Node collectors)

#[derive(Debug, Clone, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    pub id: i32,
    pub company_name: String,
    pub job_title: String,
    pub location: Option<String>,
    pub apply_url: String,
    pub date_posted: Option<String>,
    pub sponsorship: String,
    pub role_type: String,
    pub first_seen_at: String,
}

const JOB_COLUMNS: &str = "id, company_name, job_title, location, apply_url, date_posted, sponsorship, role_type, first_seen_at";

/// The board's filters, already checked against the allowed values.
#[derive(Debug, Clone, Default)]
pub struct JobFilter {
    /// `SWE`, `MLE`, …; `None` for any.
    pub role: Option<String>,
    /// `entry`, `mid` or `early`; `None` for any.
    pub level: Option<String>,
    /// `YES`, `NO` or `UNKNOWN`; `None` for any.
    pub sponsorship: Option<String>,
    /// `hide`, `all` or `only`.
    pub restriction: String,
    /// Exact company names, any case. Empty = any company.
    pub companies: Vec<String>,
    /// Words in the title, any of them. Empty = any title.
    pub keywords: Vec<String>,
    /// Words in the location, any of them. Empty = anywhere.
    pub locations: Vec<String>,
}

/// Restrictions that bar a candidate who needs sponsorship. Must match
/// `DISQUALIFYING` in src/services/clearance.js.
pub const DISQUALIFYING: &[&str] = &[
    "CLEARANCE",
    "EXPORT_CONTROL",
    "CITIZENSHIP",
    "GOVERNMENT",
    "DEFENSE_EMPLOYER",
    "NO_SPONSORSHIP",
    "EXCLUDED_EMPLOYER",
];

fn like_pattern(word: &str) -> String {
    let escaped = word
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub struct JobQuery<'a> {
    pub filter: &'a JobFilter,
    /// Only jobs first seen after this (`YYYY-MM-DDTHH:MM:SSZ`, as stored).
    pub first_seen_after: Option<&'a str>,
    /// The board's display window: posted (or first seen) on or after this.
    pub visible_since: &'a str,
    /// Leave out jobs this alert already sent.
    pub not_sent_by: Option<Uuid>,
    pub limit: i64,
}

/// Jobs matching the filters, newest first. Same rules as `buildWhere` in
/// src/db/pg.js, plus companies, keywords and locations.
pub async fn matching_jobs(db: impl PgExecutor<'_>, q: &JobQuery<'_>) -> Result<Vec<JobRow>> {
    let f = q.filter;
    let mut b: QueryBuilder<Postgres> = QueryBuilder::new(format!(
        "SELECT {JOB_COLUMNS} FROM jobs WHERE COALESCE(date_posted, first_seen_at) >= "
    ));
    b.push_bind(q.visible_since.to_owned());
    if let Some(after) = q.first_seen_after {
        b.push(" AND first_seen_at > ").push_bind(after.to_owned());
    }
    if let Some(alert) = q.not_sent_by {
        b.push(" AND NOT EXISTS (SELECT 1 FROM alert_sent_jobs s WHERE s.alert_id = ")
            .push_bind(alert)
            .push(" AND s.job_id = jobs.id)");
    }
    if let Some(role) = &f.role {
        b.push(" AND role_type = ").push_bind(role.clone());
    }
    if let Some(s) = &f.sponsorship {
        b.push(" AND sponsorship = ").push_bind(s.clone());
    }
    match f.level.as_deref() {
        Some("entry") => {
            b.push(" AND is_entry_level = 1");
        }
        Some("mid") => {
            b.push(" AND is_mid_level = 1");
        }
        Some("early") => {
            b.push(" AND (is_entry_level = 1 OR is_mid_level = 1)");
        }
        _ => {}
    }
    let barred: Vec<String> = DISQUALIFYING.iter().map(|s| (*s).to_owned()).collect();
    match f.restriction.as_str() {
        "all" => {}
        "only" => {
            b.push(" AND restriction = ANY (")
                .push_bind(barred)
                .push(")");
        }
        // Fail closed, like the board: anything else hides barred roles.
        _ => {
            b.push(" AND NOT (restriction = ANY (")
                .push_bind(barred)
                .push("))");
        }
    }
    if !f.companies.is_empty() {
        let lower: Vec<String> = f.companies.iter().map(|c| c.to_lowercase()).collect();
        b.push(" AND LOWER(company_name) = ANY (")
            .push_bind(lower)
            .push(")");
    }
    if !f.keywords.is_empty() {
        let pats: Vec<String> = f.keywords.iter().map(|k| like_pattern(k)).collect();
        b.push(" AND LOWER(job_title) LIKE ANY (")
            .push_bind(pats)
            .push(")");
    }
    if !f.locations.is_empty() {
        let pats: Vec<String> = f.locations.iter().map(|k| like_pattern(k)).collect();
        b.push(" AND LOWER(COALESCE(location, '')) LIKE ANY (")
            .push_bind(pats)
            .push(")");
    }
    b.push(" ORDER BY first_seen_at DESC, id DESC LIMIT ")
        .push_bind(q.limit);
    Ok(b.build_query_as().fetch_all(db).await?)
}

pub async fn job_by_id(db: impl PgExecutor<'_>, id: i32) -> Result<Option<JobRow>> {
    Ok(
        sqlx::query_as(&format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = $1"))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

/// The newest job with this apply link (a link can be re-listed).
pub async fn job_by_url(db: impl PgExecutor<'_>, url: &str) -> Result<Option<JobRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {JOB_COLUMNS} FROM jobs WHERE apply_url = $1 ORDER BY first_seen_at DESC LIMIT 1"
    ))
    .bind(url)
    .fetch_optional(db)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_patterns_escape_wildcards() {
        assert_eq!(like_pattern("Backend"), "%backend%");
        assert_eq!(like_pattern("100%_x"), "%100\\%\\_x%");
    }
}
