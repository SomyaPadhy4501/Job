//! Text out of a PDF or .docx. Runs in a blocking thread with a time limit
//! (the caller's job); everything here is bounded by the file's size, a page
//! limit and a text limit. The PDF reader can panic on hostile files, so it
//! runs inside `catch_unwind`.

use std::io::{Cursor, Read};

use crate::upload::FileKind;

pub const MAX_PAGES: usize = 8;
pub const MAX_TEXT_BYTES: usize = 100 * 1024;
const MAX_DOCUMENT_XML: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExtractError {
    #[error("no text found; it may be a scanned image")]
    NoText,
    #[error("more than {MAX_PAGES} pages")]
    TooManyPages,
    #[error("the PDF is password-protected")]
    Encrypted,
    #[error("couldn't read the file: {0}")]
    Failed(String),
}

impl ExtractError {
    /// The `parse_status` stored for this failure.
    pub fn status(&self) -> &'static str {
        match self {
            ExtractError::NoText => "no_text",
            _ => "failed",
        }
    }
}

pub fn extract_text(kind: FileKind, bytes: &[u8]) -> Result<String, ExtractError> {
    let raw = match kind {
        FileKind::Pdf => pdf_text(bytes)?,
        FileKind::Docx => docx_text(bytes)?,
    };
    let text = tidy(&raw);
    if text.chars().filter(|c| c.is_alphanumeric()).count() < 40 {
        return Err(ExtractError::NoText);
    }
    Ok(crate::truncate_chars(&text, MAX_TEXT_BYTES).to_owned())
}

fn pdf_text(bytes: &[u8]) -> Result<String, ExtractError> {
    let outcome = std::panic::catch_unwind(|| -> Result<String, ExtractError> {
        let mut doc = pdf_extract::Document::load_mem(bytes)
            .map_err(|e| ExtractError::Failed(e.to_string()))?;
        if doc.is_encrypted() {
            // An owner-password PDF (printing restricted) opens with an empty
            // password; a user password can't be guessed.
            doc.decrypt("").map_err(|_| ExtractError::Encrypted)?;
        }
        if doc.get_pages().len() > MAX_PAGES {
            return Err(ExtractError::TooManyPages);
        }
        let mut text = String::new();
        {
            let mut output = pdf_extract::PlainTextOutput::new(&mut text);
            pdf_extract::output_doc(&doc, &mut output)
                .map_err(|e| ExtractError::Failed(e.to_string()))?;
        }
        Ok(text)
    });
    outcome.unwrap_or_else(|_| {
        Err(ExtractError::Failed(
            "the PDF reader crashed on this file".into(),
        ))
    })
}

fn docx_text(bytes: &[u8]) -> Result<String, ExtractError> {
    let failed = |e: zip::result::ZipError| ExtractError::Failed(e.to_string());
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(failed)?;
    let file = zip.by_name("word/document.xml").map_err(failed)?;
    if file.size() > MAX_DOCUMENT_XML {
        return Err(ExtractError::Failed("the document is too large".into()));
    }
    let mut xml = String::new();
    file.take(MAX_DOCUMENT_XML)
        .read_to_string(&mut xml)
        .map_err(|e| ExtractError::Failed(e.to_string()))?;
    Ok(docx_xml_text(&xml))
}

/// Text of WordprocessingML: the runs (`<w:t>`) in order, a line break per
/// paragraph (`</w:p>`) and per `<w:br/>`, a tab per `<w:tab/>` (but not the
/// tab-stop definitions inside `<w:tabs>`).
pub fn docx_xml_text(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len() / 4);
    let mut rest = xml;
    let (mut in_text, mut in_tabs) = (false, false);
    while let Some(lt) = rest.find('<') {
        if in_text {
            out.push_str(&unescape(&rest[..lt]));
        }
        let Some(len) = rest[lt..].find('>') else {
            break;
        };
        let tag = &rest[lt + 1..lt + len];
        rest = &rest[lt + len + 1..];
        let (closing, body) = match tag.strip_prefix('/') {
            Some(body) => (true, body),
            None => (false, tag),
        };
        let self_closing = body.ends_with('/');
        let name = body
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        match name {
            "w:t" => in_text = !closing && !self_closing,
            "w:tabs" => in_tabs = !closing && !self_closing,
            "w:p" if closing => out.push('\n'),
            "w:br" | "w:cr" if !closing => out.push('\n'),
            "w:tab" if !closing && !in_tabs => out.push('\t'),
            "w:noBreakHyphen" => out.push('-'),
            _ => {}
        }
    }
    out
}

