//! Random tokens and the hashes they are stored as.
//!
//! The database only ever holds SHA-256 hashes of session cookies and
//! extension tokens, so a copy of it can't be used to sign in. The tokens are
//! 256 random bits, so a fast unsalted hash is the right tool; a password hash
//! would add nothing.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Extension tokens start with this, so they are recognisable in a paste or a
/// secret scanner.
pub const API_TOKEN_PREFIX: &str = "jbt_";
/// Characters of a token shown in the settings page to tell tokens apart.
const SHOWN_CHARS: usize = 6;
/// base64url length of 32 bytes without padding.
const TOKEN_B64_LEN: usize = 43;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("the OS random number generator is available");
    buf
}

/// A session cookie value: 32 random bytes as base64url.
pub fn new_session_token() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

/// A one-off random value, such as the nonce bound to a Google sign-in.
pub fn new_nonce() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes::<24>())
}

pub struct NewApiToken {
    /// Shown to the user once, never stored.
    pub token: String,
    /// The non-secret start of the token, stored for display.
    pub prefix: String,
    pub hash: [u8; 32],
}

pub fn new_api_token() -> NewApiToken {
    let token = format!(
        "{API_TOKEN_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(random_bytes::<32>())
    );
    let prefix = token[..API_TOKEN_PREFIX.len() + SHOWN_CHARS].to_owned();
    let hash = sha256(token.as_bytes());
    NewApiToken {
        token,
        prefix,
        hash,
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// SHA-256 over several parts, each length-prefixed so that ("ab", "c") and
/// ("a", "bc") hash differently.
pub fn sha256_parts(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    hasher.finalize().into()
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes keys of any length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// Constant-time equality, for comparing secrets.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

fn is_b64url(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Cheap shape check before hashing a cookie and asking the database.
pub fn looks_like_session_token(s: &str) -> bool {
    s.len() == TOKEN_B64_LEN && is_b64url(s)
}

/// Cheap shape check before hashing a bearer token and asking the database.
pub fn looks_like_api_token(s: &str) -> bool {
    s.strip_prefix(API_TOKEN_PREFIX)
        .is_some_and(|rest| rest.len() == TOKEN_B64_LEN && is_b64url(rest))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_tokens_are_random_and_well_formed() {
        let a = new_session_token();
        let b = new_session_token();
        assert_ne!(a, b);
        assert!(looks_like_session_token(&a));
        assert!(!looks_like_session_token("short"));
        assert!(!looks_like_session_token(&format!("{}!", &a[..42])));
    }

    #[test]
    fn api_tokens_have_a_prefix_and_a_matching_hash() {
        let t = new_api_token();
        assert!(t.token.starts_with("jbt_"));
        assert!(looks_like_api_token(&t.token));
        assert_eq!(t.prefix, &t.token[..10]);
        assert_eq!(t.hash, sha256(t.token.as_bytes()));
        assert!(!looks_like_api_token(&t.token[4..]));
    }

    #[test]
    fn length_prefixed_hashes_keep_parts_apart() {
        assert_ne!(sha256_parts(&[b"ab", b"c"]), sha256_parts(&[b"a", b"bc"]));
    }

    #[test]
    fn ct_eq_compares_whole_values() {
        assert!(ct_eq(b"same", b"same"));
        assert!(!ct_eq(b"same", b"sane"));
        assert!(!ct_eq(b"same", b"same!"));
    }

    #[test]
    fn hex_encodes() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
