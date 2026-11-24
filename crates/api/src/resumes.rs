//! `/api/me/resumes`: upload, list, review, retitle/retag, default, delete,
//! download and re-parse.
//!
//! An upload is checked (type by content, size, macros), then, under a lock on
//! the user's row, checked against the quotas and inserted as `uploading`.
//! The file goes to object storage, the row is marked `stored`, and the text
//! is parsed with a time limit. A failed parse never fails the upload; it only
//! sets `parse_status`.

use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::multipart::MultipartRejection;
use axum::extract::{Multipart, Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use accounts::crypto::Field;
use accounts::parser::{PARSER_VERSION, ParsedResume, extract_text, parse_resume};
use accounts::tags::{SUGGESTED_TAGS, normalize_tags, normalize_title, split_tag_field};
use accounts::token::sha256;
use accounts::upload::{
    FileKind, MAX_FILE_BYTES, UploadError, check_file, default_title, sanitize_file_name,
};

use crate::AppState;
use crate::auth::Signed;
use crate::error::{ApiError, ApiResult};
use crate::housekeeping::delete_objects;
use crate::http::{JsonBody, attachment, parse_id, this_month, today};

const PARSE_TIMEOUT: Duration = Duration::from_secs(10);

/// "the file is empty" → "The file is empty."
pub fn sentence(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let mut chars = s.chars();
    let mut out: String = match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => return s,
    };
    if !out.ends_with('.') {
        out.push('.');
    }
    out
}

fn upload_error(e: UploadError) -> ApiError {
    match e {
        UploadError::TooLarge => ApiError::TooLarge(sentence(e)),
        UploadError::Unsupported | UploadError::LegacyDoc => ApiError::Unsupported(sentence(e)),
        other => ApiError::bad(sentence(other)),
    }
}

fn multipart_error(e: axum::extract::multipart::MultipartError) -> ApiError {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::TooLarge("Files can be at most 4 MB.".into())
    } else {
        ApiError::bad("Couldn't read the upload. Try again.")
    }
}

/// The parsed details, decrypted.
pub fn parsed_of(
    state: &AppState,
    user_id: Uuid,
    resume: &db::Resume,
) -> ApiResult<Option<ParsedResume>> {
    match &resume.parsed {
        Some(bytes) => Ok(Some(state.keyring()?.decrypt_json(
            Field::ResumeParsed,
            &user_id,
            bytes,
        )?)),
        None => Ok(None),
    }
}

/// Extracts and parses the file off the async runtime, with a time limit,
/// and stores the result (encrypted). Returns the parse status and result.
pub async fn parse_and_store(
    state: &AppState,
    user_id: Uuid,
    id: Uuid,
    kind: FileKind,
    bytes: Vec<u8>,
) -> ApiResult<(&'static str, Option<ParsedResume>)> {
    let keys = state.keyring()?;
    let job = tokio::task::spawn_blocking(move || {
        extract_text(kind, &bytes).map(|text| parse_resume(&text))
    });
    // A panic inside the PDF library, or a timeout, is just a failed parse.
    let (status, parsed) = match tokio::time::timeout(PARSE_TIMEOUT, job).await {
        Ok(Ok(Ok(parsed))) => ("parsed", Some(parsed)),
        Ok(Ok(Err(e))) => (e.status(), None),
        Ok(Err(_)) | Err(_) => ("failed", None),
    };
    let encrypted = parsed
        .as_ref()
        .map(|p| keys.encrypt_json(Field::ResumeParsed, &user_id, p));
    db::set_resume_parse(
        state.pool()?,
        user_id,
        id,
        status,
        PARSER_VERSION,
        encrypted.as_deref(),
    )
    .await?;
    Ok((status, parsed))
}

pub async fn list(State(state): State<AppState>, signed: Signed) -> ApiResult<Json<Value>> {
    let pool = state.pool()?;
    let user_id = signed.user.id;
    let resumes = db::list_resumes(pool, user_id).await?;
    let usage = db::resume_usage(pool, user_id).await?;
    let uploads_today =
        db::get_counter(pool, &format!("user:{user_id}"), "upload", &today()).await?;
    let c = &state.config;
    Ok(Json(json!({
        "resumes": resumes,
        "limits": {
            "maxResumes": c.max_resumes,
            "maxFileBytes": MAX_FILE_BYTES,
            "maxTotalBytes": c.max_user_bytes,
            "usedBytes": usage.bytes,
            "uploadsPerDay": c.uploads_per_day,
            "uploadsToday": uploads_today,
        },
        "suggestedTags": SUGGESTED_TAGS,
        "storage": state.storage.is_enabled(),
    })))
}

