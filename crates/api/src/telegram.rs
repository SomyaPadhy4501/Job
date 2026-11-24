//! The Telegram adapter for `chat.rs`: `POST /api/telegram/webhook`.
//!
//! Telegram calls it with every message to the bot and the secret given to
//! `setWebhook` in `X-Telegram-Bot-Api-Secret-Token`; anything without that
//! secret is refused. The reply goes back in the webhook's own response
//! (`{"method":"sendMessage",…}`), so answering needs no outgoing call.
//! Only private chats are answered: an account is linked to one person.
//!
//! Replies are HTML (`parse_mode`), with every piece of text escaped. A job
//! list gets a "Queue" button per job; a tap arrives as a `callback_query`
//! (so `setWebhook` must allow `message` and `callback_query`) and is
//! answered with a short notice, the same as sending `/apply <number>`.

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use serde_json::{Value, json};

use accounts::token::ct_eq;

use crate::AppState;
use crate::chat::{self, Channel, Incoming, MENU, Reply};
use crate::error::{ApiError, ApiResult};

pub const SECRET_HEADER: &str = "x-telegram-bot-api-secret-token";
/// `callback_data` of a job's "Queue" button: `queue:<job id>`.
pub const QUEUE_PREFIX: &str = "queue:";
/// Telegram's limit for a callback notice.
const NOTICE_CHARS: usize = 190;

pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let Some(secret) = state.config.notify.telegram_webhook_secret.as_deref() else {
        return Err(ApiError::NotFound);
    };
    let given = headers
        .get(SECRET_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !ct_eq(given.as_bytes(), secret.as_bytes()) {
        return Err(ApiError::Unauthorized);
    }
    // Anything unreadable is acknowledged and dropped: a non-2xx answer makes
    // Telegram retry the same update for hours.
    let update: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if let Some(tap) = update.get("callback_query") {
        return Ok(Json(button_tap(&state, tap).await));
    }
    let message = update
        .get("message")
        .or_else(|| update.get("edited_message"));
    let Some(message) = message else {
        return Ok(Json(json!({})));
    };
    let chat = &message["chat"];
    let (Some(chat_id), Some(text)) = (chat["id"].as_i64(), message["text"].as_str()) else {
        return Ok(Json(json!({})));
    };
    if chat["type"].as_str() != Some("private") {
        return Ok(Json(json!({})));
    }
    let reply = answer(&state, chat_id, text).await;
    let mut out = json!({
        "method": "sendMessage",
        "chat_id": chat_id,
        "text": html(&reply),
        "parse_mode": "HTML",
        "disable_web_page_preview": true,
    });
    if let Some(markup) = markup(&state, &reply) {
        out["reply_markup"] = markup;
    }
    Ok(Json(out))
}

async fn answer(state: &AppState, chat_id: i64, text: &str) -> Reply {
    let address = chat_id.to_string();
    let incoming = Incoming {
        channel: Channel::Telegram,
        address: &address,
        text: accounts::truncate_chars(text, 500),
    };
    match chat::handle(state, &incoming).await {
        Ok(reply) => reply,
        Err(ApiError::TooMany(why)) => why.into(),
        Err(e) => {
            eprintln!("telegram: command failed: {e:?}");
            "Something went wrong. Try again in a minute.".into()
        }
    }
}

/// A tap on an inline button. Answered with a short notice over the chat
/// (`answerCallbackQuery`), so the job list stays as it was.
async fn button_tap(state: &AppState, tap: &Value) -> Value {
    let Some(tap_id) = tap["id"].as_str() else {
        return json!({});
    };
    let chat = &tap["message"]["chat"];
    let job = tap["data"]
        .as_str()
        .and_then(|d| d.strip_prefix(QUEUE_PREFIX))
        .and_then(|id| id.parse::<i32>().ok());
    let notice = match (chat["id"].as_i64(), chat["type"].as_str(), job) {
        (Some(chat_id), Some("private"), Some(job)) => {
            let reply = answer(state, chat_id, &format!("/apply {job}")).await;
            let first = reply.plain();
            let first = first.lines().next().unwrap_or("").to_owned();
            accounts::truncate_chars(&first, NOTICE_CHARS).to_owned()
        }
        _ => String::new(),
    };
    json!({
        "method": "answerCallbackQuery",
        "callback_query_id": tap_id,
        "text": notice,
    })
}

/// Text for Telegram's HTML mode: only `&`, `<` and `>` need escaping (and
/// `"` inside an attribute).
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The reply as Telegram HTML: a job is the company in bold, the title, and
/// where it is, with its number and a link to the posting.
pub fn html(reply: &Reply) -> String {
    let mut text = escape(&reply.head);
    for job in &reply.jobs {
        let place = job
            .place
            .as_deref()
            .map(|l| format!("📍 {} · ", escape(l)))
            .unwrap_or_default();
        text.push_str(&format!(
            "\n<b>{}</b> — {}\n{place}<a href=\"{}\">Open posting</a> · #{}\n",
            escape(&job.company),
            escape(&job.title),
            escape(&job.url),
            job.id
        ));
    }
    if !reply.foot.is_empty() {
        text.push('\n');
        text.push_str(&escape(&reply.foot));
    }
    text
}

/// Buttons: a "Queue" button per listed job (two per row) and links to the
/// queue and the board; otherwise the menu, when the reply asks for it.
fn markup(state: &AppState, reply: &Reply) -> Option<Value> {
    if !reply.jobs.is_empty() {
        let mut rows: Vec<Value> = reply
            .jobs
            .chunks(2)
            .map(|pair| {
                json!(
                    pair.iter()
                        .map(|job| json!({
                            "text": format!("➕ Queue #{}", job.id),
                            "callback_data": format!("{QUEUE_PREFIX}{}", job.id),
                        }))
                        .collect::<Vec<_>>()
                )
            })
            .collect();
        let site = state.config.notify.site_url.trim_end_matches('/');
        if site.starts_with("https://") {
            rows.push(json!([
                { "text": "📋 My queue", "url": format!("{site}/queue") },
                { "text": "🌐 Job board", "url": format!("{site}/") },
            ]));
        }
        return Some(json!({ "inline_keyboard": rows }));
    }
    reply.menu.then(|| {
        json!({
            "keyboard": MENU
                .iter()
                .map(|row| row.iter().map(|label| json!({ "text": label })).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            "resize_keyboard": true,
            "is_persistent": true,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::JobCard;

    #[test]
    fn job_lists_are_escaped_html() {
        let reply = Reply {
            head: "Newest <jobs>:\n".into(),
            jobs: vec![JobCard {
                id: 9,
                company: "R&D Co".into(),
                title: "Engineer <II>".into(),
                place: None,
                url: "https://x.example/?a=1&b=\"2\"".into(),
            }],
            foot: String::new(),
            menu: false,
        };
        assert_eq!(
            html(&reply),
            "Newest &lt;jobs&gt;:\n\n<b>R&amp;D Co</b> — Engineer &lt;II&gt;\n\
             <a href=\"https://x.example/?a=1&amp;b=&quot;2&quot;\">Open posting</a> · #9\n"
        );
    }
}
