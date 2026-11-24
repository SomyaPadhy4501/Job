//! Checking Google sign-in: the ID token (the `credential` the Google
//! Identity Services button gives the page) is verified against Google's
//! published signing keys, for this app's client ID, with the nonce this
//! browser was given.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use tokio::sync::RwLock;

const JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS: [&str; 2] = ["accounts.google.com", "https://accounts.google.com"];
const LEEWAY_SECS: u64 = 30;
const DEFAULT_KEY_TTL: Duration = Duration::from_secs(3600);
/// An unknown key id triggers a refetch at most this often, so forged tokens
/// can't make us hammer Google.
const MIN_REFETCH: Duration = Duration::from_secs(60);
const MAX_CREDENTIAL_LEN: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleIdentity {
    pub sub: String,
    pub email: String,
    pub name: String,
    pub picture: String,
}

#[derive(Debug, thiserror::Error)]
pub enum GoogleError {
    #[error("Google sign-in isn't configured (GOOGLE_CLIENT_ID is missing)")]
    NotConfigured,
    #[error("the sign-in token is invalid: {0}")]
    Invalid(String),
    #[error("the Google account's email address isn't verified")]
    EmailUnverified,
    #[error("the sign-in didn't come from this page; reload and try again")]
    NonceMismatch,
    #[error("couldn't reach Google to check the sign-in: {0}")]
    KeysUnavailable(String),
}

/// Google sends `email_verified` as a boolean, but some older tokens carry it
/// as the string "true".
#[derive(Debug, Default, Deserialize)]
#[serde(untagged)]
enum Flag {
    Bool(bool),
    Text(String),
    #[default]
    Missing,
}

