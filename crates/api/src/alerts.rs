//! Saved job alerts: the signed-in user's searches, and the run that sends
//! their new matches by email (Resend) and Telegram.
//!
//! - `/api/me/alerts*` (cookie): list, create, edit, delete, preview.
//! - `POST /api/cron/alerts` (`Authorization: Bearer $CRON_SECRET`): called
//!   by GitHub Actions after each collect. Sends each due alert the jobs it
//!   hasn't sent yet, at most [`MAX_EMAIL_JOBS`] per email.
//! - `/api/alerts/unsubscribe?t=…`: a signed link in every email. GET shows a
//!   button, POST turns the alert's email off (also what Gmail's one-click
//!   `List-Unsubscribe-Post` sends). No sign-in needed.
//!
//! An alert's name and filters are encrypted; only this module reads them.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use accounts::crypto::Field;
use accounts::token::{ct_eq, hex, hmac_sha256};
use db::alerts::{AlertRow, AlertWrite, JobFilter, JobQuery, JobRow};

use crate::AppState;
use crate::auth::Signed;
use crate::error::{ApiError, ApiResult};
use crate::http::{JsonBody, parse_id, this_month, today};
use crate::notify::{self, Email, Sent};

pub const MAX_ALERTS: i64 = 10;
/// Jobs in one email; more are summed up as "and N more".
pub const MAX_EMAIL_JOBS: usize = 25;
/// Jobs in one chat message (Telegram caps a message at 4,096 characters).
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
pub const CHANNELS: &[&str] = &["email", "telegram"];

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
    vec!["email".into()]
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
        "emailReady": n.email_ready(),
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
// Unsubscribe links

fn unsubscribe_key(state: &AppState) -> ApiResult<[u8; 32]> {
    Ok(state.keyring()?.derive("alert-unsubscribe/v1"))
}

/// `hex(alert id) + hex(first 16 bytes of HMAC)`: 64 characters, no expiry.
pub fn unsubscribe_token(state: &AppState, alert_id: Uuid) -> ApiResult<String> {
    let mac = hmac_sha256(&unsubscribe_key(state)?, alert_id.as_bytes());
    Ok(format!("{}{}", alert_id.simple(), hex(&mac[..16])))
}

fn alert_of_token(state: &AppState, token: &str) -> ApiResult<Uuid> {
    let token = token.trim();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::NotFound);
    }
    let id = Uuid::parse_str(&token[..32]).map_err(|_| ApiError::NotFound)?;
    let want = unsubscribe_token(state, id)?;
    if !ct_eq(want.as_bytes(), token.to_ascii_lowercase().as_bytes()) {
        return Err(ApiError::NotFound);
    }
    Ok(id)
}

pub fn unsubscribe_url(state: &AppState, alert_id: Uuid) -> ApiResult<String> {
    Ok(format!(
        "{}/api/alerts/unsubscribe?t={}",
        state.config.notify.site_url,
        unsubscribe_token(state, alert_id)?
    ))
}

#[derive(Deserialize)]
pub struct TokenQuery {
    #[serde(default)]
    t: String,
}

