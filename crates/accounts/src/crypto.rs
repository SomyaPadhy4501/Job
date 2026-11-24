//! Encryption for everything a user writes about themselves: the profile,
//! saved answers, and what the parser read from their resumes.
//!
//! Stored value (BYTEA): `key version (1 byte) | IV (12) | ciphertext | GCM tag (16)`.
//!
//! The plaintext starts with one codec byte: 0 = raw, 1 = DEFLATE. JSON is
//! compressed before it is encrypted, because ciphertext doesn't compress;
//! that matters on Neon's 1 GB free plan.
//!
//! The associated data binds a value to where it lives,
//! `jobboard|{table}.{column}|{owner id}|k{version}`, so a value copied into
//! another column or into another user's row fails to decrypt instead of being
//! read as theirs.
//!
//! Keys come from `DATA_KEYS="1:<base64 of 32 bytes>,2:<…>"`.
//! `DATA_KEY_CURRENT` names the key new writes use (default: the highest
//! version). Older keys stay readable, and a value is re-encrypted with the
//! current key the next time it is written.

use std::collections::BTreeMap;
use std::fmt;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;
use serde::de::DeserializeOwned;
use uuid::Uuid;

const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
const CODEC_RAW: u8 = 0;
const CODEC_DEFLATE: u8 = 1;
/// Values shorter than this aren't worth compressing.
const COMPRESS_MIN: usize = 128;
/// Upper bound on a decrypted, decompressed value. The largest real value (a
/// parsed resume) is around 10 KB; this stops a corrupt value from inflating
/// without limit.
const MAX_PLAINTEXT: usize = 2 * 1024 * 1024;

/// Where an encrypted value is stored. Part of the associated data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    ProfileData,
    ResumeParsed,
    AnswerEntry,
}

impl Field {
    fn location(self) -> &'static str {
        match self {
            Field::ProfileData => "profiles.data",
            Field::ResumeParsed => "resumes.parsed",
            Field::AnswerEntry => "answers.entry",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    #[error("DATA_KEYS is not set")]
    Missing,
    #[error("DATA_KEYS is malformed: {0}")]
    Malformed(String),
    #[error("value was encrypted with key version {0}, which DATA_KEYS doesn't have")]
    UnknownKey(u8),
    #[error("value doesn't decrypt (a different key, or it belongs to another row)")]
    Decrypt,
    #[error("value is corrupt")]
    Corrupt,
}

struct Key {
    cipher: Aes256Gcm,
    raw: [u8; 32],
}

pub struct Keyring {
    keys: BTreeMap<u8, Key>,
    current: u8,
}

/// Never prints key material.
impl fmt::Debug for Keyring {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Keyring")
            .field("versions", &self.keys.keys().collect::<Vec<_>>())
            .field("current", &self.current)
            .finish()
    }
}

impl Keyring {
    pub fn from_env() -> Result<Self, CryptoError> {
        let spec = std::env::var("DATA_KEYS").map_err(|_| CryptoError::Missing)?;
        let current = std::env::var("DATA_KEY_CURRENT").ok();
        Self::parse(&spec, current.as_deref())
    }

