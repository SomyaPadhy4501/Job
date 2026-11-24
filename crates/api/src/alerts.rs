//! Saved job alerts: the signed-in user's searches, and the run that sends
//! their new matches to the user's linked Telegram chat.
//!
//! - `/api/me/alerts*` (cookie): list, create, edit, delete, preview. Making
//!   an alert needs a linked Telegram chat, so no alert sends nowhere.
//! - `POST /api/cron/alerts` (`Authorization: Bearer $CRON_SECRET`): called
//!   by GitHub Actions after each collect. Sends each due alert the jobs it
//!   hasn't sent yet, at most [`MAX_CHAT_JOBS`] per message.
//!
//! An alert's name and filters are encrypted; only this module reads them.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use accounts::crypto::Field;
use accounts::token::ct_eq;
use db::alerts::{AlertRow, AlertWrite, JobFilter, JobQuery, JobRow};

use crate::AppState;
use crate::auth::Signed;
use crate::error::{ApiError, ApiResult};
use crate::http::{JsonBody, parse_id};
use crate::notify::{self, Sent};

pub const MAX_ALERTS: i64 = 10;
/// Jobs in one chat message (Telegram caps a message at 4,096 characters);
/// more are summed up as a link to the board.
pub const MAX_CHAT_JOBS: usize = 10;
/// Alerts one cron call handles; the caller calls again while some remain.
/// Small, so a call ends well inside a Vercel function's time limit.
pub const RUN_BATCH: i64 = 10;
/// The board shows jobs from the last 7 days (`VISIBLE_DAYS` in collect.yml).
pub const VISIBLE_DAYS: i64 = 7;

const ROLES: &[&str] = &[
    "SWE", "MLE", "AI", "DS", "DATA_ENG", "SRE", "SECURITY", "MOBILE",
];
const LEVELS: &[&str] = &["entry", "mid", "early"];
const SPONSORSHIP: &[&str] = &["YES", "NO", "UNKNOWN"];
const RESTRICTION: &[&str] = &["hide", "all", "only"];
const FREQUENCIES: &[&str] = &["instant", "daily", "weekly"];
pub const CHANNELS: &[&str] = &["telegram"];

/// The board's filters, as the web page sends them. Empty means "any".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Filters {
    pub role: String,
    pub level: String,
    /// `YES`, `NO`, `UNKNOWN`, or empty / `ANY` for any.
    pub sponsorship: String,
    pub restriction: String,
    pub companies: Vec<String>,
    pub keywords: Vec<String>,
    pub locations: Vec<String>,
}

/// What is stored encrypted for one alert.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Spec {
    pub name: String,
    pub filters: Filters,
}

fn pick(value: &str, allowed: &[&str], what: &str) -> ApiResult<String> {
    let v = value.trim();
    if v.is_empty() || allowed.iter().any(|a| a.eq_ignore_ascii_case(v)) {
        let found = allowed.iter().find(|a| a.eq_ignore_ascii_case(v));
        return Ok(found.map(|s| (*s).to_owned()).unwrap_or_default());
    }
    Err(ApiError::bad(format!("Pick a {what} from the list.")))
}

fn clean_list(items: &[String], max: usize, max_len: usize, what: &str) -> ApiResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in items {
        let v = accounts::clean_line(raw);
        if v.is_empty() {
            continue;
        }
        if v.chars().count() > max_len {
            return Err(ApiError::bad(format!(
                "Keep each {what} under {max_len} characters."
            )));
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&v)) {
            out.push(v);
        }
    }
    if out.len() > max {
        return Err(ApiError::bad(format!("Add at most {max} {what}s.")));
    }
    Ok(out)
}

impl Filters {
    /// Checks every value against the board's own lists.
    pub fn validated(&self) -> ApiResult<Filters> {
        let sponsorship = if self.sponsorship.trim().eq_ignore_ascii_case("any") {
            String::new()
        } else {
            pick(&self.sponsorship, SPONSORSHIP, "sponsorship")?
        };
        let restriction = pick(&self.restriction, RESTRICTION, "restriction")?;
        Ok(Filters {
            role: pick(&self.role, ROLES, "role")?,
            level: pick(&self.level, LEVELS, "level")?,
            sponsorship,
            restriction: if restriction.is_empty() {
                "hide".into()
            } else {
                restriction
            },
            companies: clean_list(&self.companies, 20, 80, "company")?,
            keywords: clean_list(&self.keywords, 10, 40, "keyword")?,
            locations: clean_list(&self.locations, 10, 40, "location")?,
        })
    }