fn page(title: &str, body: &str) -> Response {
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>{title}</title>\
         <style>body{{font:16px/1.5 system-ui,sans-serif;color:#18191c;max-width:32rem;margin:3rem auto;padding:0 1rem}}\
         button{{font:inherit;background:#0a65cc;color:#fff;border:0;border-radius:6px;padding:.6rem 1.1rem;cursor:pointer}}\
         a{{color:#0a65cc}}</style></head><body>{body}</body></html>"
    ))
    .into_response()
}

/// GET: a button, so a mail scanner opening the link changes nothing.
pub async fn unsubscribe_page(
    State(state): State<AppState>,
    Query(q): Query<TokenQuery>,
) -> Response {
    if alert_of_token(&state, &q.t).is_err() {
        return page(
            "Link not valid",
            "<h1>This link isn’t valid</h1><p>Turn alerts off on the Alerts page instead.</p>",
        );
    }
    let site = esc(&state.config.notify.site_url);
    page(
        "Stop these emails",
        &format!(
            "<h1>Stop emails for this alert?</h1>\
             <form method=\"post\"><button type=\"submit\">Stop these emails</button></form>\
             <p>You can turn it back on from <a href=\"{site}/alerts\">your alerts</a>.</p>"
        ),
    )
}

/// POST: turns email off for the alert. Gmail's one-click sends this too.
pub async fn unsubscribe(State(state): State<AppState>, Query(q): Query<TokenQuery>) -> Response {
    let id = match alert_of_token(&state, &q.t) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let pool = match state.pool() {
        Ok(p) => p,
        Err(e) => return e.into_response(),
    };
    match db::alerts::unsubscribe_email(pool, id).await {
        Ok(_) => {
            let site = esc(&state.config.notify.site_url);
            page(
                "Emails stopped",
                &format!(
                    "<h1>Done. No more emails for this alert.</h1>\
                     <p>Change your alerts any time on <a href=\"{site}/alerts\">the Alerts page</a>.</p>"
                ),
            )
        }
        Err(e) => ApiError::from(e).into_response(),
    }
}

// ---------------------------------------------------------------------------
// The alert run

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

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

fn company_line(job: &JobRow) -> String {
    match job
        .location
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        Some(loc) => format!("{} · {}", job.company_name, loc),
        None => job.company_name.clone(),
    }
}

fn subject(name: &str, n: usize, more: bool) -> String {
    let count = if more { format!("{n}+") } else { n.to_string() };
    let noun = if n == 1 && !more { "job" } else { "jobs" };
    format!("{count} new {noun}: {name}")
}

/// The email for one alert: HTML and plain text, both with the unsubscribe link.
pub fn render_email(
    site: &str,
    name: &str,
    frequency: &str,
    jobs: &[JobRow],
    more: bool,
    unsubscribe: &str,
) -> (String, String, String) {
    let subject = subject(name, jobs.len(), more);
    let mut html = format!(
        "<div style=\"font:15px/1.5 system-ui,sans-serif;color:#18191c;max-width:600px\">\
         <h2 style=\"font-size:18px;margin:0 0 12px\">New jobs for “{}”</h2><ul style=\"padding-left:18px\">",
        esc(name)
    );
    let mut text = format!("New jobs for “{name}”\n\n");
    for job in jobs {
        let url = safe_url(&job.apply_url, site);
        html.push_str(&format!(
            "<li style=\"margin:0 0 10px\"><a href=\"{}\" style=\"color:#0a65cc\">{}</a><br>\
             <span style=\"color:#555\">{}</span> · <a href=\"{site}/queue?add={}\" style=\"color:#0a65cc\">Add to my apply queue</a></li>",
            esc(url),
            esc(&job.job_title),
            esc(&company_line(job)),
            job.id,
        ));
        text.push_str(&format!("- {}\n  {url}\n", job_line(job)));
    }
    html.push_str("</ul>");
    if more {
        html.push_str(&format!(
            "<p>More matched. <a href=\"{site}/\" style=\"color:#0a65cc\">See them all on the board</a>.</p>"
        ));
        text.push_str(&format!("\nMore matched: {site}/\n"));
    }
    let how = match frequency {
        "instant" => "after each update",
        "weekly" => "weekly",
        _ => "daily",
    };
    html.push_str(&format!(
        "<p style=\"color:#555;font-size:13px;border-top:1px solid #d5d9df;padding-top:10px\">\
         You get this {how} for your alert “{}”. \
         <a href=\"{site}/alerts\" style=\"color:#0a65cc\">Change your alerts</a> · \
         <a href=\"{}\" style=\"color:#0a65cc\">Stop these emails</a></p></div>",
        esc(name),
        esc(unsubscribe),
    ));
    text.push_str(&format!(
        "\nYou get this {how} for your alert “{name}”.\nChange your alerts: {site}/alerts\nStop these emails: {unsubscribe}\n"
    ));
    (subject, html, text)
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
    pub emails: u32,
    pub chats: u32,
    /// Matches kept for the next run: no channel could deliver them.
    pub held: u32,
    pub remaining: i64,
}

/// One email under the daily and monthly caps, or `false` when either is used up.
async fn take_email_quota(state: &AppState) -> ApiResult<bool> {
    let pool = state.pool()?;
    let n = &state.config.notify;
    let day = db::bump_counter(pool, "global", "alert_email", &today(), 1).await?;
    let month = db::bump_counter(pool, "global", "alert_email", &this_month(), 1).await?;
    Ok(day <= n.emails_per_day && month <= n.emails_per_month)
}

async fn run_one(
    state: &AppState,
    row: &AlertRow,
    email: &str,
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
            limit: MAX_EMAIL_JOBS as i64 + 1,
        },
    )
    .await?;
    if jobs.is_empty() {
        stats.nothing_new += 1;
        return Ok(());
    }
    let more = jobs.len() > MAX_EMAIL_JOBS;
    jobs.truncate(MAX_EMAIL_JOBS);
    let site = state.config.notify.site_url.clone();
    let mut sent: Vec<i32> = Vec::new();

    if row.channels.iter().any(|c| c == "email") && state.config.notify.email_ready() {
        if take_email_quota(state).await? {
            let unsub = unsubscribe_url(state, row.id)?;
            let (subject, html, text) =
                render_email(&site, &spec.name, &row.frequency, &jobs, more, &unsub);
            let mail = Email {
                to: email,
                subject: &subject,
                html: &html,
                text: &text,
                unsubscribe: &unsub,
            };
            if notify::send_email(state, &mail).await == Sent::Yes {
                stats.emails += 1;
                sent.extend(jobs.iter().map(|j| j.id));
            }
            // Resend takes 2 requests a second.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        } else {
            eprintln!("alerts: the daily or monthly email cap is used up; holding emails");
        }
    } else if row.channels.iter().any(|c| c == "email") {
        eprintln!("alerts: RESEND_API_KEY or ALERTS_FROM is unset; email skipped");
    }

    if row.channels.iter().any(|c| c == "telegram")
        && let Some(chat_id) = crate::chat::address_of(state, row.user_id, "telegram").await?
    {
        let text = render_chat(&site, &spec.name, &jobs, more);
        if notify::send_telegram(state, &chat_id, &text).await == Sent::Yes {
            stats.chats += 1;
            sent.extend(jobs.iter().take(MAX_CHAT_JOBS).map(|j| j.id));
        }
    }

    if sent.is_empty() {
        stats.held += 1;
    } else {
        sent.sort_unstable();
        sent.dedup();
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
    for (row, email) in db::alerts::due_alerts(pool, RUN_BATCH).await? {
        // One alert's failure (a key that can't decrypt it) doesn't stop the rest.
        if let Err(e) = run_one(&state, &row, &email, now, &mut stats).await {
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
    fn email_escapes_and_carries_the_unsubscribe_link() {
        let jobs = vec![
            job(7, "https://jobs.example/7"),
            job(8, "javascript:alert(1)"),
        ];
        let (subject, html, text) = render_email(
            "https://site.example",
            "Backend <b>",
            "daily",
            &jobs,
            true,
            "https://site.example/api/alerts/unsubscribe?t=x",
        );
        assert_eq!(subject, "2+ new jobs: Backend <b>");
        assert!(html.contains("Acme &lt;Inc&gt;"));
        assert!(html.contains("Backend &lt;b&gt;"));
        assert!(!html.contains("javascript:"), "only web links");
        assert!(html.contains("/queue?add=7"));
        assert!(html.contains("unsubscribe?t=x"));
        assert!(
            text.contains("Stop these emails: https://site.example/api/alerts/unsubscribe?t=x")
        );
        assert!(text.contains("More matched"));
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
