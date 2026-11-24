//! Chat commands, whatever the app: Telegram today, WhatsApp later.
//!
//! A channel adapter (see `telegram.rs`) does three things: checks that the
//! message really came from its platform, turns it into an [`Incoming`], and
//! delivers the reply text [`handle`] returns. Everything else, linking a
//! chat to an account, the commands, and finding the chat to send alerts to,
//! lives here and knows nothing about the platform.
//!
//! Adding WhatsApp (Cloud API) later: a `whatsapp.rs` adapter that verifies
//! Meta's `X-Hub-Signature-256` and sends replies through the Graph API, plus
//! `Channel::WhatsApp`. Replies inside 24 hours of the user's last message
//! are free there; alerts sent outside that window are paid template
//! messages, so that adapter would deliver alerts only on the user's request.
//!
//! Chat ids are personal: stored encrypted, found by a keyed hash.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use accounts::crypto::Field;
use accounts::token::{hex, hmac_sha256, random_bytes, sha256_parts};

use crate::AppState;
use crate::alerts::{self, Filters, safe_url};
use crate::auth::{Signed, rate_limit};
use crate::error::{ApiError, ApiResult};
use crate::queue::{self, Actor};

pub const CODE_MINUTES: i64 = 15;
/// Commands one chat may send a day.
pub const COMMANDS_PER_DAY: i64 = 300;
/// Wrong link codes one chat may send a day.
pub const LINK_TRIES_PER_DAY: i64 = 10;
// No 0/O, 1/I/L: the code is typed by hand on a phone.
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LEN: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Telegram,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Telegram => "telegram",
        }
    }
}

/// A message from a chat app, already verified by its adapter.
pub struct Incoming<'a> {
    pub channel: Channel,
    /// The chat's id on that platform, as text.
    pub address: &'a str,
    pub text: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    /// `/start CODE` (Telegram's deep link) or `/link CODE`.
    Link(String),
    Jobs,
    Alerts,
    Pause,
    Resume,
    Apply(String),
    Unlink,
    Help,
}

// The menu under the message box (Telegram's reply keyboard). Pressing a
// button sends its label as a message, so `parse` reads the labels too.
pub const JOBS_BUTTON: &str = "🔎 New jobs";
pub const ALERTS_BUTTON: &str = "🔔 My alerts";
pub const PAUSE_BUTTON: &str = "⏸ Pause alerts";
pub const RESUME_BUTTON: &str = "▶️ Resume alerts";
/// The menu, row by row.
pub const MENU: [[&str; 2]; 2] = [[JOBS_BUTTON, ALERTS_BUTTON], [PAUSE_BUTTON, RESUME_BUTTON]];

/// One job in a reply, for apps that can show it richer than plain text.
#[derive(Debug, Clone)]
pub struct JobCard {
    pub id: i32,
    pub company: String,
    pub title: String,
    pub place: Option<String>,
    /// http(s) only (see `safe_url`).
    pub url: String,
}

/// An answer to one message: `head`, then `jobs` (if any), then `foot`.
/// [`Reply::plain`] is the whole answer as plain text, for any chat app; an
/// adapter that can show formatting and buttons uses the parts.
#[derive(Debug, Clone, Default)]
pub struct Reply {
    pub head: String,
    pub jobs: Vec<JobCard>,
    pub foot: String,
    /// Show the menu ([`MENU`]) under the message.
    pub menu: bool,
}

impl Reply {
    pub fn plain(&self) -> String {
        let mut text = self.head.clone();
        for job in &self.jobs {
            let place = job
                .place
                .as_deref()
                .map(|l| format!(" · {l}"))
                .unwrap_or_default();
            text.push_str(&format!(
                "\n#{} {} — {}{place}\n{}\n",
                job.id, job.company, job.title, job.url
            ));
        }
        if !self.foot.is_empty() {
            text.push('\n');
            text.push_str(&self.foot);
        }
        text
    }

    fn with_menu(mut self) -> Self {
        self.menu = true;
        self
    }
}

impl From<String> for Reply {
    fn from(head: String) -> Self {
        Reply {
            head,
            ..Reply::default()
        }
    }
}

impl From<&str> for Reply {
    fn from(head: &str) -> Self {
        head.to_owned().into()
    }
}

