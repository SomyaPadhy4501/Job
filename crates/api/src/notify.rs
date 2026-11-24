//! Sending messages out: chat messages through Telegram's Bot API (free).
//! Without a bot token the sender does nothing and says so in the log, so a
//! server without one still runs.

use serde_json::json;

use crate::AppState;

/// Settings for alerts and chat, read once at start-up.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Where links in chat messages point, without a trailing slash.
    pub site_url: String,
    pub telegram_bot_token: Option<String>,
    /// Telegram sends it back in `X-Telegram-Bot-Api-Secret-Token`.
    pub telegram_webhook_secret: Option<String>,
    /// The bot's @name without the @, for the "Open in Telegram" link.
    pub telegram_bot_username: Option<String>,
    pub telegram_base: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            site_url: "https://job-two-xi.vercel.app".into(),
            telegram_bot_token: None,
            telegram_webhook_secret: None,
            telegram_bot_username: None,
            telegram_base: "https://api.telegram.org".into(),
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
        Self {
            site_url: env_opt("SITE_URL")
                .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
                .map(|u| u.trim_end_matches('/').to_owned())
                .unwrap_or(d.site_url),
            telegram_bot_token: env_opt("TELEGRAM_BOT_TOKEN"),
            // Telegram allows 1-256 of A-Z a-z 0-9 _ -; shorter than 16 is too guessable.
            telegram_webhook_secret: env_opt("TELEGRAM_WEBHOOK_SECRET").filter(|s| s.len() >= 16),
            telegram_bot_username: env_opt("TELEGRAM_BOT_USERNAME")
                .map(|s| s.trim_start_matches('@').to_owned()),
            telegram_base: d.telegram_base,
        }
    }

    pub fn telegram_ready(&self) -> bool {
        self.telegram_bot_token.is_some()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Sent {
    Yes,
    /// Not configured: nothing was sent, and nothing failed.
    Skipped,
    Failed,
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
