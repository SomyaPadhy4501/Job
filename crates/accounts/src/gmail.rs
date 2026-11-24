//! The Gmail connector: Google's OAuth 2.0 authorization-code flow with PKCE
//! and OpenID Connect, and the narrow Gmail reading the extension needs.
//!
//! The flow (driven by `crates/api/src/connectors.rs`):
//! 1. The server makes a PKCE verifier (32 random bytes) and sends Google only
//!    its S256 challenge, with a random `state` (CSRF) and OIDC `nonce`
//!    (replay), all kept in an encrypted, browser-bound cookie.
//! 2. Google redirects back with a one-time `code`. The server checks `state`,
//!    then trades the code, the verifier and the client secret (which never
//!    leaves the server) for tokens. A stolen code is useless without both.
//! 3. The ID token is verified like a sign-in (Google's keys, this client as
//!    audience, the nonce from step 1) and names the Gmail account. Only a
//!    grant that includes `gmail.readonly` is kept.
//!
//! Reading is deliberately narrow: mail from Workday or Greenhouse only, from
//! the last 15 minutes, and the caller gets one code or one verify link, never
//! the message.

use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::token::{random_bytes, sha256};

pub const SCOPE_GMAIL: &str = "https://www.googleapis.com/auth/gmail.readonly";
/// `openid email` makes Google return an ID token naming the account.
pub const SCOPES: &str = "openid email https://www.googleapis.com/auth/gmail.readonly";
/// Mail older than this is never used: a code is for the application open now.
pub const MAX_AGE_MINUTES: i64 = 15;
/// Messages looked at per search.
pub const SEARCH_MAX: usize = 5;
const MAX_TEXT: usize = 200 * 1024;
const MAX_DEPTH: usize = 12;

/// Google's endpoints. Tests point them at a local fake.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
    pub revoke: String,
    /// Up to `/gmail/v1/users/me`.
    pub gmail: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            gmail: "https://gmail.googleapis.com/gmail/v1/users/me".into(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GmailError {
    /// The refresh token was revoked or expired (`invalid_grant`): the user
    /// has to connect again.
    #[error("the Gmail grant is no longer valid")]
    Revoked,
    /// The access token was refused; a fresh one may work.
    #[error("the access token was refused")]
    Unauthorized,
    /// Google refused for another reason (a short machine code, no user data).
    #[error("Google refused: {0}")]
    Refused(String),
    #[error("couldn't reach Google: {0}")]
    Unavailable(String),
    #[error("unexpected answer from Google")]
    BadResponse,
}

/// A PKCE pair (RFC 7636): the verifier stays on the server, Google sees only
/// the S256 challenge.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Self {
        // 32 bytes -> 43 base64url characters, the RFC's minimum length.
        let verifier = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
        let challenge = Self::challenge_of(&verifier);
        Pkce {
            verifier,
            challenge,
        }
    }

    pub fn challenge_of(verifier: &str) -> String {
        URL_SAFE_NO_PAD.encode(sha256(verifier.as_bytes()))
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// What Google's token endpoint answers.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenGrant {
    pub access_token: String,
    #[serde(default = "default_expiry")]
    pub expires_in: i64,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Space-separated; with granular consent the user may untick Gmail.
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub id_token: Option<String>,
}

fn default_expiry() -> i64 {
    3600
}

impl TokenGrant {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scope.split_whitespace().any(|s| s == scope)
    }
}

#[derive(Deserialize)]
struct OAuthError {
    #[serde(default)]
    error: String,
}

/// The confidential OAuth client for Gmail. The secret is never logged.
#[derive(Clone)]
pub struct GmailClient {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    endpoints: Endpoints,
    http: reqwest::Client,
}

impl std::fmt::Debug for GmailClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GmailClient")
            .field("client_id", &self.client_id)
            .field("redirect_uri", &self.redirect_uri)
            .finish_non_exhaustive()
    }
}

