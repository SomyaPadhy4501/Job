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

/// A minimal but real one-page PDF whose text lines are `lines`, laid out
/// the way pdfTeX writes them: one text object, Type 1 font, each line
/// placed with `Td` and no space characters between lines.
pub fn pdf_resume(lines: &[&str]) -> Vec<u8> {
    let escape = |s: &str| {
        s.replace('\\', "\\\\")
            .replace('(', "\\(")
            .replace(')', "\\)")
    };
    let mut content = String::from("BT /F1 11 Tf 72 720 Td 14 TL\n");
    for line in lines {
        content.push_str(&format!("({}) Tj T*\n", escape(line)));
    }
    content.push_str("ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_owned(),
    ];
    let mut pdf = b"%PDF-1.5\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
    }
    let xref = pdf.len();
    pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for off in offsets {
        pdf.extend(format!("{off:010} 00000 n \n").bytes());
    }
    pdf.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .bytes(),
    );
    pdf
}

pub fn sign_google_token(claims: &serde_json::Value, kid: &str) -> String {
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(kid.to_owned());
    let key = EncodingKey::from_rsa_pem(PRIVATE_PEM).expect("test private key");
    encode(&header, claims, &key).expect("signing a test token")
}

/// A base64 data key for tests (`DATA_KEYS=1:<this>`).
pub const TEST_DATA_KEY: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
