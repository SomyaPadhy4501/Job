//! The Telegram adapter for `chat.rs`: `POST /api/telegram/webhook`.
//!
//! Telegram calls it with every message to the bot and the secret given to
//! `setWebhook` in `X-Telegram-Bot-Api-Secret-Token`; anything without that
//! secret is refused. The reply goes back in the webhook's own response
//! (`{"method":"sendMessage",…}`), so answering needs no outgoing call.
//! Only private chats are answered: an account is linked to one person.

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use serde_json::{Value, json};

use accounts::token::ct_eq;

use crate::AppState;
use crate::chat::{self, Channel, Incoming};
use crate::error::{ApiError, ApiResult};

pub const SECRET_HEADER: &str = "x-telegram-bot-api-secret-token";

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
    let address = chat_id.to_string();
    let incoming = Incoming {
        channel: Channel::Telegram,
        address: &address,
        text: accounts::truncate_chars(text, 500),
    };
    let reply = match chat::handle(&state, &incoming).await {
        Ok(text) => text,
        Err(ApiError::TooMany(why)) => why,
        Err(e) => {
            eprintln!("telegram: command failed: {e:?}");
            "Something went wrong. Try again in a minute.".into()
        }
    };
    Ok(Json(json!({
        "method": "sendMessage",
        "chat_id": chat_id,
        "text": reply,
        "disable_web_page_preview": true,
    })))
}