    /// `spec` is `"1:<base64>,2:<base64>"`; a `v` before the number is allowed.
    pub fn parse(spec: &str, current: Option<&str>) -> Result<Self, CryptoError> {
        let mut keys = BTreeMap::new();
        for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let (version, b64) = part
                .split_once(':')
                .ok_or_else(|| malformed("each key is written version:base64"))?;
            let version = parse_version(version)?;
            let raw = STANDARD
                .decode(b64.trim())
                .map_err(|_| malformed(format!("key {version} isn't valid base64")))?;
            let raw: [u8; 32] = raw.try_into().map_err(|v: Vec<u8>| {
                malformed(format!("key {version} is {} bytes; it must be 32", v.len()))
            })?;
            let cipher = Aes256Gcm::new_from_slice(&raw).expect("a 32-byte key");
            if keys.insert(version, Key { cipher, raw }).is_some() {
                return Err(malformed(format!("key {version} is listed twice")));
            }
        }
        let Some(&highest) = keys.keys().next_back() else {
            return Err(CryptoError::Missing);
        };
        let current = match current.map(str::trim).filter(|c| !c.is_empty()) {
            Some(c) => parse_version(c)?,
            None => highest,
        };
        if !keys.contains_key(&current) {
            return Err(malformed(format!(
                "DATA_KEY_CURRENT={current} isn't one of the keys"
            )));
        }
        Ok(Self { keys, current })
    }

    pub fn current_version(&self) -> u8 {
        self.current
    }

    pub fn encrypt(&self, field: Field, owner: &Uuid, plaintext: &[u8]) -> Vec<u8> {
        let key = &self.keys[&self.current];
        let compressed = (plaintext.len() >= COMPRESS_MIN)
            .then(|| miniz_oxide::deflate::compress_to_vec(plaintext, 6))
            .filter(|c| c.len() < plaintext.len());
        let mut body = Vec::with_capacity(plaintext.len() + 1);
        match compressed {
            Some(c) => {
                body.push(CODEC_DEFLATE);
                body.extend_from_slice(&c);
            }
            None => {
                body.push(CODEC_RAW);
                body.extend_from_slice(plaintext);
            }
        }
        let iv: [u8; IV_LEN] = crate::token::random_bytes();
        let aad = associated_data(field, owner, self.current);
        let sealed = key
            .cipher
            .encrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &body,
                    aad: aad.as_bytes(),
                },
            )
            .expect("AES-GCM encryption of an in-memory buffer doesn't fail");
        let mut out = Vec::with_capacity(1 + IV_LEN + sealed.len());
        out.push(self.current);
        out.extend_from_slice(&iv);
        out.extend_from_slice(&sealed);
        out
    }

    pub fn decrypt(
        &self,
        field: Field,
        owner: &Uuid,
        stored: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        if stored.len() < 1 + IV_LEN + TAG_LEN + 1 {
            return Err(CryptoError::Corrupt);
        }
        let version = stored[0];
        let key = self
            .keys
            .get(&version)
            .ok_or(CryptoError::UnknownKey(version))?;
        let (iv, sealed) = stored[1..].split_at(IV_LEN);
        let aad = associated_data(field, owner, version);
        let body = key
            .cipher
            .decrypt(
                Nonce::from_slice(iv),
                Payload {
                    msg: sealed,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::Decrypt)?;
        let (codec, payload) = body.split_first().ok_or(CryptoError::Corrupt)?;
        match *codec {
            CODEC_RAW => Ok(payload.to_vec()),
            CODEC_DEFLATE => {
                miniz_oxide::inflate::decompress_to_vec_with_limit(payload, MAX_PLAINTEXT)
                    .map_err(|_| CryptoError::Corrupt)
            }
            _ => Err(CryptoError::Corrupt),
        }
    }

    pub fn encrypt_json<T: Serialize>(&self, field: Field, owner: &Uuid, value: &T) -> Vec<u8> {
        let json = serde_json::to_vec(value).expect("serializing to JSON in memory doesn't fail");
        self.encrypt(field, owner, &json)
    }

    pub fn decrypt_json<T: DeserializeOwned>(
        &self,
        field: Field,
        owner: &Uuid,
        stored: &[u8],
    ) -> Result<T, CryptoError> {
        let json = self.decrypt(field, owner, stored)?;
        serde_json::from_slice(&json).map_err(|_| CryptoError::Corrupt)
    }

    /// Whether a stored value was written with an older key.
    pub fn is_stale(&self, stored: &[u8]) -> bool {
        stored.first() != Some(&self.current)
    }

    /// A secret for keyed hashing, such as turning client IPs into rate-limit
    /// subjects. Derived from the current key, so rotating the key restarts
    /// those counters, which is harmless.
    pub fn derive(&self, purpose: &str) -> [u8; 32] {
        let label = format!("jobboard derive|{purpose}");
        crate::token::hmac_sha256(&self.keys[&self.current].raw, label.as_bytes())
    }
}

fn associated_data(field: Field, owner: &Uuid, version: u8) -> String {
    format!("jobboard|{}|{}|k{}", field.location(), owner, version)
}

fn parse_version(s: &str) -> Result<u8, CryptoError> {
    let digits = s.trim().trim_start_matches(['v', 'V']);
    match digits.parse::<u8>() {
        Ok(0) | Err(_) => Err(malformed(format!(
            "key version {s:?} must be a number from 1 to 255"
        ))),
        Ok(v) => Ok(v),
    }
}

