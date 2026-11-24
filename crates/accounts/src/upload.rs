//! Checking an uploaded resume before anything is stored: the type is decided
//! by the bytes, never by the file name or the browser's Content-Type.

use std::io::Cursor;

use serde::{Deserialize, Serialize};

use crate::{clean_line, truncate_chars};

pub const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
pub const DOCX_MIME: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// Limits on a .docx's zip structure, checked before anything is unzipped.
const MAX_ZIP_ENTRIES: usize = 1000;
const MAX_ENTRY_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RATIO: u64 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Pdf,
    Docx,
}

impl FileKind {
    pub const fn mime(self) -> &'static str {
        match self {
            FileKind::Pdf => "application/pdf",
            FileKind::Docx => DOCX_MIME,
        }
    }

    pub const fn extension(self) -> &'static str {
        match self {
            FileKind::Pdf => "pdf",
            FileKind::Docx => "docx",
        }
    }

    pub fn from_mime(mime: &str) -> Option<Self> {
        match mime {
            "application/pdf" => Some(FileKind::Pdf),
            DOCX_MIME => Some(FileKind::Docx),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UploadError {
    #[error("the file is empty")]
    Empty,
    #[error("files can be at most 4 MB")]
    TooLarge,
    #[error(
        "this is an old .doc file or a password-protected Word file; save it as a PDF or a plain .docx"
    )]
    LegacyDoc,
    #[error("upload a PDF or a Word (.docx) file")]
    Unsupported,
    #[error("this PDF looks incomplete or damaged")]
    BrokenPdf,
    #[error("this .docx is damaged or isn't a Word document")]
    BrokenDocx,
    #[error("Word files with macros aren't accepted; save it as a plain .docx")]
    Macros,
    #[error("this file is password-protected")]
    Encrypted,
}

/// Decides what the bytes are, and rejects anything that isn't a sane PDF or
/// .docx. A .docx's zip directory is checked (entry count, sizes, compression
/// ratio, macros) without decompressing anything.
pub fn check_file(bytes: &[u8]) -> Result<FileKind, UploadError> {
    if bytes.is_empty() {
        return Err(UploadError::Empty);
    }
    if bytes.len() > MAX_FILE_BYTES {
        return Err(UploadError::TooLarge);
    }
    if bytes.starts_with(b"%PDF-") {
        let tail = &bytes[bytes.len().saturating_sub(2048)..];
        return if tail.windows(5).any(|w| w == b"%%EOF") {
            Ok(FileKind::Pdf)
        } else {
            Err(UploadError::BrokenPdf)
        };
    }
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        return Err(UploadError::LegacyDoc);
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return check_docx(bytes);
    }
    Err(UploadError::Unsupported)
}

fn check_docx(bytes: &[u8]) -> Result<FileKind, UploadError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| UploadError::BrokenDocx)?;
    if zip.is_empty() || zip.len() > MAX_ZIP_ENTRIES {
        return Err(UploadError::BrokenDocx);
    }
    let (mut has_types, mut has_document, mut total) = (false, false, 0u64);
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|_| UploadError::BrokenDocx)?;
        if entry.encrypted() {
            return Err(UploadError::Encrypted);
        }
        let size = entry.size();
        total = total.saturating_add(size);
        if size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES {
            return Err(UploadError::BrokenDocx);
        }
        if size / entry.compressed_size().max(1) > MAX_RATIO {
            return Err(UploadError::BrokenDocx);
        }
        let name = entry.name().map_err(|_| UploadError::BrokenDocx)?;
        match name.as_ref() {
            "[Content_Types].xml" => has_types = true,
            "word/document.xml" => has_document = true,
            n if n.to_ascii_lowercase().ends_with("vbaproject.bin") => {
                return Err(UploadError::Macros);
            }
            _ => {}
        }
    }
    if has_types && has_document {
        Ok(FileKind::Docx)
    } else {
        Err(UploadError::BrokenDocx)
    }
}

