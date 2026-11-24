//! `/api/autofill/*`: what the Chrome extension reads and writes, with a
//! bearer token from the Settings page (`Authorization: Bearer jbt_…`).
//! Cookies are never read here, so these routes need no CSRF check, and a
//! token can't reach any `/api/me` route.

use axum::Json;
use axum::extract::{FromRequestParts, Path, Query, State};
use axum::http::header;
use axum::http::request::Parts;
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use accounts::answers::{AnswerEntry, Scope};
use accounts::rank::{Candidate, rank};
use accounts::token::{looks_like_api_token, sha256};

use crate::AppState;
use crate::error::{ApiError, ApiResult};
use crate::http::{JsonBody, parse_id};

pub const SCOPE: &str = "autofill";
/// Answers one request may save.
pub const MAX_ANSWERS_PER_SAVE: usize = 50;

/// The user behind a valid autofill token.
pub struct TokenUser {
    pub user: db::User,
}

impl FromRequestParts<AppState> for TokenUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|t| looks_like_api_token(t))
            .ok_or(ApiError::Unauthorized)?;
        let pool = state.pool()?;
        let (token_id, last_used, user) = db::token_user(pool, &sha256(token.as_bytes()), SCOPE)
            .await?
            .ok_or(ApiError::Unauthorized)?;
        // Written at most hourly, to spare the database.
        if last_used.is_none_or(|t| OffsetDateTime::now_utc() - t > Duration::hours(1)) {
            db::touch_token(pool, token_id).await.ok();
        }
        Ok(TokenUser { user })
    }
}

/// Everything the extension needs to fill a form.
pub async fn profile(State(state): State<AppState>, who: TokenUser) -> ApiResult<Json<Value>> {
    let user_id = who.user.id;
    let stored = crate::profile::load(&state, user_id).await?;
    let resumes = db::list_resumes(state.pool()?, user_id).await?;
    let answers: Vec<Value> = crate::answers::all(&state, user_id)
        .await?
        .into_iter()
        .map(|a| json!({ "question": a.question, "answer": a.answer, "scope": a.scope, "company": a.company }))
        .collect();
    Ok(Json(json!({
        "user": { "email": who.user.email, "name": who.user.name },
        "profile": stored.profile,
        "profileVersion": stored.version,
        "resumes": resumes,
        "answers": answers,
    })))
}

#[derive(Deserialize)]
pub struct RankQuery {
    #[serde(default)]
    title: String,
}

/// The user's resumes, best match for `title` first.
pub async fn resumes(
    State(state): State<AppState>,
    who: TokenUser,
    Query(q): Query<RankQuery>,
) -> ApiResult<Json<Value>> {
    let resumes = db::list_resumes(state.pool()?, who.user.id).await?;
    let candidates: Vec<Candidate<'_>> = resumes
        .iter()
        .map(|r| Candidate {
            id: r.id,
            title: &r.title,
            tags: &r.tags,
            is_default: r.is_default,
        })
        .collect();
    let title = accounts::truncate_chars(&q.title, 300).to_owned();
    let ranked: Vec<Value> = rank(&title, &candidates)
        .into_iter()
        .filter_map(|(id, score)| {
            resumes.iter().find(|r| r.id == id).map(|r| {
                let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
                v["score"] = json!(score);
                v
            })
        })
        .collect();
    Ok(Json(json!({ "resumes": ranked })))
}

pub async fn resume_file(
    State(state): State<AppState>,
    who: TokenUser,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let id = parse_id(&id)?;
    let resume = db::get_resume(state.pool()?, who.user.id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    crate::resumes::file_response(&state, &resume).await
}

#[derive(Deserialize)]
pub struct SaveItem {
    question: String,
    answer: String,
    #[serde(default)]
    company: String,
}

#[derive(Deserialize)]
pub struct SaveBody {
    answers: Vec<SaveItem>,
}

/// "Save my answers" from a form. An answer with a company is saved for that
/// company only.
pub async fn save_answers(
    State(state): State<AppState>,
    who: TokenUser,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<Value>> {
    if body.answers.len() > MAX_ANSWERS_PER_SAVE {
        return Err(ApiError::bad(format!(
            "Save at most {MAX_ANSWERS_PER_SAVE} answers at a time."
        )));
    }
    let mut saved = 0;
    let mut skipped = Vec::new();
    for (i, item) in body.answers.into_iter().enumerate() {
        let scope = if item.company.trim().is_empty() {
            Scope::Global
        } else {
            Scope::Company
        };
        let entry = AnswerEntry {
            question: item.question,
            answer: item.answer,
            company: item.company,
        };
        match crate::answers::upsert(&state, who.user.id, scope, entry).await {
            Ok(_) => saved += 1,
            Err(ApiError::BadRequest(why)) => skipped.push(json!({ "index": i, "error": why })),
            Err(other) => return Err(other),
        }
    }
    Ok(Json(json!({ "saved": saved, "skipped": skipped })))
}
