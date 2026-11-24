//! Small HTTP helpers: cookies, the caller's IP, a JSON extractor with JSON
//! errors, id parsing, quota periods, and the CSRF check.

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::ApiError;

/// Reads one cookie from the request.
pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.trim())
        .filter(|v| !v.is_empty())
}

pub struct CookieSpec<'a> {
    pub name: &'a str,
    pub value: &'a str,
    pub max_age: i64,
    pub http_only: bool,
    pub secure: bool,
}

pub fn set_cookie(c: CookieSpec<'_>) -> String {
    let mut s = format!(
        "{}={}; Path=/; SameSite=Lax; Max-Age={}",
        c.name,
        c.value,
        c.max_age.max(0)
    );
    if c.http_only {
        s.push_str("; HttpOnly");
    }
    if c.secure {
        s.push_str("; Secure");
    }
    s
}

/// The caller's IP as Vercel reports it. Used only hashed, for rate limits.
pub fn client_ip(headers: &HeaderMap) -> String {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim);
    let real = headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim);
    forwarded
        .or(real)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_owned()
}

pub fn user_agent(headers: &HeaderMap) -> String {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    accounts::truncate_chars(&accounts::clean_line(ua), 200).to_owned()
}

/// `Json<T>`, but a bad body becomes a JSON error: 415 for a missing JSON
/// content type, 413 for an oversized body, 400 otherwise.
pub struct JsonBody<T>(pub T);

impl<S, T> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(v)) => Ok(JsonBody(v)),
            Err(JsonRejection::MissingJsonContentType(_)) => Err(ApiError::Unsupported(
                "Send JSON (Content-Type: application/json).".into(),
            )),
            Err(e) if e.status() == StatusCode::PAYLOAD_TOO_LARGE => {
                Err(ApiError::TooLarge("The request is too large.".into()))
            }
            Err(JsonRejection::JsonDataError(e)) => {
                Err(ApiError::bad(format!("Invalid request: {}", e.body_text())))
            }
            Err(_) => Err(ApiError::bad("The request body isn't valid JSON.")),
        }
    }
}

/// Ids in paths: anything that isn't a UUID is simply not found.
pub fn parse_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::NotFound)
}

pub fn today() -> String {
    let d = OffsetDateTime::now_utc().date();
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

pub fn this_month() -> String {
    let d = OffsetDateTime::now_utc().date();
    format!("{:04}-{:02}", d.year(), u8::from(d.month()))
}

/// CSRF protection for cookie-authenticated routes, run before any body is
/// read. A state-changing request must:
/// - carry `X-Requested-With: fetch`, a header a cross-site form can't send
///   and a cross-site `fetch` can't send without a CORS preflight we never
///   approve;
/// - not be marked cross-site by `Sec-Fetch-Site`;
/// - if it has an `Origin`, come from this host.
pub async fn csrf(req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    if let Err(why) = check_csrf(req.headers()) {
        return ApiError::Forbidden(why.into()).into_response();
    }
    next.run(req).await
}

fn check_csrf(h: &HeaderMap) -> Result<(), &'static str> {
    let xrw = h
        .get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !xrw.eq_ignore_ascii_case("fetch") {
        return Err("Missing X-Requested-With: fetch.");
    }
    if let Some(site) = h.get("sec-fetch-site").and_then(|v| v.to_str().ok())
        && !matches!(site, "same-origin" | "none")
    {
        return Err("Cross-site requests aren't allowed.");
    }
    if let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let host = h
            .get("x-forwarded-host")
            .or_else(|| h.get(header::HOST))
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let origin_host = origin.split_once("://").map(|(_, rest)| rest).unwrap_or("");
        if host.is_empty() || !origin_host.eq_ignore_ascii_case(host) {
            return Err("Requests from other sites aren't allowed.");
        }
    }
    Ok(())
}

/// `Content-Disposition` for a download, with an ASCII fallback name.
pub fn attachment(file_name: &str) -> String {
    let ascii: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for b in file_name.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(b) {
            encoded.push(*b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn reads_cookies() {
        let h = headers(&[("cookie", "a=1; jb_sid=abc ; b="), ("cookie", "c=3")]);
        assert_eq!(cookie(&h, "jb_sid"), Some("abc"));
        assert_eq!(cookie(&h, "c"), Some("3"));
        assert_eq!(cookie(&h, "b"), None);
        assert_eq!(cookie(&h, "missing"), None);
    }

    #[test]
    fn csrf_rules() {
        let ok = headers(&[
            ("x-requested-with", "fetch"),
            ("host", "job.example"),
            ("origin", "https://job.example"),
        ]);
        assert!(check_csrf(&ok).is_ok());
        assert!(
            check_csrf(&headers(&[("host", "job.example")])).is_err(),
            "header required"
        );
        let other = headers(&[
            ("x-requested-with", "fetch"),
            ("host", "job.example"),
            ("origin", "https://evil.example"),
        ]);
        assert!(check_csrf(&other).is_err());
        let cross = headers(&[
            ("x-requested-with", "fetch"),
            ("sec-fetch-site", "cross-site"),
        ]);
        assert!(check_csrf(&cross).is_err());
        // Vite's proxy keeps the browser's Host, so localhost dev passes.
        let dev = headers(&[
            ("x-requested-with", "fetch"),
            ("host", "localhost:5173"),
            ("origin", "http://localhost:5173"),
        ]);
        assert!(check_csrf(&dev).is_ok());
    }

    #[test]
    fn attachment_names_are_safe() {
        assert_eq!(
            attachment("cv.pdf"),
            "attachment; filename=\"cv.pdf\"; filename*=UTF-8''cv.pdf"
        );
        let h = attachment("Zoë \"x\".pdf");
        assert!(h.starts_with("attachment; filename=\"Zo_ _x_.pdf\""), "{h}");
        assert!(h.contains("Zo%C3%AB%20%22x%22.pdf"));
    }
}