    pub fn to_query(&self) -> JobFilter {
        let opt = |s: &str| (!s.is_empty()).then(|| s.to_owned());
        JobFilter {
            role: opt(&self.role),
            level: opt(&self.level),
            sponsorship: opt(&self.sponsorship),
            restriction: if self.restriction.is_empty() {
                "hide".into()
            } else {
                self.restriction.clone()
            },
            companies: self.companies.clone(),
            keywords: self.keywords.clone(),
            locations: self.locations.clone(),
        }
    }

    /// The board's default view: confirmed sponsors, barred roles hidden.
    pub fn board_default() -> Filters {
        Filters {
            sponsorship: "YES".into(),
            restriction: "hide".into(),
            ..Filters::default()
        }
    }
}

/// Stored timestamps, as the collectors write `first_seen_at`.
pub fn iso(t: OffsetDateTime) -> String {
    let t = t.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    )
}

fn rfc(t: Option<OffsetDateTime>) -> Value {
    t.and_then(|t| t.format(&Rfc3339).ok())
        .map_or(Value::Null, Value::String)
}

pub fn spec_of(state: &AppState, row: &AlertRow) -> ApiResult<Spec> {
    Ok(state
        .keyring()?
        .decrypt_json(Field::AlertSpec, &row.user_id, &row.spec)?)
}