pub async fn upload(
    State(state): State<AppState>,
    signed: Signed,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let pool = state.pool()?;
    state.keyring()?;
    if !state.storage.is_enabled() {
        return Err(ApiError::Unavailable(
            "Resume uploads aren't available on this server yet.".into(),
        ));
    }
    let mut mp = multipart
        .map_err(|_| ApiError::Unsupported("Upload the file as multipart/form-data.".into()))?;

    let (mut file, mut file_name, mut title, mut tags_raw) =
        (None::<Vec<u8>>, String::new(), None, None);
    while let Some(field) = mp.next_field().await.map_err(multipart_error)? {
        match field.name() {
            Some("file") => {
                file_name = field.file_name().unwrap_or("resume").to_owned();
                let bytes = field.bytes().await.map_err(multipart_error)?;
                if bytes.len() > MAX_FILE_BYTES {
                    return Err(ApiError::TooLarge("Files can be at most 4 MB.".into()));
                }
                file = Some(bytes.to_vec());
            }
            Some("title") => title = Some(field.text().await.map_err(multipart_error)?),
            Some("tags") => tags_raw = Some(field.text().await.map_err(multipart_error)?),
            _ => {}
        }
    }
    let bytes = file.ok_or_else(|| ApiError::bad("Choose a file to upload."))?;
    let kind = check_file(&bytes).map_err(upload_error)?;
    let file_name = sanitize_file_name(&file_name, kind);
    let title = match title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => normalize_title(t),
        None => normalize_title(&default_title(&file_name)),
    }
    .map_err(|e| ApiError::bad(sentence(e)))?;
    let tags = normalize_tags(&split_tag_field(tags_raw.as_deref().unwrap_or("")))
        .map_err(|e| ApiError::bad(sentence(e)))?;
    let sha = sha256(&bytes);
    let size = bytes.len() as i64;
    let user_id = signed.user.id;
    let object_key = format!("resumes/{user_id}/{}", Uuid::new_v4());
    let c = &state.config;

    let mut tx = pool.begin().await.map_err(db::DbError::from)?;
    db::lock_user(&mut tx, user_id).await?;
    if db::resume_by_sha(&mut *tx, user_id, &sha).await?.is_some() {
        return Err(ApiError::Conflict(
            "You've already uploaded this file.".into(),
        ));
    }
    let usage = db::resume_usage(&mut *tx, user_id).await?;
    if usage.count >= c.max_resumes {
        return Err(ApiError::Forbidden(format!(
            "You can keep up to {} resumes. Delete one first.",
            c.max_resumes
        )));
    }
    if usage.bytes + size > c.max_user_bytes {
        return Err(ApiError::Forbidden(
            "Your resume storage is full. Delete a resume first.".into(),
        ));
    }
    let subject = format!("user:{user_id}");
    if db::get_counter(&mut *tx, &subject, "upload", &today()).await? >= c.uploads_per_day {
        return Err(ApiError::TooMany(format!(
            "You can upload {} files a day. Try again tomorrow.",
            c.uploads_per_day
        )));
    }
    if db::get_counter(&mut *tx, "global", "upload", &this_month()).await?
        >= c.uploads_per_month_global
        || db::total_resume_bytes(&mut *tx).await? + size > c.max_storage_bytes
    {
        return Err(ApiError::Unavailable(
            "Uploads are paused for now. Try again later.".into(),
        ));
    }
    db::bump_counter(&mut *tx, &subject, "upload", &today(), 1).await?;
    db::bump_counter(&mut *tx, "global", "upload", &this_month(), 1).await?;
    let has_default = db::list_resumes(&mut *tx, user_id)
        .await?
        .iter()
        .any(|r| r.is_default);
    let id = db::insert_resume(
        &mut *tx,
        &db::NewResume {
            user_id,
            title: &title,
            tags: &tags,
            is_default: !has_default,
            file_name: &file_name,
            mime_type: kind.mime(),
            size_bytes: size as i32,
            sha256: &sha,
            object_key: &object_key,
        },
    )
    .await?;
    tx.commit().await.map_err(db::DbError::from)?;

    if let Err(e) = state
        .storage
        .put(&object_key, bytes.clone(), kind.mime())
        .await
    {
        // Nothing half-written: the row goes, and the trigger queues the key
        // in case part of the object landed.
        db::discard_upload(pool, user_id, id).await.ok();
        return Err(e.into());
    }
    db::mark_resume_stored(pool, user_id, id).await?;
    db::audit(pool, Some(user_id), "resume_upload").await?;

    let (_, parsed) = parse_and_store(&state, user_id, id, kind, bytes).await?;
    // The first readable resume fills an empty profile straight away.
    let mut imported = Vec::new();
    if let Some(p) = &parsed
        && db::get_profile(pool, user_id).await?.is_none()
    {
        imported = crate::profile::import_parsed(&state, user_id, id, p)
            .await
            .unwrap_or_default();
    }
    let resume = db::get_resume(pool, user_id, id)
        .await?
        .ok_or(ApiError::Internal)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "resume": resume, "parsed": parsed, "imported": imported })),
    ))
}

