//! `/api/me/answers`: the answer bank for application questions that aren't
//! in the profile ("Why this company?", "Years of Go?"). The question, the
//! company and the answer are encrypted together; rows are found by a keyed
//! hash, so the questions never sit in the clear.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use accounts::answers::{AnswerEntry, MAX_ANSWERS, Scope, entry_key};
use accounts::crypto::Field;

use crate::AppState;
use crate::auth::Signed;
use crate::error::{ApiError, ApiResult};
use crate::http::{JsonBody, parse_id};
use crate::resumes::sentence;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerView {
    pub id: Uuid,
    pub question: String,
    pub answer: String,
    pub scope: Scope,
    pub company: String,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: time::OffsetDateTime,
}

/// Every saved answer, decrypted. A row that fails to decrypt is skipped and
/// logged (by id only) rather than failing the whole list.
pub async fn all(state: &AppState, user_id: Uuid) -> ApiResult<Vec<AnswerView>> {
    let keys = state.keyring()?;
    let mut out = Vec::new();
    for row in db::list_answers(state.pool()?, user_id).await? {
        match keys.decrypt_json::<AnswerEntry>(Field::AnswerEntry, &user_id, &row.entry) {
            Ok(e) => out.push(AnswerView {
                id: row.id,
                question: e.question,
                answer: e.answer,
                scope: Scope::parse(&row.scope).unwrap_or_default(),
                company: e.company,
                updated_at: row.updated_at,
            }),
            Err(err) => eprintln!("answer {} unreadable: {err}", row.id),
        }
    }
    Ok(out)
}

/// Validates and saves one answer, replacing an earlier answer to the same
/// question (and company). Returns its id and whether it was new.
pub async fn upsert(
    state: &AppState,
    user_id: Uuid,
    scope: Scope,
    mut entry: AnswerEntry,
) -> ApiResult<(Uuid, bool)> {
    entry
        .validate(scope)
        .map_err(|e| ApiError::bad(sentence(e)))?;
    let pool = state.pool()?;
    let key = entry_key(&user_id, scope, &entry);
    if !db::answer_exists(pool, user_id, &key).await?
        && db::count_answers(pool, user_id).await? >= MAX_ANSWERS
    {
        return Err(ApiError::Forbidden(format!(
            "You can save up to {MAX_ANSWERS} answers. Delete some first."
        )));
    }
    let data = state
        .keyring()?
        .encrypt_json(Field::AnswerEntry, &user_id, &entry);
    Ok(db::upsert_answer(pool, user_id, &key, scope.as_str(), &data).await?)
}

pub async fn list(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({ "answers": all(&state, signed.user.id).await?, "max": MAX_ANSWERS }),
    ))
}

#[derive(Deserialize)]
pub struct SaveBody {
    question: String,
    answer: String,
    #[serde(default)]
    scope: Scope,
    #[serde(default)]
    company: String,
}

pub async fn save(
    State(state): State<AppState>,
    signed: Signed,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<Value>> {
    let entry = AnswerEntry {
        question: body.question,
        answer: body.answer,
        company: body.company,
    };
    let (id, created) = upsert(&state, signed.user.id, body.scope, entry).await?;
    Ok(Json(json!({ "id": id, "created": created })))
}

pub async fn remove(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if db::delete_answer(state.pool()?, signed.user.id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}