fn unescape(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains('&') {
        return s.into();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp..];
        let Some(semi) = after.find(';').filter(|&i| i <= 10) else {
            out.push('&');
            rest = &after[1..];
            continue;
        };
        let entity = &after[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    out.into()
}

/// Normalizes what PDF readers produce: no-break and zero-width spaces,
/// ligatures, runs of blank lines, trailing spaces.
pub fn tidy(text: &str) -> String {
    let replaced = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace(['\u{a0}', '\u{2007}', '\u{202f}'], " ")
        .replace(['\u{200b}', '\u{feff}', '\u{ad}'], "")
        .replace('\u{fb00}', "ff")
        .replace('\u{fb01}', "fi")
        .replace('\u{fb02}', "fl")
        .replace('\u{fb03}', "ffi")
        .replace('\u{fb04}', "ffl");
    let mut out = String::with_capacity(replaced.len());
    let mut blank = 0;
    for line in replaced.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 || out.is_empty() {
                continue;
            }
            out.push('\n');
            continue;
        }
        blank = 0;
        out.push_str(line.trim_start());
        out.push('\n');
    }
    out.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upload::tests::minimal_docx;

    const PARAGRAPHS: &str = r#"<w:document><w:body>
        <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr>
          <w:r><w:t>Jane</w:t></w:r><w:r><w:t xml:space="preserve"> Doe</w:t></w:r></w:p>
        <w:p><w:r><w:t>Software Engineer</w:t><w:tab/><w:t>Jun 2024 &#8211; Present</w:t></w:r></w:p>
        <w:p><w:r><w:t>R&amp;D at A&lt;B&gt; Labs</w:t><w:br/><w:t>second line</w:t></w:r></w:p>
        </w:body></w:document>"#;

    #[test]
    fn reads_docx_paragraphs_runs_and_tabs() {
        let text = docx_xml_text(PARAGRAPHS);
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        assert_eq!(
            lines,
            [
                "Jane Doe",
                "Software Engineer\tJun 2024 – Present",
                "R&D at A<B> Labs",
                "second line"
            ]
        );
    }

    #[test]
    fn extracts_from_a_real_docx_container() {
        let body = format!(
            "<w:document><w:body><w:p><w:r><w:t>{}</w:t></w:r></w:p></w:body></w:document>",
            "Jane Doe experienced engineer ".repeat(5)
        );
        let text = extract_text(FileKind::Docx, &minimal_docx(&body)).unwrap();
        assert!(text.starts_with("Jane Doe"));
    }

    #[test]
    fn too_little_text_is_reported_as_no_text() {
        let body = "<w:document><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>";
        assert_eq!(
            extract_text(FileKind::Docx, &minimal_docx(body)),
            Err(ExtractError::NoText)
        );
    }

    #[test]
    fn broken_pdfs_fail_cleanly() {
        assert!(matches!(
            extract_text(FileKind::Pdf, b"%PDF-1.4\nnot really\n%%EOF"),
            Err(ExtractError::Failed(_))
        ));
    }

    #[test]
    fn unescapes_entities() {
        assert_eq!(
            unescape("a &amp; b &#x2013; c &#8212; &bogus; &"),
            "a & b – c — &bogus; &"
        );
    }

    #[test]
    fn tidies_pdf_text() {
        assert_eq!(
            tidy("  Jane\u{a0}Doe  \r\n\r\n\r\n\u{fb01}rst\u{200b}\n"),
            "Jane Doe\n\nfirst"
        );
    }
}