pub async fn show(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let resume = db::get_resume(state.pool()?, signed.user.id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let parsed = parsed_of(&state, signed.user.id, &resume)?;
    Ok(Json(json!({ "resume": resume, "parsed": parsed })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBody {
    title: Option<String>,
    tags: Option<Vec<String>>,
    is_default: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<UpdateBody>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let pool = state.pool()?;
    let user_id = signed.user.id;
    let title = body
        .title
        .as_deref()
        .map(normalize_title)
        .transpose()
        .map_err(|e| ApiError::bad(sentence(e)))?;
    let tags = body
        .tags
        .as_deref()
        .map(normalize_tags)
        .transpose()
        .map_err(|e| ApiError::bad(sentence(e)))?;

    let mut tx = pool.begin().await.map_err(db::DbError::from)?;
    if (title.is_some() || tags.is_some())
        && !db::update_resume_meta(&mut *tx, user_id, id, title.as_deref(), tags.as_deref()).await?
    {
        return Err(ApiError::NotFound);
    }
    if body.is_default == Some(true) && !db::set_default_resume(&mut tx, user_id, id).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await.map_err(db::DbError::from)?;
    let resume = db::get_resume(pool, user_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "resume": resume })))
}

pub async fn remove(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    let pool = state.pool()?;
    let mut tx = pool.begin().await.map_err(db::DbError::from)?;
    let key = db::delete_resume(&mut tx, signed.user.id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await.map_err(db::DbError::from)?;
    db::audit(pool, Some(signed.user.id), "resume_delete").await?;
    delete_objects(&state, &[key]).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Streams a resume file back. Never inline: `attachment`, `nosniff` and a
/// sandbox CSP, so a crafted file can't run as a page on this origin.
pub async fn file_response(state: &AppState, resume: &db::Resume) -> ApiResult<Response> {
    let bytes = state.storage.get(&resume.object_key).await?;
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    let mime = HeaderValue::from_str(&resume.mime_type).map_err(|_| ApiError::Internal)?;
    h.insert(header::CONTENT_TYPE, mime);
    if let Ok(v) = HeaderValue::from_str(&attachment(&resume.file_name)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    Ok(res.into_response())
}

pub async fn file(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let id = parse_id(&id)?;
    let resume = db::get_resume(state.pool()?, signed.user.id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    file_response(&state, &resume).await
}

pub async fn reparse(
    State(state): State<AppState>,
    signed: Signed,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = parse_id(&id)?;
    let pool = state.pool()?;
    let user_id = signed.user.id;
    let resume = db::get_resume(pool, user_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let kind = FileKind::from_mime(&resume.mime_type).ok_or(ApiError::Internal)?;
    let bytes = state.storage.get(&resume.object_key).await?;
    let (_, parsed) = parse_and_store(&state, user_id, id, kind, bytes).await?;
    let resume = db::get_resume(pool, user_id, id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "resume": resume, "parsed": parsed })))
}

#[cfg(test)]
mod tests {
    use super::sentence;

    #[test]
    fn sentences() {
        assert_eq!(sentence("the file is empty"), "The file is empty.");
        assert_eq!(sentence("done."), "Done.");
    }
}