/// Reads a command. `/jobs@SomeBot` (groups) counts as `/jobs`.
pub fn parse(text: &str) -> Command {
    let text = text.trim();
    match text {
        JOBS_BUTTON => return Command::Jobs,
        ALERTS_BUTTON => return Command::Alerts,
        PAUSE_BUTTON => return Command::Pause,
        RESUME_BUTTON => return Command::Resume,
        _ => {}
    }
    let (head, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    let name = head.split('@').next().unwrap_or("").to_ascii_lowercase();
    let arg = rest.trim().to_owned();
    match name.as_str() {
        "/start" | "/link" if !arg.is_empty() => Command::Link(arg),
        "/jobs" => Command::Jobs,
        "/alerts" => Command::Alerts,
        "/pause" | "/stop" => Command::Pause,
        "/resume" => Command::Resume,
        "/apply" => Command::Apply(arg),
        "/unlink" => Command::Unlink,
        _ => Command::Help,
    }
}

/// Upper case, no spaces or dashes: `ab3k-9xq2m` and `AB3K9XQ2M` are the same.
pub fn normalize_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub fn new_code() -> String {
    random_bytes::<CODE_LEN>()
        .iter()
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect()
}

fn code_hash(code: &str) -> [u8; 32] {
    sha256_parts(&[b"chat-link-code/v1", code.as_bytes()])
}

fn address_hash(state: &AppState, channel: Channel, address: &str) -> ApiResult<[u8; 32]> {
    let key = state.keyring()?.derive("chat-address/v1");
    Ok(hmac_sha256(
        &key,
        format!("{}:{address}", channel.as_str()).as_bytes(),
    ))
}

/// The chat id to send to, if the user linked one on `channel`.
pub async fn address_of(
    state: &AppState,
    user_id: Uuid,
    channel: &str,
) -> ApiResult<Option<String>> {
    let Some(link) = db::chat::chat_link(state.pool()?, user_id, channel).await? else {
        return Ok(None);
    };
    let raw = state
        .keyring()?
        .decrypt(Field::ChatAddress, &user_id, &link.address)?;
    Ok(String::from_utf8(raw).ok())
}

const HELP: &str = "Use the buttons below, or these commands:\n\
/jobs – the newest jobs for your alerts\n\
/alerts – your alerts\n\
/pause – stop all alerts (/resume to restart)\n\
/apply <number> – add a job to your apply queue\n\
/unlink – disconnect this chat";

const NOT_LINKED: &str = "This chat isn’t linked to an account yet. On the job board, open Alerts, \
press “Link Telegram”, and send the code here.";

/// Answers one message.
pub async fn handle(state: &AppState, msg: &Incoming<'_>) -> ApiResult<Reply> {
    let pool = state.pool()?;
    let hash = address_hash(state, msg.channel, msg.address)?;
    let subject = format!("chat:{}", hex(&hash[..12]));
    rate_limit(
        state,
        &subject,
        "chat_cmd",
        COMMANDS_PER_DAY,
        "Too many messages today.",
    )
    .await?;

    let command = parse(msg.text);
    if let Command::Link(code) = &command {
        return link(state, msg, &hash, &subject, code).await;
    }
    let Some(user) = db::chat::chat_user(pool, msg.channel.as_str(), &hash).await? else {
        return Ok(NOT_LINKED.into());
    };
    let site = &state.config.notify.site_url;
    Ok(match command {
        Command::Link(_) => unreachable!("handled above"),
        Command::Help => Reply::from(HELP).with_menu(),
        Command::Jobs => jobs_reply(state, user.id).await?,
        Command::Alerts => alerts_reply(state, user.id).await?.into(),
        Command::Pause => {
            let n = db::alerts::set_all_paused(pool, user.id, true).await?;
            format!("Paused {n} alert(s). Send /resume to turn them back on.").into()
        }
        Command::Resume => {
            let n = db::alerts::set_all_paused(pool, user.id, false).await?;
            format!("Turned {n} alert(s) back on.").into()
        }
        Command::Apply(arg) if arg.is_empty() => {
            "Send /apply and a job number from /jobs, like /apply 1234.".into()
        }
        Command::Apply(arg) => match queue::find_job(state, &arg).await? {
            None => "I can’t find that job. Use a number from /jobs.".into(),
            Some(job) => {
                let (item, added) =
                    queue::add(state, user.id, &job, Actor::Chat(msg.channel)).await?;
                let first = if added {
                    "Added to your apply queue"
                } else {
                    "Already in your apply queue"
                };
                format!(
                    "{first}: {} — {}.\nYou submit the application yourself: {site}/queue\nStatus: {}",
                    item.company, item.title, item.status
                )
                .into()
            }
        },
        Command::Unlink => {
            db::chat::unlink_chat(pool, user.id, msg.channel.as_str()).await?;
            db::audit(pool, Some(user.id), "chat_unlink").await?;
            "This chat is disconnected. Link it again from the Alerts page.".into()
        }
    })
}

async fn link(
    state: &AppState,
    msg: &Incoming<'_>,
    hash: &[u8; 32],
    subject: &str,
    code: &str,
) -> ApiResult<Reply> {
    let pool = state.pool()?;
    let code = normalize_code(code);
    let user_id = if code.len() == CODE_LEN {
        db::chat::take_link_code(pool, msg.channel.as_str(), &code_hash(&code)).await?
    } else {
        None
    };
    let Some(user_id) = user_id else {
        rate_limit(
            state,
            subject,
            "chat_link_fail",
            LINK_TRIES_PER_DAY,
            "Too many wrong codes today. Try again tomorrow.",
        )
        .await?;
        return Ok(
            "That code didn’t work. Codes last 15 minutes: get a new one on the Alerts page."
                .into(),
        );
    };
    let address = state
        .keyring()?
        .encrypt(Field::ChatAddress, &user_id, msg.address.as_bytes());
    let mut tx = pool.begin().await.map_err(db::DbError::from)?;
    db::chat::link_chat(&mut tx, user_id, msg.channel.as_str(), hash, &address).await?;
    tx.commit().await.map_err(db::DbError::from)?;
    db::audit(pool, Some(user_id), "chat_link").await?;
    Ok(Reply::from(format!(
        "Linked. Alerts set to Telegram will arrive here.\n\n{HELP}"
    ))
    .with_menu())
}

async fn jobs_reply(state: &AppState, user_id: Uuid) -> ApiResult<Reply> {
    let site = state.config.notify.site_url.clone();
    let rows = db::alerts::list_alerts(state.pool()?, user_id).await?;
    let mut filters: Vec<Filters> = Vec::new();
    for row in &rows {
        filters.push(alerts::spec_of(state, row)?.filters);
    }
    if filters.is_empty() {
        filters.push(Filters::board_default());
    }
    let mut jobs = Vec::new();
    for f in filters.iter().take(5) {
        for job in alerts::newest(state, f, 8).await? {
            if !jobs.iter().any(|j: &db::alerts::JobRow| j.id == job.id) {
                jobs.push(job);
            }
        }
    }
    jobs.sort_by(|a, b| b.first_seen_at.cmp(&a.first_seen_at));
    jobs.truncate(8);
    if jobs.is_empty() {
        return Ok(
            format!("Nothing new matches your alerts this week. Browse the board: {site}/").into(),
        );
    }
    let head = if rows.is_empty() {
        "Newest jobs (you have no alerts yet, so these are the board’s defaults):\n"
    } else {
        "Newest jobs for your alerts:\n"
    };
    let cards = jobs
        .iter()
        .map(|job| JobCard {
            id: job.id,
            company: job.company_name.clone(),
            title: job.job_title.clone(),
            place: job
                .location
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned),
            url: safe_url(&job.apply_url, &site).to_owned(),
        })
        .collect();
    Ok(Reply {
        head: head.into(),
        jobs: cards,
        foot: "Tap “Queue” under a job, or send /apply <number>, to add it to your apply queue."
            .into(),
        menu: false,
    })
}