impl GmailClient {
    pub fn new(
        client_id: impl Into<String>,
        client_secret: impl Into<String>,
        redirect_uri: impl Into<String>,
        endpoints: Endpoints,
    ) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            // Google's answers are never redirects; following one could send
            // a token somewhere else.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("a TLS client");
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            redirect_uri: redirect_uri.into(),
            endpoints,
            http,
        }
    }

    /// `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` and the redirect URI
    /// (`GMAIL_REDIRECT_URI`, else `<site>/api/connectors/gmail/callback`).
    /// `None` unless the id and secret are both set: the connector is off.
    pub fn from_env(site_url: &str) -> Option<Self> {
        let get = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let id = get("GMAIL_CLIENT_ID")?;
        let secret = get("GMAIL_CLIENT_SECRET")?;
        let redirect = get("GMAIL_REDIRECT_URI").unwrap_or_else(|| {
            format!(
                "{}/api/connectors/gmail/callback",
                site_url.trim_end_matches('/')
            )
        });
        let ok = redirect.starts_with("https://")
            || redirect.starts_with("http://localhost:")
            || redirect.starts_with("http://127.0.0.1:");
        if !ok {
            eprintln!("GMAIL_REDIRECT_URI must be https (or http on localhost); Gmail is off");
            return None;
        }
        Some(Self::new(id, secret, redirect, Endpoints::default()))
    }

    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    pub fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    /// Google's consent page for this flow.
    pub fn authorize_url(
        &self,
        state: &str,
        nonce: &str,
        challenge: &str,
        login_hint: Option<&str>,
    ) -> String {
        let mut url = url::Url::parse(&self.endpoints.authorize).expect("a valid endpoint");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("client_id", &self.client_id)
                .append_pair("redirect_uri", &self.redirect_uri)
                .append_pair("response_type", "code")
                .append_pair("scope", SCOPES)
                .append_pair("state", state)
                .append_pair("nonce", nonce)
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
                // A refresh token, so codes can be read without asking again.
                .append_pair("access_type", "offline")
                // Always show consent: Google only returns a refresh token
                // then, and the user sees exactly what's asked.
                .append_pair("prompt", "consent")
                // Only the scopes asked for here, never earlier grants.
                .append_pair("include_granted_scopes", "false");
            if let Some(hint) = login_hint.filter(|h| h.contains('@') && h.len() <= 200) {
                q.append_pair("login_hint", hint);
            }
        }
        url.into()
    }

    /// Trades the one-time code and the PKCE verifier for tokens.
    pub async fn exchange(&self, code: &str, verifier: &str) -> Result<TokenGrant, GmailError> {
        self.token_request(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", &self.redirect_uri),
        ])
        .await
    }

    /// A fresh access token from the refresh token.
    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenGrant, GmailError> {
        self.token_request(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .await
    }

    async fn token_request(&self, params: &[(&str, &str)]) -> Result<TokenGrant, GmailError> {
        let mut form: Vec<(&str, &str)> = vec![
            ("client_id", &self.client_id),
            ("client_secret", &self.client_secret),
        ];
        form.extend_from_slice(params);
        let res = self
            .http
            .post(&self.endpoints.token)
            .form(&form)
            .send()
            .await
            .map_err(|e| GmailError::Unavailable(e.without_url().to_string()))?;
        let status = res.status();
        if status.is_server_error() {
            return Err(GmailError::Unavailable(format!("HTTP {}", status.as_u16())));
        }
        if !status.is_success() {
            let err = res
                .json::<OAuthError>()
                .await
                .map(|e| e.error)
                .unwrap_or_default();
            return Err(match err.as_str() {
                "invalid_grant" => GmailError::Revoked,
                "" => GmailError::Refused(format!("HTTP {}", status.as_u16())),
                other => GmailError::Refused(short_code(other)),
            });
        }
        let grant: TokenGrant = res.json().await.map_err(|_| GmailError::BadResponse)?;
        if grant.access_token.is_empty() {
            return Err(GmailError::BadResponse);
        }
        Ok(grant)
    }

    /// Revokes a token (a refresh token revokes the whole grant). Google
    /// answers 400 for a token that's already gone, which is fine.
    pub async fn revoke(&self, token: &str) -> Result<(), GmailError> {
        let res = self
            .http
            .post(&self.endpoints.revoke)
            .form(&[("token", token)])
            .send()
            .await
            .map_err(|e| GmailError::Unavailable(e.without_url().to_string()))?;
        if res.status().is_server_error() {
            return Err(GmailError::Unavailable(format!(
                "HTTP {}",
                res.status().as_u16()
            )));
        }
        Ok(())
    }

    async fn gmail_get(&self, access: &str, path_and_query: &str) -> Result<Value, GmailError> {
        let res = self
            .http
            .get(format!("{}{}", self.endpoints.gmail, path_and_query))
            .bearer_auth(access)
            .send()
            .await
            .map_err(|e| GmailError::Unavailable(e.without_url().to_string()))?;
        match res.status().as_u16() {
            200 => res.json().await.map_err(|_| GmailError::BadResponse),
            401 => Err(GmailError::Unauthorized),
            403 => Err(GmailError::Refused("forbidden".into())),
            s if s >= 500 || s == 429 => Err(GmailError::Unavailable(format!("HTTP {s}"))),
            s => Err(GmailError::Refused(format!("HTTP {s}"))),
        }
    }

    /// Ids of the newest messages matching a Gmail search.
    pub async fn search(&self, access: &str, q: &str) -> Result<Vec<String>, GmailError> {
        let query: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("maxResults", &SEARCH_MAX.to_string())
            .append_pair("q", q)
            .finish();
        let list = self
            .gmail_get(access, &format!("/messages?{query}"))
            .await?;
        Ok(list["messages"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|m| m["id"].as_str())
                    .filter(|id| is_message_id(id))
                    .take(SEARCH_MAX)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn message(&self, access: &str, id: &str) -> Result<Message, GmailError> {
        if !is_message_id(id) {
            return Err(GmailError::BadResponse);
        }
        let raw = self
            .gmail_get(access, &format!("/messages/{id}?format=full"))
            .await?;
        Ok(parse_message(id, &raw))
    }
}

/// An OAuth error code, cut short and limited to its alphabet, for logs.
fn short_code(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(40)
        .collect()
}

/// Gmail message ids are hex; anything else never goes into a URL path.
pub fn is_message_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ---------------------------------------------------------------------------
// Reading

/// The job sites whose mail may be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Site {
    Workday,
    Greenhouse,
}

impl Site {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "workday" => Some(Site::Workday),
            "greenhouse" => Some(Site::Greenhouse),
            _ => None,
        }
    }

    /// The Gmail search: this site's own senders, from the last day (the
    /// 15-minute cut is applied to each message's own date).
    pub fn query(self) -> &'static str {
        match self {
            Site::Workday => "from:myworkday.com newer_than:1d",
            Site::Greenhouse => "from:(greenhouse.io OR greenhouse-mail.io) newer_than:1d",
        }
    }
}