fn alert_json(row: &AlertRow, spec: &Spec) -> Value {
    json!({
        "id": row.id,
        "name": spec.name,
        "filters": spec.filters,
        "frequency": row.frequency,
        "channels": row.channels,
        "paused": row.paused,
        "lastRunAt": rfc(row.last_run_at),
        "lastSentAt": rfc(row.last_sent_at),
        "createdAt": rfc(Some(row.created_at)),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertBody {
    #[serde(default)]
    name: String,
    #[serde(default)]
    filters: Filters,
    #[serde(default = "default_frequency")]
    frequency: String,
    #[serde(default = "default_channels")]
    channels: Vec<String>,
    #[serde(default)]
    paused: bool,
}

fn default_frequency() -> String {
    "daily".into()
}

fn default_channels() -> Vec<String> {
    vec!["telegram".into()]
}

struct Checked {
    spec: Spec,
    frequency: String,
    channels: Vec<String>,
    paused: bool,
}

fn check(body: AlertBody) -> ApiResult<Checked> {
    let name = accounts::clean_line(&body.name);
    let name = if name.is_empty() {
        "My alert".to_owned()
    } else {
        accounts::truncate_chars(&name, 60).to_owned()
    };
    let frequency = pick(&body.frequency, FREQUENCIES, "frequency")?;
    if frequency.is_empty() {
        return Err(ApiError::bad("Pick how often to send this alert."));
    }
    let mut channels: Vec<String> = Vec::new();
    for c in &body.channels {
        let c = pick(c, CHANNELS, "channel")?;
        if !c.is_empty() && !channels.contains(&c) {
            channels.push(c);
        }
    }
    Ok(Checked {
        spec: Spec {
            name,
            filters: body.filters.validated()?,
        },
        frequency,
        channels,
        paused: body.paused,
    })
}

pub async fn list(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let pool = state.pool()?;
    let user_id = signed.user.id;
    let mut alerts = Vec::new();
    for row in db::alerts::list_alerts(pool, user_id).await? {
        alerts.push(alert_json(&row, &spec_of(&state, &row)?));
    }
    let n = &state.config.notify;
    Ok(Json(json!({
        "alerts": alerts,
        "max": MAX_ALERTS,
        "telegramReady": n.telegram_ready(),
    })))
}

pub async fn create(
    State(state): State<AppState>,
    signed: Signed,
    JsonBody(body): JsonBody<AlertBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let pool = state.pool()?;
    let user_id = signed.user.id;
    let c = check(body)?;
    if db::chat::chat_link(pool, user_id, "telegram")
        .await?
        .is_none()
    {
        return Err(ApiError::bad(
            "Link Telegram first; alerts go to your Telegram chat.",
        ));
    }
    if db::alerts::count_alerts(pool, user_id).await? >= MAX_ALERTS {
        return Err(ApiError::Forbidden(format!(
            "You can have {MAX_ALERTS} alerts. Delete one first."
        )));
    }
    let spec = state
        .keyring()?
        .encrypt_json(Field::AlertSpec, &user_id, &c.spec);
    let row = db::alerts::insert_alert(
        pool,
        user_id,
        &AlertWrite {
            spec: &spec,
            frequency: &c.frequency,
            channels: &c.channels,
            paused: c.paused,
        },
    )
    .await?;
    db::audit(pool, Some(user_id), "alert_create").await?;
    Ok((StatusCode::CREATED, Json(alert_json(&row, &c.spec))))
}

pub async fn update(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<AlertBody>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let pool = state.pool()?;
    let user_id = signed.user.id;
    let c = check(body)?;
    let spec = state
        .keyring()?
        .encrypt_json(Field::AlertSpec, &user_id, &c.spec);
    let row = db::alerts::update_alert(
        pool,
        user_id,
        id,
        &AlertWrite {
            spec: &spec,
            frequency: &c.frequency,
            channels: &c.channels,
            paused: c.paused,
        },
    )
    .await?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(alert_json(&row, &c.spec)))
}

pub async fn remove(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    let pool = state.pool()?;
    if !db::alerts::delete_alert(pool, signed.user.id, id).await? {
        return Err(ApiError::NotFound);
    }
    db::audit(pool, Some(signed.user.id), "alert_delete").await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The newest jobs on the board matching these filters, sent or not.
pub async fn newest(state: &AppState, filters: &Filters, limit: i64) -> ApiResult<Vec<JobRow>> {
    let visible = iso(OffsetDateTime::now_utc() - Duration::days(VISIBLE_DAYS));
    Ok(db::alerts::matching_jobs(
        state.pool()?,
        &JobQuery {
            filter: &filters.to_query(),
            first_seen_after: None,
            visible_since: &visible,
            not_sent_by: None,
            limit,
        },
    )
    .await?)
}

/// What an alert would match on the board right now.
pub async fn preview(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let row = db::alerts::get_alert(state.pool()?, signed.user.id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let spec = spec_of(&state, &row)?;
    let jobs = newest(&state, &spec.filters, 10).await?;
    Ok(Json(json!({ "jobs": jobs })))
}

// ---------------------------------------------------------------------------
// The alert run

/// Only web links go into a message; anything else becomes the board.
pub fn safe_url<'a>(url: &'a str, fallback: &'a str) -> &'a str {
    if url.starts_with("https://") || url.starts_with("http://") {
        url
    } else {
        fallback
    }
}

fn job_line(job: &JobRow) -> String {
    match job
        .location
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        Some(loc) => format!("{} — {} · {}", job.company_name, job.job_title, loc),
        None => format!("{} — {}", job.company_name, job.job_title),
    }
}

/// The chat message for one alert, plain text.
pub fn render_chat(site: &str, name: &str, jobs: &[JobRow], more: bool) -> String {
    let mut text = format!("New jobs for “{name}”:\n");
    for job in jobs.iter().take(MAX_CHAT_JOBS) {
        text.push_str(&format!(
            "\n#{} {}\n{}\n",
            job.id,
            job_line(job),
            safe_url(&job.apply_url, site)
        ));
    }
    if more || jobs.len() > MAX_CHAT_JOBS {
        text.push_str(&format!("\nMore on the board: {site}/\n"));
    }
    text.push_str("\nSend /apply <number> to add one to your apply queue.");
    text
}

/// Checks `Authorization: Bearer $CRON_SECRET`. Without a secret the route
/// doesn't exist.
pub fn require_cron(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
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
    Ok(())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStats {
    pub processed: u32,
    pub nothing_new: u32,
    pub chats: u32,
    /// Matches kept for the next run: no linked chat could take them.
    pub held: u32,
    pub remaining: i64,
}

async fn run_one(
    state: &AppState,
    row: &AlertRow,
    now: OffsetDateTime,
    stats: &mut RunStats,
) -> ApiResult<()> {
    let pool = state.pool()?;
    if !db::alerts::claim_alert(pool, row.id, row.last_run_at, now).await? {
        return Ok(()); // another run took it
    }
    stats.processed += 1;
    let spec = spec_of(state, row)?;
    // New since the alert was made (a day's grace, so the first send isn't
    // empty), never older than the sent-jobs memory (30 days).
    let after = (row.created_at - Duration::days(1)).max(now - Duration::days(25));
    let visible = iso(now - Duration::days(VISIBLE_DAYS));
    let mut jobs = db::alerts::matching_jobs(
        pool,
        &JobQuery {
            filter: &spec.filters.to_query(),
            first_seen_after: Some(&iso(after)),
            visible_since: &visible,
            not_sent_by: Some(row.id),
            limit: MAX_CHAT_JOBS as i64 + 1,
        },
    )
    .await?;
    if jobs.is_empty() {
        stats.nothing_new += 1;
        return Ok(());
    }
    let more = jobs.len() > MAX_CHAT_JOBS;
    jobs.truncate(MAX_CHAT_JOBS);
    let site = state.config.notify.site_url.clone();
    let mut sent: Vec<i32> = Vec::new();

    if row.channels.iter().any(|c| c == "telegram")
        && let Some(chat_id) = crate::chat::address_of(state, row.user_id, "telegram").await?
    {
        let text = render_chat(&site, &spec.name, &jobs, more);
        if notify::send_telegram(state, &chat_id, &text).await == Sent::Yes {
            stats.chats += 1;
            sent.extend(jobs.iter().map(|j| j.id));
        }
    }

    if sent.is_empty() {
        stats.held += 1;
    } else {
        db::alerts::mark_sent(pool, row.id, &sent).await?;
    }
    Ok(())
}

/// `POST /api/cron/alerts`: one batch of due alerts. `remaining` says how
/// many are still due; the caller waits 30 s and calls again.
pub async fn run(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<RunStats>> {
    require_cron(&state, &headers)?;
    let pool = state.pool()?;
    let now = OffsetDateTime::now_utc();
    db::alerts::prune_sent(pool).await?;
    let mut stats = RunStats::default();
    for row in db::alerts::due_alerts(pool, RUN_BATCH).await? {
        // One alert's failure (a key that can't decrypt it) doesn't stop the rest.
        if let Err(e) = run_one(&state, &row, now, &mut stats).await {
            eprintln!("alerts: alert run failed: {e:?}");
        }
    }
    stats.remaining = db::alerts::count_due(pool).await?;
    Ok(Json(stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: i32, url: &str) -> JobRow {
        JobRow {
            id,
            company_name: "Acme <Inc>".into(),
            job_title: "Backend Engineer".into(),
            location: Some("Boston, MA".into()),
            apply_url: url.into(),
            date_posted: None,
            sponsorship: "YES".into(),
            role_type: "SWE".into(),
            first_seen_at: "2026-11-24T00:00:00Z".into(),
        }
    }

    #[test]
    fn filters_accept_only_the_boards_values() {
        let f = Filters {
            role: "swe".into(),
            sponsorship: "any".into(),
            keywords: vec![" Backend ".into(), "backend".into(), "".into()],
            ..Filters::default()
        }
        .validated()
        .unwrap();
        assert_eq!(f.role, "SWE");
        assert_eq!(f.sponsorship, "");
        assert_eq!(f.restriction, "hide", "barred roles hidden by default");
        assert_eq!(f.keywords, vec!["Backend"]);
        let bad = Filters {
            level: "senior".into(),
            ..Filters::default()
        };
        assert!(bad.validated().is_err());
        let many = Filters {
            keywords: (0..11).map(|i| format!("k{i}")).collect(),
            ..Filters::default()
        };
        assert!(many.validated().is_err());
    }

    #[test]
    fn iso_matches_the_collectors_format() {
        let t = OffsetDateTime::from_unix_timestamp(1_764_000_000).unwrap();
        assert_eq!(iso(t), "2025-11-24T16:00:00Z");
    }

    #[test]
    fn chat_message_is_short_and_numbered() {
        let jobs: Vec<JobRow> = (1..=12).map(|i| job(i, "https://jobs.example/x")).collect();
        let text = render_chat("https://site.example", "SWE", &jobs, false);
        assert!(text.contains("#1 Acme <Inc> — Backend Engineer · Boston, MA"));
        assert!(!text.contains("#11 "), "at most {MAX_CHAT_JOBS} jobs");
        assert!(text.contains("More on the board"));
        assert!(text.len() < 4096);
    }
}