async fn alerts_reply(state: &AppState, user_id: Uuid) -> ApiResult<String> {
    let site = &state.config.notify.site_url;
    let rows = db::alerts::list_alerts(state.pool()?, user_id).await?;
    if rows.is_empty() {
        return Ok(format!("You have no alerts. Make one at {site}/alerts"));
    }
    let mut text = String::from("Your alerts:\n");
    for (i, row) in rows.iter().enumerate() {
        let spec = alerts::spec_of(state, row)?;
        let to = if row.channels.is_empty() {
            "nowhere".to_owned()
        } else {
            row.channels.join(" + ")
        };
        let paused = if row.paused { " (paused)" } else { "" };
        text.push_str(&format!(
            "\n{}. {} — {}, {to}{paused}",
            i + 1,
            spec.name,
            row.frequency
        ));
    }
    text.push_str(&format!("\n\nChange them at {site}/alerts"));
    Ok(text)
}

// ---------------------------------------------------------------------------
// The web page's side: link status, codes, unlink (cookie routes)

pub async fn status(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let link = db::chat::chat_link(state.pool()?, signed.user.id, "telegram").await?;
    let n = &state.config.notify;
    Ok(Json(json!({
        "telegram": {
            "ready": n.telegram_ready() && n.telegram_webhook_secret.is_some(),
            "linked": link.is_some(),
            "botUsername": n.telegram_bot_username,
        }
    })))
}