/// A message reduced to what's needed: its sender, plain text and links.
#[derive(Debug, Clone, Default)]
pub struct Message {
    pub id: String,
    /// Milliseconds since the epoch, Gmail's `internalDate`.
    pub received_ms: i64,
    pub from: String,
    pub text: String,
    pub hrefs: Vec<String>,
}

static HREF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)href\s*=\s*["']([^"']+)["']"#).unwrap());
static STYLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<(style|script)[^>]*>.*?</(style|script)>").unwrap());
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+").unwrap());
static TEXT_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"https://[^\s<>"')]+"#).unwrap());
static KEYWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:code|passcode|pin|one[- ]time)\b").unwrap());
static WORKDAY_FROM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<?([^<@\s]+)@myworkday\.com>?").unwrap());
static WORKDAY_SITE_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^/(?:[a-z]{2}(?:-[a-z]{2})?/)?recruiting/([^/]+)").unwrap());
static VERIFY_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)verif|activat|confirm").unwrap());

const B64_ANY_PADDING: GeneralPurpose = GeneralPurpose::new(
    &base64::alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

fn unescape(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The text and links of a Gmail API message (`format=full`).
pub fn parse_message(id: &str, raw: &Value) -> Message {
    let mut texts = Vec::new();
    let mut hrefs = Vec::new();
    walk(&raw["payload"], 0, &mut texts, &mut hrefs);
    let mut text = SPACES.replace_all(&texts.join("\n"), " ").into_owned();
    if text.len() > MAX_TEXT {
        text = crate::truncate_chars(&text, MAX_TEXT).to_owned();
    }
    hrefs.extend(TEXT_URL.find_iter(&text).map(|m| m.as_str().to_owned()));
    let from = raw["payload"]["headers"]
        .as_array()
        .and_then(|hs| {
            hs.iter().find(|h| {
                h["name"]
                    .as_str()
                    .is_some_and(|n| n.eq_ignore_ascii_case("from"))
            })
        })
        .and_then(|h| h["value"].as_str())
        .unwrap_or_default()
        .to_owned();
    Message {
        id: id.to_owned(),
        received_ms: raw["internalDate"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0),
        from,
        text,
        hrefs,
    }
}

fn walk(part: &Value, depth: usize, texts: &mut Vec<String>, hrefs: &mut Vec<String>) {
    if depth > MAX_DEPTH || !part.is_object() {
        return;
    }
    let mime = part["mimeType"].as_str().unwrap_or("").to_ascii_lowercase();
    if let Some(data) = part["body"]["data"].as_str()
        && (mime == "text/plain" || mime == "text/html")
        && let Ok(bytes) = B64_ANY_PADDING.decode(data)
    {
        let raw = String::from_utf8_lossy(&bytes);
        if mime == "text/html" {
            hrefs.extend(HREF.captures_iter(&raw).map(|c| unescape(&c[1])));
            let stripped = STYLE.replace_all(&raw, " ");
            texts.push(unescape(&TAG.replace_all(&stripped, " ")));
        } else {
            texts.push(raw.into_owned());
        }
    }
    if let Some(parts) = part["parts"].as_array() {
        for p in parts {
            walk(p, depth + 1, texts, hrefs);
        }
    }
}

/// The Workday company a sender belongs to: `<tenant>@myworkday.com`.
pub fn workday_sender(from: &str) -> Option<String> {
    WORKDAY_FROM
        .captures(from)
        .map(|c| c[1].to_ascii_lowercase())
}

/// The Workday company a link belongs to (same rule as the extension's
/// `JobApplicationPages.workdayTenant`).
pub fn workday_tenant(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if let Some(rest) = host.strip_suffix(".myworkdayjobs.com") {
        return rest
            .split('.')
            .next()
            .filter(|t| !t.is_empty())
            .map(str::to_owned);
    }
    if host == "myworkdaysite.com" || host.ends_with(".myworkdaysite.com") {
        return WORKDAY_SITE_PATH
            .captures(url.path())
            .map(|c| c[1].to_ascii_lowercase());
    }
    None
}

/// This company's own "verify your account" link, https only.
pub fn verify_link(hrefs: &[String], tenant: &str) -> Option<String> {
    hrefs
        .iter()
        .find(|h| {
            let Ok(u) = url::Url::parse(h) else {
                return false;
            };
            let target = format!("{}?{}", u.path(), u.query().unwrap_or(""));
            u.scheme() == "https"
                && u.username().is_empty()
                && u.password().is_none()
                && workday_tenant(h).as_deref() == Some(tenant)
                && VERIFY_PATH.is_match(&target)
        })
        .cloned()
}

/// What a code box asks for.
#[derive(Debug, Clone, Copy, Default)]
pub struct CodeShape {
    /// Exact length (4–10), or any length from 4 to 10.
    pub length: Option<usize>,
    pub digits_only: bool,
}

/// A code of the asked shape: the first code-shaped word (with a digit in
/// it) within 80 characters after "code", "passcode", "PIN" or "one-time",
/// else a line holding nothing but the code.
pub fn pick_code(text: &str, shape: CodeShape) -> Option<String> {
    let fits = |w: &str| {
        let n = w.chars().count();
        let length_ok = match shape.length {
            Some(l) => n == l,
            None => (4..=10).contains(&n),
        };
        length_ok
            && w.chars().all(|c| {
                if shape.digits_only {
                    c.is_ascii_digit()
                } else {
                    c.is_ascii_alphanumeric()
                }
            })
            && w.chars().any(|c| c.is_ascii_digit())
    };
    for m in KEYWORD.find_iter(text) {
        let after: String = text[m.end()..].chars().take(80).collect();
        if let Some(w) = after
            .split(|c: char| !c.is_ascii_alphanumeric())
            .find(|w| fits(w))
        {
            return Some(w.to_owned());
        }
    }
    text.lines()
        .map(str::trim)
        .find(|l| fits(l))
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn b64(s: &str) -> String {
        URL_SAFE_NO_PAD.encode(s)
    }

    #[test]
    fn pkce_challenge_is_s256_of_the_verifier() {
        // RFC 7636, appendix B.
        assert_eq!(
            Pkce::challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let p = Pkce::new();
        assert_eq!(p.verifier.len(), 43);
        assert_eq!(p.challenge, Pkce::challenge_of(&p.verifier));
        assert_ne!(Pkce::new().verifier, p.verifier);
    }

    #[test]
    fn authorize_url_asks_for_code_with_pkce_and_oidc() {
        let c = GmailClient::new(
            "cid",
            "secret",
            "https://site.example/api/connectors/gmail/callback",
            Endpoints::default(),
        );
        let url =
            url::Url::parse(&c.authorize_url("st", "no", "ch", Some("pat@example.com"))).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge"], "ch");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert_eq!(q["nonce"], "no");
        assert_eq!(q["scope"], SCOPES);
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["login_hint"], "pat@example.com");
        assert!(
            !url.as_str().contains("secret"),
            "the secret never goes to the browser"
        );
        assert!(!q.contains_key("code_verifier"));
    }

    #[test]
    fn debug_hides_the_secret() {
        let c = GmailClient::new("cid", "s3cr3t", "https://x/cb", Endpoints::default());
        assert!(!format!("{c:?}").contains("s3cr3t"));
    }

    #[test]
    fn scopes_are_checked_one_by_one() {
        let g = TokenGrant {
            access_token: "a".into(),
            expires_in: 3600,
            refresh_token: None,
            scope: "openid https://www.googleapis.com/auth/gmail.readonly.extra email".into(),
            id_token: None,
        };
        assert!(!g.has_scope(SCOPE_GMAIL), "a prefix is not the scope");
        assert!(g.has_scope("email"));
    }

    #[test]
    fn codes_of_the_asked_shape() {
        let six = CodeShape {
            length: Some(6),
            digits_only: true,
        };
        assert_eq!(
            pick_code("Your verification code is 482913. It expires soon.", six).as_deref(),
            Some("482913")
        );
        assert_eq!(pick_code("Your code: 1234", six), None, "wrong length");
        let alnum = CodeShape {
            length: Some(6),
            digits_only: false,
        };
        assert_eq!(
            pick_code("Use code ABCDEF to continue", alnum),
            None,
            "a word, not a code"
        );
        let gh = "Copy and paste this code into the security code field on your application:\n\nA1B2C3D4\n";
        assert_eq!(
            pick_code(
                gh,
                CodeShape {
                    length: Some(8),
                    digits_only: false
                }
            )
            .as_deref(),
            Some("A1B2C3D4")
        );
        assert_eq!(
            pick_code("Hello\n  9137  \nThanks", CodeShape::default()).as_deref(),
            Some("9137"),
            "a line holding only the code"
        );
        // Multibyte text right after the keyword doesn't break slicing.
        assert_eq!(
            pick_code("code ééé 55667788", CodeShape::default()).as_deref(),
            Some("55667788")
        );
    }

    #[test]
    fn messages_are_reduced_to_text_and_links() {
        let html = "<style>.x{}</style><p>Your code&nbsp;is <b>778899</b></p>\
                    <a href=\"https://acme.wd5.myworkdayjobs.com/en-US/External/activate?token=abc&amp;x=1\">Verify</a>";
        let raw = json!({
            "internalDate": "1700000000000",
            "payload": {
                "mimeType": "multipart/alternative",
                "headers": [{"name": "From", "value": "Acme <acme@myworkday.com>"}],
                "parts": [
                    {"mimeType": "text/plain", "body": {"data": b64("plain part https://example.com/a")}},
                    {"mimeType": "text/html", "body": {"data": b64(html)}},
                    {"mimeType": "image/png", "body": {"data": b64("ignored")}}
                ]
            }
        });
        let m = parse_message("abc123", &raw);
        assert_eq!(m.received_ms, 1_700_000_000_000);
        assert_eq!(workday_sender(&m.from).as_deref(), Some("acme"));
        assert!(m.text.contains("Your code is 778899"));
        assert!(!m.text.contains(".x{}"));
        assert!(m.hrefs.contains(
            &"https://acme.wd5.myworkdayjobs.com/en-US/External/activate?token=abc&x=1".to_owned()
        ));
        assert!(m.hrefs.contains(&"https://example.com/a".to_owned()));
    }

    #[test]
    fn verify_links_only_for_this_company() {
        let hrefs: Vec<String> = [
            "https://evil.example/verify?x=1",
            "https://other.wd5.myworkdayjobs.com/verify?t=2",
            "http://acme.wd5.myworkdayjobs.com/verify?t=3",
            "https://acme.wd5.myworkdayjobs.com/en-US/External/jobs",
            "https://acme.wd5.myworkdayjobs.com/en-US/External/activate?token=abc",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            verify_link(&hrefs, "acme").as_deref(),
            Some("https://acme.wd5.myworkdayjobs.com/en-US/External/activate?token=abc")
        );
        assert_eq!(verify_link(&hrefs, "nobody"), None);
    }

    #[test]
    fn workday_tenants() {
        assert_eq!(
            workday_tenant("https://Acme.wd5.myworkdayjobs.com/x").as_deref(),
            Some("acme")
        );
        assert_eq!(
            workday_tenant("https://wd3.myworkdaysite.com/en-US/recruiting/Globex/jobs").as_deref(),
            Some("globex")
        );
        assert_eq!(
            workday_tenant("https://myworkdayjobs.com.evil.example/x"),
            None
        );
        assert_eq!(workday_tenant("not a url"), None);
        assert_eq!(
            workday_sender("Other <other@myworkday.com>").as_deref(),
            Some("other")
        );
        assert_eq!(workday_sender("x@greenhouse.io"), None);
    }

    #[test]
    fn message_ids_are_plain() {
        assert!(is_message_id("18c2f0a9b1"));
        assert!(!is_message_id("../../profile"));
        assert!(!is_message_id(""));
    }
}
