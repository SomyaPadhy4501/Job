//! Resume titles and tags ("AI Engineer", "SWE", "Platform", …).

use crate::clean_line;

pub const MAX_TAGS: usize = 10;
pub const MAX_TAG_CHARS: usize = 32;
pub const MAX_TITLE_CHARS: usize = 80;

/// Offered as one-click chips in the web app. Users can type anything else.
pub const SUGGESTED_TAGS: &[&str] = &[
    "SWE",
    "AI Engineer",
    "ML",
    "Data",
    "Platform",
    "Backend",
    "Frontend",
    "Full-stack",
    "SRE/DevOps",
    "Security",
    "Mobile",
];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TagError {
    #[error("a resume can have at most {MAX_TAGS} tags")]
    TooMany,
    #[error("tags can be at most {MAX_TAG_CHARS} characters ({0:?} is longer)")]
    TooLong(String),
    #[error("give the resume a title")]
    EmptyTitle,
    #[error("titles can be at most {MAX_TITLE_CHARS} characters")]
    TitleTooLong,
}

/// Trims each tag, collapses spaces, drops empty ones and case-insensitive
/// duplicates (keeping the first spelling), and enforces the limits.
pub fn normalize_tags<S: AsRef<str>>(raw: &[S]) -> Result<Vec<String>, TagError> {
    let mut out: Vec<String> = Vec::new();
    for tag in raw {
        let tag = clean_line(tag.as_ref());
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(TagError::TooLong(tag));
        }
        let lower = tag.to_lowercase();
        if out.iter().any(|t| t.to_lowercase() == lower) {
            continue;
        }
        out.push(tag);
    }
    if out.len() > MAX_TAGS {
        return Err(TagError::TooMany);
    }
    Ok(out)
}

/// Tags sent as one form field: a JSON array, or comma-separated text.
pub fn split_tag_field(field: &str) -> Vec<String> {
    let field = field.trim();
    if field.starts_with('[')
        && let Ok(tags) = serde_json::from_str::<Vec<String>>(field)
    {
        return tags;
    }
    field.split(',').map(str::to_owned).collect()
}

pub fn normalize_title(raw: &str) -> Result<String, TagError> {
    let title = clean_line(raw);
    if title.is_empty() {
        return Err(TagError::EmptyTitle);
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(TagError::TitleTooLong);
    }
    Ok(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_trimmed_deduplicated_and_keep_the_users_casing() {
        let tags = normalize_tags(&["  AI   Engineer ", "swe", "SWE", "", "Platform"]).unwrap();
        assert_eq!(tags, ["AI Engineer", "swe", "Platform"]);
    }

    #[test]
    fn tag_limits() {
        let eleven: Vec<String> = (0..11).map(|i| format!("t{i}")).collect();
        assert_eq!(normalize_tags(&eleven), Err(TagError::TooMany));
        let long = "x".repeat(33);
        assert_eq!(
            normalize_tags(&[long.as_str()]),
            Err(TagError::TooLong(long.clone()))
        );
        // Duplicates don't count towards the limit.
        let mut ten: Vec<String> = (0..10).map(|i| format!("t{i}")).collect();
        ten.push("T0".into());
        assert_eq!(normalize_tags(&ten).unwrap().len(), 10);
    }

    #[test]
    fn tag_field_accepts_json_or_commas() {
        assert_eq!(split_tag_field(r#"["SWE","AI, ML"]"#), ["SWE", "AI, ML"]);
        assert_eq!(split_tag_field("SWE, Platform"), ["SWE", " Platform"]);
    }

    #[test]
    fn titles() {
        assert_eq!(
            normalize_title("  Backend   resume "),
            Ok("Backend resume".into())
        );
        assert_eq!(normalize_title("   "), Err(TagError::EmptyTitle));
        assert_eq!(
            normalize_title(&"x".repeat(81)),
            Err(TagError::TitleTooLong)
        );
    }
}