impl Flag {
    fn is_true(&self) -> bool {
        match self {
            Flag::Bool(b) => *b,
            Flag::Text(s) => s == "true",
            Flag::Missing => false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    email_verified: Flag,
    #[serde(default)]
    name: String,
    #[serde(default)]
    picture: String,
    #[serde(default)]
    nonce: String,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kid: String,
    kty: String,
    #[serde(default)]
    alg: Option<String>,
    n: String,
    e: String,
}

struct KeySet {
    keys: HashMap<String, DecodingKey>,
    expires: Instant,
    fetched: Instant,
}

pub struct GoogleVerifier {
    client_id: Option<String>,
    http: reqwest::Client,
    keys: RwLock<Option<KeySet>>,
    /// Keys given up front (tests); never fetched.
    fixed: bool,
}

impl GoogleVerifier {
    pub fn new(client_id: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("a TLS client");
        Self {
            client_id: client_id.filter(|c| !c.trim().is_empty()),
            http,
            keys: RwLock::new(None),
            fixed: false,
        }
    }

    /// A verifier that trusts only the given keys and never calls Google.
    pub fn with_keys(client_id: &str, keys: Vec<(String, DecodingKey)>) -> Self {
        let set = KeySet {
            keys: keys.into_iter().collect(),
            expires: Instant::now() + Duration::from_secs(10 * 365 * 24 * 3600),
            fetched: Instant::now(),
        };
        Self {
            client_id: Some(client_id.to_owned()),
            http: reqwest::Client::new(),
            keys: RwLock::new(Some(set)),
            fixed: true,
        }
    }

    pub fn client_id(&self) -> Option<&str> {
        self.client_id.as_deref()
    }

    pub async fn verify(
        &self,
        credential: &str,
        expected_nonce: &str,
    ) -> Result<GoogleIdentity, GoogleError> {
        let client_id = self
            .client_id
            .as_deref()
            .ok_or(GoogleError::NotConfigured)?;
        if credential.is_empty() || credential.len() > MAX_CREDENTIAL_LEN {
            return Err(GoogleError::Invalid("missing or oversized".into()));
        }
        let header = decode_header(credential).map_err(|e| GoogleError::Invalid(e.to_string()))?;
        if header.alg != Algorithm::RS256 {
            return Err(GoogleError::Invalid("unexpected signing algorithm".into()));
        }
        let kid = header
            .kid
            .ok_or_else(|| GoogleError::Invalid("no key id".into()))?;
        let key = self.key(&kid).await?;

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[client_id]);
        validation.set_issuer(&ISSUERS);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = LEEWAY_SECS;
        let claims = decode::<Claims>(credential, &key, &validation)
            .map_err(|e| GoogleError::Invalid(e.to_string()))?
            .claims;

        if claims.sub.trim().is_empty() {
            return Err(GoogleError::Invalid("no subject".into()));
        }
        if claims.email.is_empty() || !claims.email_verified.is_true() {
            return Err(GoogleError::EmailUnverified);
        }
        if expected_nonce.is_empty()
            || !crate::token::ct_eq(claims.nonce.as_bytes(), expected_nonce.as_bytes())
        {
            return Err(GoogleError::NonceMismatch);
        }
        Ok(GoogleIdentity {
            sub: claims.sub,
            email: claims.email,
            name: claims.name,
            picture: claims.picture,
        })
    }

    async fn key(&self, kid: &str) -> Result<DecodingKey, GoogleError> {
        let unknown = || GoogleError::Invalid("signed with an unknown key".into());
        {
            let guard = self.keys.read().await;
            if let Some(set) = guard.as_ref() {
                let fresh = self.fixed || set.expires > Instant::now();
                match set.keys.get(kid) {
                    Some(key) if fresh => return Ok(key.clone()),
                    None if self.fixed || (fresh && set.fetched.elapsed() < MIN_REFETCH) => {
                        return Err(unknown());
                    }
                    _ => {}
                }
            }
        }
        if self.fixed {
            return Err(unknown());
        }
        let mut guard = self.keys.write().await;
        // Another request may have refreshed the keys while this one waited.
        if let Some(set) = guard.as_ref()
            && set.fetched.elapsed() < MIN_REFETCH
        {
            return set.keys.get(kid).cloned().ok_or_else(unknown);
        }
        let set = self.fetch().await?;
        let found = set.keys.get(kid).cloned();
        *guard = Some(set);
        found.ok_or_else(unknown)
    }

    async fn fetch(&self) -> Result<KeySet, GoogleError> {
        let unavailable = |e: reqwest::Error| GoogleError::KeysUnavailable(e.to_string());
        let res = self
            .http
            .get(JWKS_URL)
            .send()
            .await
            .map_err(unavailable)?
            .error_for_status()
            .map_err(unavailable)?;
        let ttl = res
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .and_then(max_age)
            .unwrap_or(DEFAULT_KEY_TTL);
        let jwks: Jwks = res.json().await.map_err(unavailable)?;
        let keys = jwks
            .keys
            .into_iter()
            .filter(|k| k.kty == "RSA" && k.alg.as_deref().is_none_or(|a| a == "RS256"))
            .filter_map(|k| {
                DecodingKey::from_rsa_components(&k.n, &k.e)
                    .ok()
                    .map(|key| (k.kid, key))
            })
            .collect();
        let now = Instant::now();
        Ok(KeySet {
            keys,
            expires: now + ttl,
            fetched: now,
        })
    }
}

/// `max-age` from a Cache-Control header, capped at a day.
fn max_age(cache_control: &str) -> Option<Duration> {
    cache_control
        .split(',')
        .filter_map(|d| d.trim().strip_prefix("max-age="))
        .find_map(|v| v.trim().parse::<u64>().ok())
        .map(|secs| Duration::from_secs(secs.min(24 * 3600)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{TEST_CLIENT_ID, TEST_KID, sign_google_token, test_verifier};
    use serde_json::json;

    fn claims(overrides: serde_json::Value) -> serde_json::Value {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let mut base = json!({
            "iss": "https://accounts.google.com",
            "aud": TEST_CLIENT_ID,
            "sub": "1234567890",
            "email": "jane@example.com",
            "email_verified": true,
            "name": "Jane Doe",
            "picture": "https://example.com/a.png",
            "nonce": "n0nce",
            "iat": now,
            "exp": now + 600,
        });
        for (k, v) in overrides.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[tokio::test]
    async fn accepts_a_valid_token() {
        let id = test_verifier()
            .verify(&sign_google_token(&claims(json!({})), TEST_KID), "n0nce")
            .await
            .unwrap();
        assert_eq!(id.sub, "1234567890");
        assert_eq!(id.email, "jane@example.com");
        // Both issuer spellings are Google's.
        let other_iss = sign_google_token(&claims(json!({"iss": "accounts.google.com"})), TEST_KID);
        assert!(test_verifier().verify(&other_iss, "n0nce").await.is_ok());
    }

    #[tokio::test]
    async fn rejects_bad_tokens() {
        let v = test_verifier();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let cases = [
            (json!({"aud": "someone-else"}), "wrong audience"),
            (json!({"iss": "https://evil.example"}), "wrong issuer"),
            (json!({"exp": now - 120}), "expired"),
            (json!({"email_verified": false}), "unverified email"),
            (
                json!({"email_verified": "false"}),
                "unverified email as text",
            ),
            (json!({"nonce": "other"}), "nonce from another page"),
        ];
        for (overrides, why) in cases {
            let token = sign_google_token(&claims(overrides), TEST_KID);
            assert!(
                v.verify(&token, "n0nce").await.is_err(),
                "{why} should be rejected"
            );
        }
        assert!(
            v.verify(
                &sign_google_token(&claims(json!({})), "unknown-kid"),
                "n0nce"
            )
            .await
            .is_err()
        );
        assert!(
            v.verify(&sign_google_token(&claims(json!({})), TEST_KID), "")
                .await
                .is_err()
        );
        assert!(v.verify("not.a.jwt", "n0nce").await.is_err());
        // Tampering with the payload breaks the signature.
        let token = sign_google_token(&claims(json!({})), TEST_KID);
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged_payload = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            serde_json::to_vec(&claims(json!({"sub": "attacker"}))).unwrap(),
        );
        parts[1] = &forged_payload;
        assert!(v.verify(&parts.join("."), "n0nce").await.is_err());
    }

    #[test]
    fn reads_max_age() {
        assert_eq!(
            max_age("public, max-age=19856, must-revalidate"),
            Some(Duration::from_secs(19856))
        );
        assert_eq!(max_age("no-cache"), None);
        assert_eq!(max_age("max-age=999999"), Some(Duration::from_secs(86400)));
    }

    #[test]
    fn unconfigured_without_a_client_id() {
        assert!(GoogleVerifier::new(Some("  ".into())).client_id().is_none());
    }
}