/// A file name safe to store and to send back in Content-Disposition: no
/// path, no control or reserved characters, at most 100 characters before the
/// extension, and the extension the bytes actually are.
pub fn sanitize_file_name(name: &str, kind: FileKind) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let kept: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | ':' | '*' | '?' | '<' | '>' | '|' | ';'))
        .collect();
    let kept = clean_line(&kept);
    let stem = match kept.rsplit_once('.') {
        Some((stem, _ext)) if !stem.is_empty() => stem,
        _ => kept.as_str(),
    };
    let stem = truncate_chars(
        stem.trim_matches(|c: char| c == '.' || c.is_whitespace()),
        100,
    )
    .trim_end();
    let stem = if stem.is_empty() { "resume" } else { stem };
    format!("{stem}.{}", kind.extension())
}

/// A starting title from the file name: "jane_doe-SWE.pdf" → "jane doe SWE".
pub fn default_title(file_name: &str) -> String {
    let stem = file_name.rsplit_once('.').map_or(file_name, |(s, _)| s);
    let spaced: String = stem
        .chars()
        .map(|c| if c == '_' || c == '-' { ' ' } else { c })
        .collect();
    let title = clean_line(&spaced);
    let title = truncate_chars(&title, crate::tags::MAX_TITLE_CHARS).trim_end();
    if title.is_empty() {
        "Resume".to_owned()
    } else {
        title.to_owned()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    pub(crate) fn docx_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (name, body) in entries {
                zip.start_file(*name, options).unwrap();
                zip.write_all(body).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    pub(crate) fn minimal_docx(document_xml: &str) -> Vec<u8> {
        docx_with(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", document_xml.as_bytes()),
        ])
    }

    #[test]
    fn recognises_pdf_and_docx_by_content() {
        assert_eq!(check_file(b"%PDF-1.7\n...\n%%EOF\n"), Ok(FileKind::Pdf));
        assert_eq!(
            check_file(&minimal_docx("<w:document/>")),
            Ok(FileKind::Docx)
        );
    }

    #[test]
    fn rejects_everything_else() {
        assert_eq!(check_file(b""), Err(UploadError::Empty));
        assert_eq!(
            check_file(b"%PDF-1.7 truncated"),
            Err(UploadError::BrokenPdf)
        );
        assert_eq!(
            check_file(b"<html>not a resume</html>"),
            Err(UploadError::Unsupported)
        );
        assert_eq!(
            check_file(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0]),
            Err(UploadError::LegacyDoc)
        );
        assert_eq!(
            check_file(&vec![b'%'; MAX_FILE_BYTES + 1]),
            Err(UploadError::TooLarge)
        );
        // A zip that isn't a Word document.
        assert_eq!(
            check_file(&docx_with(&[("hello.txt", b"hi")])),
            Err(UploadError::BrokenDocx)
        );
        assert_eq!(
            check_file(b"PK\x03\x04garbage"),
            Err(UploadError::BrokenDocx)
        );
    }

    #[test]
    fn rejects_macros_and_zip_bombs() {
        let with_macros = docx_with(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", b"<w:document/>"),
            ("word/vbaProject.bin", b"macro"),
        ]);
        assert_eq!(check_file(&with_macros), Err(UploadError::Macros));
        let zeros = vec![0u8; 8 * 1024 * 1024];
        let bomb = docx_with(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", &zeros),
        ]);
        assert_eq!(check_file(&bomb), Err(UploadError::BrokenDocx));
    }

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(
            sanitize_file_name("C:\\fakepath\\Jane Doe – Resume.pdf", FileKind::Pdf),
            "Jane Doe – Resume.pdf"
        );
        assert_eq!(
            sanitize_file_name("../../etc/passwd", FileKind::Pdf),
            "passwd.pdf"
        );
        assert_eq!(
            sanitize_file_name("résumé \"final\".PDF", FileKind::Pdf),
            "résumé final.pdf"
        );
        assert_eq!(
            sanitize_file_name("renamed.pdf", FileKind::Docx),
            "renamed.docx"
        );
        assert_eq!(sanitize_file_name("", FileKind::Pdf), "resume.pdf");
        assert_eq!(sanitize_file_name(".pdf", FileKind::Pdf), "pdf.pdf");
        assert!(sanitize_file_name(&"a".repeat(300), FileKind::Pdf).len() <= 104);
    }

    #[test]
    fn default_titles_come_from_the_file_name() {
        assert_eq!(default_title("jane_doe-SWE.pdf"), "jane doe SWE");
        assert_eq!(default_title(".pdf"), "Resume");
    }
}
