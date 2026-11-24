//! `/api/me/profile`: the autofill profile, encrypted at rest.
//!
//! Each write names the version it started from; if someone else (another
//! tab, the extension) wrote since, the write is refused with 409 instead of
//! silently overwriting. `sources` records whether each field was typed by
//! the user or filled from a resume, so importing a resume never replaces
//! what the user typed.

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use accounts::crypto::Field;
use accounts::parser::ParsedResume;
use accounts::profile::{
    MAX_PROFILE_BYTES, Profile, SCHEMA, Sources, import_resume, mark_user_edits,
};

use crate::AppState;
use crate::auth::Signed;
use crate::error::{ApiError, ApiResult};
use crate::http::{JsonBody, parse_id};
use crate::resumes::{parsed_of, sentence};

pub struct Stored {
    pub profile: Profile,
    pub sources: Sources,
    /// 0 when the user has no profile yet.
    pub version: i32,
}

pub async fn load(state: &AppState, user_id: Uuid) -> ApiResult<Stored> {
    match db::get_profile(state.pool()?, user_id).await? {
        Some(row) => Ok(Stored {
            profile: state
                .keyring()?
                .decrypt_json(Field::ProfileData, &user_id, &row.data)?,
            sources: serde_json::from_value(row.sources).unwrap_or_default(),
            version: row.version,
        }),
        None => Ok(Stored {
            profile: Profile {
                schema: SCHEMA,
                ..Profile::default()
            },
            sources: Sources::new(),
            version: 0,
        }),
    }
}

const CONFLICT: &str = "Your profile was changed somewhere else (another tab or the extension). Reload to get the latest version.";

async fn store(
    state: &AppState,
    user_id: Uuid,
    expected: i32,
    profile: &Profile,
    sources: &Sources,
) -> ApiResult<i32> {
    let json = serde_json::to_vec(profile).map_err(|_| ApiError::Internal)?;
    if json.len() > MAX_PROFILE_BYTES {
        return Err(ApiError::TooLarge(
            "The profile is over 64 KB. Shorten the longer fields.".into(),
        ));
    }
    let data = state
        .keyring()?
        .encrypt(Field::ProfileData, &user_id, &json);
    let sources = serde_json::to_value(sources).map_err(|_| ApiError::Internal)?;
    db::save_profile(state.pool()?, user_id, expected, &data, &sources)
        .await?
        .ok_or_else(|| ApiError::Conflict(CONFLICT.into()))
}

fn view(s: &Stored) -> Value {
    json!({ "profile": s.profile, "sources": s.sources, "version": s.version })
}

pub async fn show(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    Ok(Json(view(&load(&state, signed.user.id).await?)))
}

#[derive(Deserialize)]
pub struct SaveBody {
    profile: Profile,
    /// The version this edit started from (0 for a first save).
    version: i32,
}

pub async fn save(
    State(state): State<AppState>,
    signed: Signed,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<Value>> {
    let user_id = signed.user.id;
    let mut profile = body.profile;
    profile.validate().map_err(|e| ApiError::bad(sentence(e)))?;
    let mut current = load(&state, user_id).await?;
    if body.version != current.version {
        return Err(ApiError::Conflict(CONFLICT.into()));
    }
    mark_user_edits(&current.profile, &profile, &mut current.sources);
    let version = store(&state, user_id, current.version, &profile, &current.sources).await?;
    Ok(Json(view(&Stored {
        profile,
        sources: current.sources,
        version,
    })))
}

/// Fills the profile from a parsed resume (only empty or resume-filled
/// fields). Returns the field paths that changed.
pub async fn import_parsed(
    state: &AppState,
    user_id: Uuid,
    resume_id: Uuid,
    parsed: &ParsedResume,
) -> ApiResult<Vec<String>> {
    let mut current = load(state, user_id).await?;
    let changed = import_resume(
        &mut current.profile,
        &mut current.sources,
        &parsed.to_profile(),
        &resume_id,
    );
    if !changed.is_empty() || current.version == 0 {
        store(
            state,
            user_id,
            current.version,
            &current.profile,
            &current.sources,
        )
        .await?;
    }
    Ok(changed)
}

pub async fn import(
    State(state): State<AppState>,
    signed: Signed,
    Path(resume_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let resume_id = parse_id(&resume_id)?;
    let user_id = signed.user.id;
    let resume = db::get_resume(state.pool()?, user_id, resume_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let parsed = parsed_of(&state, user_id, &resume)?.ok_or_else(|| {
        ApiError::bad("Nothing could be read from this resume. Fill in your profile by hand.")
    })?;
    let changed = import_parsed(&state, user_id, resume_id, &parsed).await?;
    let mut out = view(&load(&state, user_id).await?);
    out["changed"] = json!(changed);
    Ok(Json(out))
}