fn malformed(msg: impl Into<String>) -> CryptoError {
    CryptoError::Malformed(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const K1: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="; // bytes 1..=32
    const K2: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8="; // bytes 32..=63

    fn ring(spec: &str) -> Keyring {
        Keyring::parse(spec, None).unwrap()
    }

    #[test]
    fn round_trips_short_and_long_values() {
        let r = ring(&format!("1:{K1}"));
        let owner = Uuid::new_v4();
        for plain in [b"hi".to_vec(), "x".repeat(5000).into_bytes()] {
            let sealed = r.encrypt(Field::ProfileData, &owner, &plain);
            assert_eq!(
                r.decrypt(Field::ProfileData, &owner, &sealed).unwrap(),
                plain
            );
        }
    }

    #[test]
    fn compresses_before_encrypting() {
        let r = ring(&format!("1:{K1}"));
        let plain = "{\"skills\":[\"rust\",\"rust\",\"rust\"]}".repeat(100);
        let sealed = r.encrypt(Field::ProfileData, &Uuid::new_v4(), plain.as_bytes());
        assert!(
            sealed.len() < plain.len() / 4,
            "{} bytes for {}",
            sealed.len(),
            plain.len()
        );
    }

    #[test]
    fn same_value_encrypts_differently_each_time() {
        let r = ring(&format!("1:{K1}"));
        let owner = Uuid::new_v4();
        assert_ne!(
            r.encrypt(Field::AnswerEntry, &owner, b"same"),
            r.encrypt(Field::AnswerEntry, &owner, b"same")
        );
    }

    #[test]
    fn a_value_moved_to_another_row_or_column_fails() {
        let r = ring(&format!("1:{K1}"));
        let (alice, bob) = (Uuid::new_v4(), Uuid::new_v4());
        let sealed = r.encrypt(Field::ProfileData, &alice, b"alice's profile");
        assert_eq!(
            r.decrypt(Field::ProfileData, &bob, &sealed),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            r.decrypt(Field::AnswerEntry, &alice, &sealed),
            Err(CryptoError::Decrypt)
        );
    }

    #[test]
    fn tampering_is_detected() {
        let r = ring(&format!("1:{K1}"));
        let owner = Uuid::new_v4();
        let mut sealed = r.encrypt(Field::ProfileData, &owner, b"value");
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert_eq!(
            r.decrypt(Field::ProfileData, &owner, &sealed),
            Err(CryptoError::Decrypt)
        );
        assert_eq!(
            r.decrypt(Field::ProfileData, &owner, &sealed[..10]),
            Err(CryptoError::Corrupt)
        );
    }

    #[test]
    fn rotation_keeps_old_values_readable() {
        let owner = Uuid::new_v4();
        let old = ring(&format!("1:{K1}"));
        let sealed = old.encrypt(Field::ProfileData, &owner, b"written with key 1");
        let rotated = ring(&format!("1:{K1}, v2:{K2}"));
        assert_eq!(rotated.current_version(), 2);
        assert!(rotated.is_stale(&sealed));
        assert_eq!(
            rotated
                .decrypt(Field::ProfileData, &owner, &sealed)
                .unwrap(),
            b"written with key 1"
        );
        let resealed = rotated.encrypt(Field::ProfileData, &owner, b"x");
        assert_eq!(resealed[0], 2);
        assert!(!rotated.is_stale(&resealed));
        // Dropping key 1 makes old values unreadable, with a clear error.
        let only2 = ring(&format!("2:{K2}"));
        assert_eq!(
            only2.decrypt(Field::ProfileData, &owner, &sealed),
            Err(CryptoError::UnknownKey(1))
        );
    }

    #[test]
    fn current_key_can_be_pinned() {
        let r = Keyring::parse(&format!("1:{K1},2:{K2}"), Some("1")).unwrap();
        assert_eq!(r.current_version(), 1);
        assert!(Keyring::parse(&format!("1:{K1}"), Some("3")).is_err());
    }

    #[test]
    fn rejects_bad_key_specs() {
        for spec in [
            "",
            "nonsense",
            "1:not-base64!!",
            "1:AAAA",
            "0:AAAA",
            &format!("1:{K1},1:{K2}"),
        ] {
            assert!(
                Keyring::parse(spec, None).is_err(),
                "{spec:?} should be rejected"
            );
        }
    }

    #[test]
    fn debug_output_has_no_key_material() {
        let shown = format!("{:?}", ring(&format!("1:{K1}")));
        assert!(!shown.contains(K1));
        assert!(shown.contains("versions"));
    }

    #[test]
    fn json_round_trip_and_derived_secrets() {
        let r = ring(&format!("1:{K1}"));
        let owner = Uuid::new_v4();
        let sealed = r.encrypt_json(Field::ResumeParsed, &owner, &vec!["a", "b"]);
        let back: Vec<String> = r
            .decrypt_json(Field::ResumeParsed, &owner, &sealed)
            .unwrap();
        assert_eq!(back, ["a", "b"]);
        assert_eq!(r.derive("ip"), r.derive("ip"));
        assert_ne!(r.derive("ip"), r.derive("other"));
    }
}
