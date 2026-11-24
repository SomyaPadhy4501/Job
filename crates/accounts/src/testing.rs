//! Test helpers: a throwaway RSA key (src/testing/*.pem) that signs fake
//! Google ID tokens, and a verifier that trusts only that key. Compiled for
//! tests and for other crates with the `test-util` feature, never into the
//! deployed function.

use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, encode};

use crate::google::GoogleVerifier;

pub const TEST_CLIENT_ID: &str = "test-client.apps.googleusercontent.com";
pub const TEST_KID: &str = "test-key-1";
const PRIVATE_PEM: &[u8] = include_bytes!("testing/private.pem");
const PUBLIC_PEM: &[u8] = include_bytes!("testing/public.pem");

pub fn test_verifier() -> GoogleVerifier {
    let key = DecodingKey::from_rsa_pem(PUBLIC_PEM).expect("test public key");
    GoogleVerifier::with_keys(TEST_CLIENT_ID, vec![(TEST_KID.to_owned(), key)])
}

/// A minimal but real .docx whose paragraphs are `lines`.
pub fn docx_resume(lines: &[&str]) -> Vec<u8> {
    use std::io::{Cursor, Write};
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let body: String = lines
        .iter()
        .map(|l| format!("<w:p><w:r><w:t>{}</w:t></w:r></w:p>", escape(l)))
        .collect();
    let document = format!("<w:document><w:body>{body}</w:body></w:document>");
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in [
            ("[Content_Types].xml", "<Types/>".as_bytes()),
            ("word/document.xml", document.as_bytes()),
        ] {
            zip.start_file(name, options).expect("zip entry");
            zip.write_all(data).expect("zip write");
        }
        zip.finish().expect("zip finish");
    }
    buf.into_inner()
}

pub fn sign_google_token(claims: &serde_json::Value, kid: &str) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.to_owned());
    let key = EncodingKey::from_rsa_pem(PRIVATE_PEM).expect("test private key");
    encode(&header, claims, &key).expect("signing a test token")
}

/// A base64 data key for tests (`DATA_KEYS=1:<this>`).
pub const TEST_DATA_KEY: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
