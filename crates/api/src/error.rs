//! One error type for every handler. Each becomes a JSON body
//! `{ "error": "<message>", "code": "<machine code>" }` with a fitting status.
//! Messages never carry user data, tokens or SQL.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub enum ApiError {
    BadRequest(String),
    /// Not signed in, or the session/token is no longer valid.
    Unauthorized,
    Forbidden(String),
    /// The action needs a recent sign-in (tokens, export, account deletion).
    Reauth,
    NotFound,
    Conflict(String),
    TooLarge(String),
    Unsupported(String),
    TooMany(String),
    Unavailable(String),
    Internal,
}

impl ApiError {
    pub fn bad(msg: impl Into<String>) -> Self {
        ApiError::BadRequest(msg.into())
    }

    fn parts(&self) -> (StatusCode, &'static str, String) {
        use ApiError::*;
        match self {
            BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m.clone()),
            Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Sign in to continue.".into(),
            ),
            Forbidden(m) => (StatusCode::FORBIDDEN, "forbidden", m.clone()),
            Reauth => (
                StatusCode::FORBIDDEN,
                "reauth",
                "For your security, sign in again to do this.".into(),
            ),
            NotFound => (StatusCode::NOT_FOUND, "not_found", "Not found".into()),
            Conflict(m) => (StatusCode::CONFLICT, "conflict", m.clone()),
            TooLarge(m) => (StatusCode::PAYLOAD_TOO_LARGE, "too_large", m.clone()),
            Unsupported(m) => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported", m.clone()),
            TooMany(m) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited", m.clone()),
            Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable", m.clone()),
            Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Something went wrong.".into(),
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.parts();
        (status, Json(json!({ "error": message, "code": code }))).into_response()
    }
}

impl From<db::DbError> for ApiError {
    fn from(err: db::DbError) -> Self {
        match err {
            db::DbError::NotMigrated => ApiError::Unavailable(
                "This isn't set up on the server yet: its database needs an update.".into(),
            ),
            db::DbError::Conflict(_) => ApiError::Conflict("That already exists.".into()),
            db::DbError::Other(e) => {
                // The error kind only: sqlx messages can quote values.
                eprintln!("db error: {}", sqlx_kind(&e));
                ApiError::Unavailable("The database is unavailable. Try again shortly.".into())
            }
        }
    }
}

fn sqlx_kind(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(d) => format!("database code {:?}", d.code()),
        sqlx::Error::PoolTimedOut => "pool timed out".into(),
        sqlx::Error::Io(_) => "io".into(),
        sqlx::Error::Tls(_) => "tls".into(),
        sqlx::Error::ColumnDecode { index, .. } => format!("column decode {index}"),
        other => format!("{:?}", std::mem::discriminant(other)),
    }
}

impl From<accounts::crypto::CryptoError> for ApiError {
    fn from(err: accounts::crypto::CryptoError) -> Self {
        match err {
            accounts::crypto::CryptoError::Missing => {
                ApiError::Unavailable("Encryption keys aren't configured on this server.".into())
            }
            other => {
                eprintln!("crypto error: {other}");
                ApiError::Internal
            }
        }
    }
}

impl From<accounts::storage::StorageError> for ApiError {
    fn from(err: accounts::storage::StorageError) -> Self {
        use accounts::storage::StorageError::*;
        match err {
            NotFound => ApiError::NotFound,
            Disabled(_) => {
                ApiError::Unavailable("File storage isn't configured on this server.".into())
            }
            BadKey => ApiError::Internal,
            Backend(why) => {
                eprintln!("storage error: {why}");
                ApiError::Unavailable("File storage is unavailable. Try again shortly.".into())
            }
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
