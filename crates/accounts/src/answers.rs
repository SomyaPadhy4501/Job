//! Saved answers to application questions ("Why do you want to work here?",
//! "Are you willing to relocate?").
//!
//! The question, the company it belongs to and the answer are encrypted
//! together. A hash of (user, scope, company, normalized question) finds an
//! existing answer without storing the question in the clear.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{clean_line, clean_text};

pub const MAX_ANSWERS: i64 = 300;
pub const MAX_QUESTION_CHARS: usize = 500;
pub const MAX_ANSWER_CHARS: usize = 4000;
pub const MAX_COMPANY_CHARS: usize = 100;

/// `company` answers only apply to one employer ("Why Stripe?", "Have you
/// worked at Stripe before?"); `global` ones apply everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Global,
    Company,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Global => "global",
            Scope::Company => "company",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "global" => Some(Scope::Global),
            "company" => Some(Scope::Company),
            _ => None,
        }
    }
}

/// The encrypted part of a saved answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerEntry {
    pub question: String,
    pub answer: String,
    #[serde(default)]
    pub company: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AnswerError {
    #[error("the question is empty")]
    EmptyQuestion,
    #[error("questions can be at most {MAX_QUESTION_CHARS} characters")]
    QuestionTooLong,
    #[error("the answer is empty")]
    EmptyAnswer,
    #[error("answers can be at most {MAX_ANSWER_CHARS} characters")]
    AnswerTooLong,
    #[error("a company-specific answer needs the company's name")]
    CompanyRequired,
    #[error("company names can be at most {MAX_COMPANY_CHARS} characters")]
    CompanyTooLong,
}

impl AnswerEntry {
    /// Trims and checks the entry. A global answer has no company.
    pub fn validate(&mut self, scope: Scope) -> Result<(), AnswerError> {
        self.question = clean_line(&self.question);
        self.answer = clean_text(&self.answer);
        self.company = clean_line(&self.company);
        if self.question.is_empty() {
            return Err(AnswerError::EmptyQuestion);
        }
        if self.question.chars().count() > MAX_QUESTION_CHARS {
            return Err(AnswerError::QuestionTooLong);
        }
        if self.answer.is_empty() {
            return Err(AnswerError::EmptyAnswer);
        }
        if self.answer.chars().count() > MAX_ANSWER_CHARS {
            return Err(AnswerError::AnswerTooLong);
        }
        match scope {
            Scope::Global => self.company.clear(),
            Scope::Company if self.company.is_empty() => return Err(AnswerError::CompanyRequired),
            Scope::Company if self.company.chars().count() > MAX_COMPANY_CHARS => {
                return Err(AnswerError::CompanyTooLong);
            }
            Scope::Company => {}
        }
        Ok(())
    }
}

/// Lowercase words only, so "Are you willing to relocate?*" and
/// "are you willing to relocate" are the same question.
pub fn normalize_question(question: &str) -> String {
    let lowered = question
        .to_lowercase()
        .replace("(required)", " ")
        .replace("(optional)", " ");
    words(&lowered)
}

/// "Stripe, Inc." and "stripe" are the same company.
pub fn normalize_company(company: &str) -> String {
    let mut name = words(&company.to_lowercase());
    for suffix in [
        " incorporated",
        " inc",
        " llc",
        " ltd",
        " limited",
        " corporation",
        " corp",
        " co",
        " plc",
        " gmbh",
    ] {
        if let Some(stripped) = name.strip_suffix(suffix) {
            name = stripped.to_owned();
            break;
        }
    }
    name
}

fn words(s: &str) -> String {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The lookup key for an answer: SHA-256 over the owner, scope, company and
/// question, so the same question for the same company updates in place.
pub fn entry_key(owner: &Uuid, scope: Scope, entry: &AnswerEntry) -> [u8; 32] {
    let company = match scope {
        Scope::Global => String::new(),
        Scope::Company => normalize_company(&entry.company),
    };
    crate::token::sha256_parts(&[
        b"answer/v1",
        owner.as_bytes(),
        scope.as_str().as_bytes(),
        company.as_bytes(),
        normalize_question(&entry.question).as_bytes(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(q: &str, a: &str, c: &str) -> AnswerEntry {
        AnswerEntry {
            question: q.into(),
            answer: a.into(),
            company: c.into(),
        }
    }

    #[test]
    fn questions_match_despite_punctuation_and_markers() {
        assert_eq!(
            normalize_question("Are you willing to relocate?*"),
            "are you willing to relocate"
        );
        assert_eq!(
            normalize_question("  ARE you willing to relocate (Required) "),
            "are you willing to relocate"
        );
    }

    #[test]
    fn company_suffixes_are_ignored() {
        assert_eq!(normalize_company("Stripe, Inc."), "stripe");
        assert_eq!(
            normalize_company("Palo Alto Networks"),
            "palo alto networks"
        );
    }

    #[test]
    fn keys_separate_users_scopes_and_companies() {
        let user = Uuid::new_v4();
        let q = entry("Why do you want to work here?", "…", "Stripe, Inc.");
        let same = entry("why do you want to work here", "other", "stripe");
        assert_eq!(
            entry_key(&user, Scope::Company, &q),
            entry_key(&user, Scope::Company, &same)
        );
        assert_ne!(
            entry_key(&user, Scope::Company, &q),
            entry_key(&Uuid::new_v4(), Scope::Company, &q)
        );
        assert_ne!(
            entry_key(&user, Scope::Company, &q),
            entry_key(&user, Scope::Global, &q)
        );
        let other_company = entry("Why do you want to work here?", "…", "Ramp");
        assert_ne!(
            entry_key(&user, Scope::Company, &q),
            entry_key(&user, Scope::Company, &other_company)
        );
        // A global answer ignores any company sent with it.
        assert_eq!(
            entry_key(&user, Scope::Global, &q),
            entry_key(&user, Scope::Global, &other_company)
        );
    }

    #[test]
    fn validation() {
        let mut ok = entry(
            "  Willing to relocate? ",
            " Yes \n\n\n within the US ",
            "Acme",
        );
        ok.validate(Scope::Global).unwrap();
        assert_eq!(
            ok,
            entry("Willing to relocate?", "Yes\n\nwithin the US", "")
        );
        assert_eq!(
            entry("", "a", "").validate(Scope::Global),
            Err(AnswerError::EmptyQuestion)
        );
        assert_eq!(
            entry("q", " ", "").validate(Scope::Global),
            Err(AnswerError::EmptyAnswer)
        );
        assert_eq!(
            entry("q", "a", "").validate(Scope::Company),
            Err(AnswerError::CompanyRequired)
        );
        assert_eq!(
            entry(&"q".repeat(501), "a", "").validate(Scope::Global),
            Err(AnswerError::QuestionTooLong)
        );
        assert_eq!(
            entry("q", &"a".repeat(4001), "").validate(Scope::Global),
            Err(AnswerError::AnswerTooLong)
        );
    }
}