/// A new one-time code for linking Telegram. Replaces any older code.
pub async fn new_telegram_code(
    State(state): State<AppState>,
    signed: Signed,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let pool = state.pool()?;
    let user_id = signed.user.id;
    rate_limit(
        &state,
        &user_id.to_string(),
        "chat_code",
        20,
        "Too many codes today. Try again tomorrow.",
    )
    .await?;
    let code = new_code();
    let expires = OffsetDateTime::now_utc() + Duration::minutes(CODE_MINUTES);
    db::chat::put_link_code(pool, user_id, "telegram", &code_hash(&code), expires).await?;
    let link = state
        .config
        .notify
        .telegram_bot_username
        .as_ref()
        .map(|bot| format!("https://t.me/{bot}?start={code}"));
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "code": format!("{}-{}", &code[..5], &code[5..]),
            "minutes": CODE_MINUTES,
            "link": link,
        })),
    ))
}

pub async fn unlink_telegram(
    State(state): State<AppState>,
    signed: Signed,
) -> ApiResult<StatusCode> {
    let pool = state.pool()?;
    if !db::chat::unlink_chat(pool, signed.user.id, "telegram").await? {
        return Err(ApiError::NotFound);
    }
    db::audit(pool, Some(signed.user.id), "chat_unlink").await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands() {
        assert_eq!(parse("/jobs"), Command::Jobs);
        assert_eq!(parse("/jobs@JobBoardBot"), Command::Jobs);
        assert_eq!(parse("  /ALERTS "), Command::Alerts);
        assert_eq!(
            parse("/start AB3K9XQ2MN"),
            Command::Link("AB3K9XQ2MN".into())
        );
        assert_eq!(parse("/start"), Command::Help, "a bare /start gets help");
        assert_eq!(parse("/apply  #1234 "), Command::Apply("#1234".into()));
        assert_eq!(parse("/pause"), Command::Pause);
        assert_eq!(parse("hello"), Command::Help);
        assert_eq!(
            parse(JOBS_BUTTON),
            Command::Jobs,
            "menu buttons send their label"
        );
        assert_eq!(parse(ALERTS_BUTTON), Command::Alerts);
        assert_eq!(parse(PAUSE_BUTTON), Command::Pause);
        assert_eq!(parse(RESUME_BUTTON), Command::Resume);
    }

    #[test]
    fn a_reply_reads_as_plain_text_too() {
        let reply = Reply {
            head: "Newest jobs:\n".into(),
            jobs: vec![JobCard {
                id: 7,
                company: "Acme".into(),
                title: "Engineer".into(),
                place: Some("Austin, TX".into()),
                url: "https://acme.example/7".into(),
            }],
            foot: "Bye.".into(),
            menu: false,
        };
        assert_eq!(
            reply.plain(),
            "Newest jobs:\n\n#7 Acme — Engineer · Austin, TX\nhttps://acme.example/7\n\nBye."
        );
    }

    #[test]
    fn codes_are_typeable() {
        let c = new_code();
        assert_eq!(c.len(), CODE_LEN);
        assert!(c.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        assert_eq!(normalize_code("ab3k9-xq2mn"), "AB3K9XQ2MN");
    }
}
