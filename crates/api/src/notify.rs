//! Sending messages out: email through Resend's HTTP API, chat messages
//! through Telegram's Bot API. Without a key or token each sender does
//! nothing and says so in the log, so a server without them still runs.
//!
//! Both are free: Resend's free plan sends 100 emails a day and 3,000 a month
//! (the daily and monthly caps below stay under that); Telegram bots are free.

use serde_json::json;

use crate::AppState;

/// Settings for alerts and chat, read once at start-up.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Where links in emails and chats point, without a trailing slash.
    pub site_url: String,
    pub resend_api_key: Option<String>,
    /// `Job alerts <alerts@your-domain>`: must be on a domain verified in Resend.
    pub alerts_from: Option<String>,
    pub resend_base: String,
    pub telegram_bot_token: Option<String>,
    /// Telegram sends it back in `X-Telegram-Bot-Api-Secret-Token`.
    pub telegram_webhook_secret: Option<String>,
    /// The bot's @name without the @, for the "Open in Telegram" link.
    pub telegram_bot_username: Option<String>,
    pub telegram_base: String,
    pub emails_per_day: i64,
    pub emails_per_month: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            site_url: "https://job-two-xi.vercel.app".into(),
            resend_api_key: None,
            alerts_from: None,
            resend_base: "https://api.resend.com".into(),
            telegram_bot_token: None,
            telegram_webhook_secret: None,
            telegram_bot_username: None,
            telegram_base: "https://api.telegram.org".into(),
            emails_per_day: 95,
            emails_per_month: 2900,
        }
    }
}

fn env_opt(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

impl Settings {
    pub fn from_env() -> Self {
        let d = Settings::default();
        let int = |name: &str, default: i64| {
            env_opt(name)
                .and_then(|v| v.parse().ok())
                .unwrap_or(default)
        };
        Self {
            site_url: env_opt("SITE_URL")
                .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
                .map(|u| u.trim_end_matches('/').to_owned())
                .unwrap_or(d.site_url),
            resend_api_key: env_opt("RESEND_API_KEY"),
            alerts_from: env_opt("ALERTS_FROM"),
            resend_base: d.resend_base,
            telegram_bot_token: env_opt("TELEGRAM_BOT_TOKEN"),
            // Telegram allows 1-256 of A-Z a-z 0-9 _ -; shorter than 16 is too guessable.
            telegram_webhook_secret: env_opt("TELEGRAM_WEBHOOK_SECRET").filter(|s| s.len() >= 16),
            telegram_bot_username: env_opt("TELEGRAM_BOT_USERNAME")
                .map(|s| s.trim_start_matches('@').to_owned()),
            telegram_base: d.telegram_base,
            emails_per_day: int("ALERT_EMAILS_PER_DAY", d.emails_per_day),
            emails_per_month: int("ALERT_EMAILS_PER_MONTH", d.emails_per_month),
        }
    }

    pub fn email_ready(&self) -> bool {
        self.resend_api_key.is_some() && self.alerts_from.is_some()
    }

    pub fn telegram_ready(&self) -> bool {
        self.telegram_bot_token.is_some()
    }
}

pub struct Email<'a> {
    pub to: &'a str,
    pub subject: &'a str,
    pub html: &'a str,
    pub text: &'a str,
    /// The one-click unsubscribe URL, for the `List-Unsubscribe` headers.
    pub unsubscribe: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Sent {
    Yes,
    /// Not configured: nothing was sent, and nothing failed.
    Skipped,
    Failed,
}

/// Sends one email through Resend. Errors are logged without the address.
pub async fn send_email(state: &AppState, e: &Email<'_>) -> Sent {
    let s = &state.config.notify;
    let (Some(key), Some(from)) = (&s.resend_api_key, &s.alerts_from) else {
        eprintln!("alerts: RESEND_API_KEY or ALERTS_FROM is unset; email skipped");
        return Sent::Skipped;
    };
    let body = json!({
        "from": from,
        "to": [e.to],
        "subject": e.subject,
        "html": e.html,
        "text": e.text,
        "headers": {
            "List-Unsubscribe": format!("<{}>", e.unsubscribe),
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
    });
    let res = state
        .http
        .post(format!("{}/emails", s.resend_base))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => Sent::Yes,
        Ok(r) => {
            eprintln!("alerts: Resend answered {}", r.status().as_u16());
            Sent::Failed
        }
        Err(err) => {
            eprintln!("alerts: Resend unreachable ({})", err.without_url());
            Sent::Failed
        }
    }
}

/// Sends a plain-text Telegram message. The bot token is part of the URL, so
/// errors are logged without it.
pub async fn send_telegram(state: &AppState, chat_id: &str, text: &str) -> Sent {
    let s = &state.config.notify;
    let Some(token) = &s.telegram_bot_token else {
        eprintln!("alerts: TELEGRAM_BOT_TOKEN is unset; Telegram message skipped");
        return Sent::Skipped;
    };
    let res = state
        .http
        .post(format!("{}/bot{token}/sendMessage", s.telegram_base))
        .json(&json!({
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": true,
        }))
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => Sent::Yes,
        Ok(r) => {
            eprintln!("alerts: Telegram answered {}", r.status().as_u16());
            Sent::Failed
        }
        Err(_) => {
            eprintln!("alerts: Telegram unreachable");
            Sent::Failed
        }
    }
}
