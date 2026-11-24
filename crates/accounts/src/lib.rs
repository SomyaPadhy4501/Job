//! Accounts logic with no HTTP or SQL in it, so each piece is unit-tested on
//! its own: field encryption, tokens, Google sign-in, the autofill profile
//! schema, saved answers, resume tags, upload checks, resume parsing, resume
//! ranking and resume file storage.

pub mod answers;
pub mod crypto;
pub mod google;
pub mod parser;
pub mod profile;
pub mod rank;
pub mod storage;
pub mod tags;
pub mod token;
pub mod upload;

#[cfg(any(test, feature = "test-util"))]
pub mod testing;

/// Collapses runs of whitespace to one space, drops control characters, and
/// trims. Used for every short text field a user can type.
pub fn clean_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for word in s.split(|c: char| c.is_whitespace() || c.is_control()) {
        if word.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// Like [`clean_line`], but keeps line breaks (at most one blank line in a
/// row). For long text such as job descriptions and answers.
pub fn clean_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_run = 0;
    for line in s.lines() {
        let line = clean_line(line);
        if line.is_empty() {
            blank_run += 1;
            if blank_run > 1 || out.is_empty() {
                continue;
            }
        } else {
            blank_run = 0;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&line);
    }
    out.trim_end().to_owned()
}

/// Cuts a string to at most `max` characters, on a character boundary.
pub fn truncate_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_line_collapses_whitespace_and_controls() {
        assert_eq!(clean_line("  Jane \t\u{0} Doe \n"), "Jane Doe");
        assert_eq!(clean_line(""), "");
    }

    #[test]
    fn clean_text_keeps_paragraphs() {
        assert_eq!(clean_text("\n\nOne  line\n\n\n\nTwo\n"), "One line\n\nTwo");
    }

    #[test]
    fn truncate_chars_respects_boundaries() {
        assert_eq!(truncate_chars("héllo", 2), "hé");
        assert_eq!(truncate_chars("hi", 5), "hi");
    }
}
