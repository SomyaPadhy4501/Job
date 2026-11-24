//! Workday login: one email and one password for every company's Workday
//! site, set on the Autofill page and read by the extension to sign in and to
//! fill the create-account form.
//!
//! - `GET/PUT/DELETE /api/me/workday-login` (session + CSRF): the website
//!   sees the email and when it was saved, never the password.
//! - `GET /api/autofill/workday-login` (bearer token): the extension gets the
//!   email and the password.
//!
//! `{email, password}` is stored encrypted (`Field::WorkdayLogin`), bound to
//! the user id (`migrations/010_workday_login.sql`). While that table is
//! missing these routes answer 503.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use accounts::crypto::Field;

use crate::AppState;
use crate::auth::Signed;
use crate::autofill::TokenUser;
use crate::error::{ApiError, ApiResult};
use crate::http::JsonBody;

pub const MIN_PASSWORD: usize = 12;
pub const MAX_PASSWORD: usize = 128;
pub const MAX_EMAIL: usize = 254;

/// What `login_data` holds, encrypted.
#[derive(Serialize, Deserialize)]
struct Login {
    email: String,
    password: String,
}

fn rfc3339(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// The email, trimmed, if it looks like one.
pub fn check_email(raw: &str) -> Result<String, &'static str> {
    let email = raw.trim();
    if email.is_empty() {
        return Err("Enter the email you use on Workday sites.");
    }
    let valid = email.len() <= MAX_EMAIL
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && local.len() <= 64
                && !domain.contains('@')
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains("..")
        });
    if valid {
        Ok(email.to_owned())
    } else {
        Err("Enter a valid email address.")
    }
}

/// Workday's usual rules, so the password works on every company's site.
pub fn check_password(password: &str) -> Result<(), &'static str> {
    let len = password.chars().count();
    if len < MIN_PASSWORD {
        return Err("Use at least 12 characters.");
    }
    if len > MAX_PASSWORD {
        return Err("Use at most 128 characters.");
    }
    if password.chars().any(char::is_control) {
        return Err("The password can't contain control characters.");
    }
    let upper = password.chars().any(char::is_uppercase);
    let lower = password.chars().any(char::is_lowercase);
    let digit = password.chars().any(|c| c.is_ascii_digit());
    let symbol = password
        .chars()
        .any(|c| !c.is_alphanumeric() && !c.is_whitespace());
    if upper && lower && digit && symbol {
        Ok(())
    } else {
        Err("Use upper and lower case letters, a number and a symbol.")
    }
}

async fn stored(state: &AppState, user_id: Uuid) -> ApiResult<Option<(Login, OffsetDateTime)>> {
    let Some(row) = db::workday::workday_login(state.pool()?, user_id).await? else {
        return Ok(None);
    };
    let login: Login =
        state
            .keyring()?
            .decrypt_json(Field::WorkdayLogin, &user_id, &row.login_data)?;
    Ok(Some((login, row.updated_at)))
}

/// What the website sees: never the password.
fn web_view(saved: Option<(&str, OffsetDateTime)>) -> Value {
    match saved {
        Some((email, at)) => json!({ "email": email, "set": true, "updatedAt": rfc3339(at) }),
        None => json!({ "email": null, "set": false, "updatedAt": null }),
    }
}

// ---------------------------------------------------------------------------
// The website (session)

/// `GET /api/me/workday-login` -> `{ email, set, updatedAt }`.
pub async fn show(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let saved = stored(&state, signed.user.id).await?;
    Ok(Json(web_view(
        saved.as_ref().map(|(l, at)| (l.email.as_str(), *at)),
    )))
}

#[derive(Deserialize)]
pub struct SaveBody {
    email: String,
    /// Left out (or empty): keep the saved password.
    #[serde(default)]
    password: Option<String>,
}

/// `PUT /api/me/workday-login` `{ email, password? }` -> `{ email, set, updatedAt }`.
pub async fn save(
    State(state): State<AppState>,
    signed: Signed,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<Value>> {
    let user_id = signed.user.id;
    let email = check_email(&body.email).map_err(ApiError::bad)?;
    let password = match body.password.filter(|p| !p.is_empty()) {
        Some(p) => {
            check_password(&p).map_err(ApiError::bad)?;
            p
        }
        None => match stored(&state, user_id).await? {
            Some((old, _)) => old.password,
            None => return Err(ApiError::bad("Choose a password.")),
        },
    };
    let keys = state.keyring()?;
    let pool = state.pool()?;
    let sealed = keys.encrypt_json(
        Field::WorkdayLogin,
        &user_id,
        &Login {
            email: email.clone(),
            password,
        },
    );
    let row = db::workday::put_workday_login(pool, user_id, &sealed).await?;
    db::audit(pool, Some(user_id), "workday_login_set").await?;
    Ok(Json(web_view(Some((&email, row.updated_at)))))
}

/// `DELETE /api/me/workday-login` -> `{ ok: true }`.
pub async fn remove(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let pool = state.pool()?;
    if db::workday::delete_workday_login(pool, signed.user.id).await? {
        db::audit(pool, Some(signed.user.id), "workday_login_delete").await?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// For the account export: the email and date, never the password.
pub async fn export_json(state: &AppState, user_id: Uuid) -> ApiResult<Value> {
    if state.db.is_none() {
        return Ok(Value::Null);
    }
    Ok(match stored(state, user_id).await {
        Ok(Some((login, at))) => json!({ "email": login.email, "updatedAt": rfc3339(at) }),
        // None saved, or the table isn't there yet.
        Ok(None) | Err(ApiError::Unavailable(_)) => Value::Null,
        Err(e) => return Err(e),
    })
}

// ---------------------------------------------------------------------------
// The extension (bearer token)

/// `GET /api/autofill/workday-login` -> `{ email, password, updatedAt }`, all
/// null when none is saved. Never cached (the router sets `no-store` on
/// every response).
pub async fn for_extension(
    State(state): State<AppState>,
    who: TokenUser,
) -> ApiResult<Json<Value>> {
    Ok(Json(match stored(&state, who.user.id).await? {
        Some((login, at)) => json!({
            "email": login.email,
            "password": login.password,
            "updatedAt": rfc3339(at),
        }),
        None => json!({ "email": null, "password": null, "updatedAt": null }),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_follow_workdays_rules() {
        assert_eq!(check_password("Aa1!"), Err("Use at least 12 characters."));
        assert_eq!(
            check_password(&format!("Aa1!{}", "x".repeat(125))),
            Err("Use at most 128 characters.")
        );
        for weak in [
            "alllowercase1!",
            "ALLUPPERCASE1!",
            "NoDigitsHere!!",
            "NoSymbols12345",
        ] {
            assert_eq!(
                check_password(weak),
                Err("Use upper and lower case letters, a number and a symbol."),
                "{weak}"
            );
        }
        assert!(check_password("Correct-Horse-9").is_ok());
        assert!(check_password(&format!("Aa1!{}", "x".repeat(124))).is_ok());
        assert!(check_password("Bad\u{0}Password-1").is_err());
    }

    #[test]
    fn emails_are_trimmed_and_checked() {
        assert_eq!(
            check_email("  pat@example.com ").unwrap(),
            "pat@example.com"
        );
        for bad in [
            "",
            "pat",
            "pat@",
            "@example.com",
            "pat@example",
            "p at@example.com",
            "pat@a..com",
            "a@b@c.com",
        ] {
            assert!(check_email(bad).is_err(), "{bad:?}");
        }
        assert!(check_email(&format!("{}@example.com", "a".repeat(250))).is_err());
    }
}
