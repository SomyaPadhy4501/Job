//! The autofill profile, schema version 1.
//!
//! Every field is optional: an empty string or `null` means unknown, and the
//! extension leaves that form field alone. Booleans are true / false / null.
//! Unknown keys are dropped, enums and lengths are checked, and the whole
//! profile is capped at 64 KB of JSON.
//!
//! `Sources` records where each field came from: `"user"` (typed in the web
//! app or the extension) or `"resume:<id>"` (filled by importing a parsed
//! resume). Importing never overwrites what the user typed, including a field
//! they cleared on purpose.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{clean_line, clean_text};

pub const SCHEMA: u8 = 1;
pub const MAX_PROFILE_BYTES: usize = 64 * 1024;
pub const MAX_EDUCATION: usize = 10;
pub const MAX_EXPERIENCE: usize = 20;
pub const MAX_SKILLS: usize = 100;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub schema: u8,
    pub identity: Identity,
    pub contact: Contact,
    pub address: Address,
    pub links: Links,
    pub work_auth: WorkAuth,
    pub preferences: Preferences,
    pub education: Vec<Education>,
    pub experience: Vec<Experience>,
    pub skills: Vec<String>,
    pub eeo: Eeo,
    pub misc: Misc,
    pub board: Board,
}

/// How this person wants the job board to open: their default filters.
/// Empty means the board's own default.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Board {
    pub role: String,
    pub level: String,
    pub sponsorship: String,
    pub restriction: String,
    pub view: String,
}

const BOARD_ROLES: &[&str] = &[
    "", "SWE", "MLE", "AI", "DS", "DATA_ENG", "SRE", "SECURITY", "MOBILE",
];
const BOARD_LEVELS: &[&str] = &["", "entry", "mid", "early"];
const BOARD_SPONSORSHIP: &[&str] = &["", "YES", "ANY", "NO", "UNKNOWN"];
const BOARD_RESTRICTION: &[&str] = &["", "hide", "all", "only"];
const BOARD_VIEW: &[&str] = &["", "grouped", "list"];

fn one_of(field: &'static str, value: &mut String, allowed: &[&str]) -> Check {
    *value = clean_line(value);
    if allowed.contains(&value.as_str()) {
        Ok(())
    } else {
        Err(ProfileError::BadChoice(field))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Identity {
    pub first_name: String,
    pub middle_name: String,
    pub last_name: String,
    pub preferred_name: String,
    pub pronouns: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Contact {
    pub email: String,
    pub phone: String,
    pub phone_country_code: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Address {
    pub line1: String,
    pub line2: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Links {
    pub linkedin: String,
    pub github: String,
    pub portfolio: String,
    pub website: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkAuth {
    #[serde(rename = "authorizedUS")]
    pub authorized_us: Option<bool>,
    pub requires_sponsorship_now: Option<bool>,
    pub requires_sponsorship_future: Option<bool>,
    pub visa_status: Option<VisaStatus>,
    /// "YYYY-MM".
    pub opt_end_date: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisaStatus {
    Citizen,
    PermanentResident,
    H1b,
    F1Opt,
    F1StemOpt,
    F1Cpt,
    Other,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub relocate: Option<bool>,
    /// "YYYY-MM-DD".
    pub earliest_start: String,
    pub work_mode: Option<WorkMode>,
    pub salary_expectation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkMode {
    Onsite,
    Hybrid,
    Remote,
    Any,
}

/// Dates are "YYYY-MM", or "YYYY" when the resume gives only a year.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Education {
    pub school: String,
    pub degree: String,
    pub field: String,
    pub gpa: String,
    pub start_date: String,
    pub end_date: String,
}

/// Dates are "YYYY-MM", or "YYYY" when the resume gives only a year.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Experience {
    pub company: String,
    pub title: String,
    pub location: String,
    pub start_date: String,
    pub end_date: String,
    pub current: Option<bool>,
    pub description: String,
}

/// Voluntary self-identification. Each is the user's explicit choice
/// ("decline" included) or null; nothing here is ever inferred.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Eeo {
    pub gender: Option<String>,
    pub hispanic_latino: Option<String>,
    pub race: Option<String>,
    pub veteran: Option<String>,
    pub disability: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Misc {
    pub over18: Option<bool>,
    pub how_did_you_hear: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProfileError {
    #[error("{0} can be at most {1} characters")]
    TooLong(String, usize),
    #[error("{0} must be a date like {1}")]
    BadDate(String, &'static str),
    #[error("{0} must be a web address (https://…)")]
    BadLink(String),
    #[error("{0} must be an email address")]
    BadEmail(String),
    #[error("at most {1} {0} entries")]
    TooMany(&'static str, usize),
    #[error("the profile is over 64 KB")]
    TooLarge,
    #[error("{0} isn't one of the listed options")]
    BadChoice(&'static str),
}

type Check = Result<(), ProfileError>;

fn line(field: &str, value: &mut String, max: usize) -> Check {
    *value = clean_line(value);
    if value.chars().count() > max {
        return Err(ProfileError::TooLong(field.to_owned(), max));
    }
    Ok(())
}

fn paragraph(field: &str, value: &mut String, max: usize) -> Check {
    *value = clean_text(value);
    if value.chars().count() > max {
        return Err(ProfileError::TooLong(field.to_owned(), max));
    }
    Ok(())
}

/// "", "YYYY" or "YYYY-MM".
fn month(field: &str, value: &mut String) -> Check {
    *value = clean_line(value);
    let b = value.as_bytes();
    let year_ok = |y: &[u8]| {
        y.len() == 4 && y.iter().all(u8::is_ascii_digit) && (y[0] == b'1' || y[0] == b'2')
    };
    let ok = match b.len() {
        0 => true,
        4 => year_ok(b),
        7 => {
            year_ok(&b[..4])
                && b[4] == b'-'
                && b[5..].iter().all(u8::is_ascii_digit)
                && (1..=12).contains(&((b[5] - b'0') * 10 + (b[6] - b'0')))
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(ProfileError::BadDate(field.to_owned(), "2026-05"))
    }
}

/// "", "YYYY", "YYYY-MM" or a real calendar date "YYYY-MM-DD". Education and
/// job dates: the day is optional, and lets forms with day pickers be filled.
fn month_or_day(field: &str, value: &mut String) -> Check {
    *value = clean_line(value);
    if value.len() == 10 {
        let format = time::macros::format_description!("[year]-[month]-[day]");
        return match time::Date::parse(value, &format) {
            Ok(_) => Ok(()),
            Err(_) => Err(ProfileError::BadDate(field.to_owned(), "2026-05")),
        };
    }
    month(field, value)
}

/// "" or a real calendar date "YYYY-MM-DD".
fn day(field: &str, value: &mut String) -> Check {
    *value = clean_line(value);
    if value.is_empty() {
        return Ok(());
    }
    let format = time::macros::format_description!("[year]-[month]-[day]");
    match time::Date::parse(value, &format) {
        Ok(_) => Ok(()),
        Err(_) => Err(ProfileError::BadDate(field.to_owned(), "2026-06-01")),
    }
}

/// "" or an http(s) URL; a bare "github.com/jane" gets https:// added. Other
/// schemes (javascript:, data:) are refused, since these become links.
fn link(field: &str, value: &mut String) -> Check {
    *value = clean_line(value);
    if value.is_empty() {
        return Ok(());
    }
    if value.chars().count() > 300 {
        return Err(ProfileError::TooLong(field.to_owned(), 300));
    }
    let lower = value.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        if value.contains("://")
            || value
                .split('/')
                .next()
                .is_some_and(|host| host.contains(':'))
        {
            return Err(ProfileError::BadLink(field.to_owned()));
        }
        *value = format!("https://{value}");
    }
    match url::Url::parse(value) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some_and(|h| h.contains('.')) =>
        {
            Ok(())
        }
        _ => Err(ProfileError::BadLink(field.to_owned())),
    }
}

fn email(field: &str, value: &mut String) -> Check {
    *value = clean_line(value);
    if value.is_empty() {
        return Ok(());
    }
    let valid = value.len() <= 254
        && !value.contains(' ')
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.contains('@')
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        });
    if valid {
        Ok(())
    } else {
        Err(ProfileError::BadEmail(field.to_owned()))
    }
}

fn choice(field: &str, value: &mut Option<String>) -> Check {
    if let Some(v) = value {
        line(field, v, 60)?;
        if v.is_empty() {
            *value = None;
        }
    }
    Ok(())
}

impl Profile {
    /// Trims and checks every field, and returns the first problem found.
    pub fn validate(&mut self) -> Check {
        self.schema = SCHEMA;

        let id = &mut self.identity;
        line("First name", &mut id.first_name, 100)?;
        line("Middle name", &mut id.middle_name, 100)?;
        line("Last name", &mut id.last_name, 100)?;
        line("Preferred name", &mut id.preferred_name, 100)?;
        line("Pronouns", &mut id.pronouns, 40)?;

        let c = &mut self.contact;
        email("Email", &mut c.email)?;
        line("Phone", &mut c.phone, 40)?;
        line("Phone country code", &mut c.phone_country_code, 8)?;

        let a = &mut self.address;
        line("Address line 1", &mut a.line1, 200)?;
        line("Address line 2", &mut a.line2, 200)?;
        line("City", &mut a.city, 100)?;
        line("State", &mut a.state, 100)?;
        line("Postal code", &mut a.postal_code, 20)?;
        line("Country", &mut a.country, 100)?;

        let l = &mut self.links;
        link("LinkedIn", &mut l.linkedin)?;
        link("GitHub", &mut l.github)?;
        link("Portfolio", &mut l.portfolio)?;
        link("Website", &mut l.website)?;

        month("OPT end date", &mut self.work_auth.opt_end_date)?;

        let p = &mut self.preferences;
        day("Earliest start date", &mut p.earliest_start)?;
        line("Salary expectation", &mut p.salary_expectation, 100)?;

        if self.education.len() > MAX_EDUCATION {
            return Err(ProfileError::TooMany("education", MAX_EDUCATION));
        }
        for e in &mut self.education {
            line("School", &mut e.school, 200)?;
            line("Degree", &mut e.degree, 120)?;
            line("Field of study", &mut e.field, 120)?;
            line("GPA", &mut e.gpa, 20)?;
            month_or_day("Education start date", &mut e.start_date)?;
            month_or_day("Education end date", &mut e.end_date)?;
        }
        self.education
            .retain(|e| !(e.school.is_empty() && e.degree.is_empty() && e.field.is_empty()));

        if self.experience.len() > MAX_EXPERIENCE {
            return Err(ProfileError::TooMany("experience", MAX_EXPERIENCE));
        }
        for e in &mut self.experience {
            line("Company", &mut e.company, 200)?;
            line("Job title", &mut e.title, 200)?;
            line("Job location", &mut e.location, 200)?;
            month_or_day("Job start date", &mut e.start_date)?;
            month_or_day("Job end date", &mut e.end_date)?;
            paragraph("Job description", &mut e.description, 2000)?;
        }
        self.experience
            .retain(|e| !(e.company.is_empty() && e.title.is_empty()));

        let mut seen = std::collections::HashSet::new();
        let mut skills = Vec::new();
        for s in std::mem::take(&mut self.skills) {
            let mut s = s;
            line("Skill", &mut s, 60)?;
            if !s.is_empty() && seen.insert(s.to_lowercase()) {
                skills.push(s);
            }
        }
        if skills.len() > MAX_SKILLS {
            return Err(ProfileError::TooMany("skills", MAX_SKILLS));
        }
        self.skills = skills;

        let e = &mut self.eeo;
        choice("Gender", &mut e.gender)?;
        choice("Hispanic or Latino", &mut e.hispanic_latino)?;
        choice("Race", &mut e.race)?;
        choice("Veteran status", &mut e.veteran)?;
        choice("Disability status", &mut e.disability)?;

        line(
            "How did you hear about us",
            &mut self.misc.how_did_you_hear,
            200,
        )?;

        let b = &mut self.board;
        one_of("Role type", &mut b.role, BOARD_ROLES)?;
        one_of("Level", &mut b.level, BOARD_LEVELS)?;
        one_of("Sponsorship filter", &mut b.sponsorship, BOARD_SPONSORSHIP)?;
        one_of("Restriction filter", &mut b.restriction, BOARD_RESTRICTION)?;
        one_of("Board view", &mut b.view, BOARD_VIEW)?;

        let size = serde_json::to_vec(self)
            .map(|v| v.len())
            .unwrap_or(usize::MAX);
        if size > MAX_PROFILE_BYTES {
            return Err(ProfileError::TooLarge);
        }
        Ok(())
    }
}

/// Field path → `"user"` or `"resume:<id>"`.
pub type Sources = BTreeMap<String, String>;

pub const SOURCE_USER: &str = "user";

/// The profile as `path → value`, where objects are walked and arrays and
/// scalars are leaves ("identity.firstName", "education", "skills").
pub fn leaves(profile: &Profile) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    let value = serde_json::to_value(profile).expect("a profile serializes");
    walk(&value, "", &mut out);
    out.remove("schema");
    out
}

fn walk(value: &Value, prefix: &str, out: &mut BTreeMap<String, Value>) {
    match value {
        Value::Object(map) => {
            for (key, v) in map {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                walk(v, &path, out);
            }
        }
        other => {
            out.insert(prefix.to_owned(), other.clone());
        }
    }
}

fn is_blank(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

/// After the user saves the profile: every field whose value changed is now
/// theirs.
pub fn mark_user_edits(old: &Profile, new: &Profile, sources: &mut Sources) {
    let before = leaves(old);
    for (path, value) in leaves(new) {
        if before.get(&path) != Some(&value) {
            sources.insert(path, SOURCE_USER.to_owned());
        }
    }
}

/// Fills `profile` from a parsed resume. A field is filled when an earlier
/// resume filled it, or when it is empty and the user never touched it.
/// Returns the paths that changed.
pub fn import_resume(
    profile: &mut Profile,
    sources: &mut Sources,
    parsed: &Profile,
    resume_id: &Uuid,
) -> Vec<String> {
    let current = leaves(profile);
    let mut value = serde_json::to_value(&*profile).expect("a profile serializes");
    let source = format!("resume:{resume_id}");
    let mut changed = Vec::new();
    for (path, new) in leaves(parsed) {
        if is_blank(&new) {
            continue;
        }
        let existing = current.get(&path).unwrap_or(&Value::Null);
        let may_fill = match sources.get(&path) {
            Some(s) if s == SOURCE_USER => false,
            Some(s) if s.starts_with("resume:") => true,
            _ => is_blank(existing),
        };
        if may_fill && existing != &new {
            set_path(&mut value, &path, new);
            sources.insert(path.clone(), source.clone());
            changed.push(path);
        }
    }
    *profile = serde_json::from_value(value).expect("paths come from the same schema");
    changed
}

fn set_path(root: &mut Value, path: &str, new: Value) {
    let mut node = root;
    let mut parts = path.split('.').peekable();
    while let Some(part) = parts.next() {
        let Value::Object(map) = node else { return };
        if parts.peek().is_none() {
            map.insert(part.to_owned(), new);
            return;
        }
        node = map
            .entry(part.to_owned())
            .or_insert_with(|| Value::Object(Default::default()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_shape_matches_the_extension_contract() {
        let mut p = Profile::default();
        p.work_auth.authorized_us = Some(true);
        p.work_auth.visa_status = Some(VisaStatus::F1StemOpt);
        p.preferences.work_mode = Some(WorkMode::Hybrid);
        p.misc.over18 = Some(true);
        p.validate().unwrap();
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["schema"], 1);
        assert_eq!(v["workAuth"]["authorizedUS"], true);
        assert_eq!(v["workAuth"]["visaStatus"], "f1_stem_opt");
        assert_eq!(v["workAuth"]["requiresSponsorshipNow"], Value::Null);
        assert_eq!(v["preferences"]["workMode"], "hybrid");
        assert_eq!(v["contact"]["phoneCountryCode"], "");
        assert_eq!(v["address"]["postalCode"], "");
        assert_eq!(v["misc"]["over18"], true);
        assert_eq!(v["eeo"]["hispanicLatino"], Value::Null);
        assert!(v["education"].as_array().unwrap().is_empty());
    }

    #[test]
    fn board_defaults_take_only_listed_options() {
        let mut p = Profile::default();
        p.board.role = " MLE ".into();
        p.board.sponsorship = "ANY".into();
        p.validate().unwrap();
        assert_eq!(p.board.role, "MLE");
        assert_eq!(
            serde_json::to_value(&p).unwrap()["board"]["sponsorship"],
            "ANY"
        );
        p.board.level = "senior".into();
        assert_eq!(p.validate(), Err(ProfileError::BadChoice("Level")));
        // Old profiles without the section still read.
        let old: Profile =
            serde_json::from_value(json!({"identity": {"firstName": "Jane"}})).unwrap();
        assert_eq!(old.board, Board::default());
    }

    #[test]
    fn unknown_keys_are_dropped_and_bad_enums_rejected() {
        let p: Profile = serde_json::from_value(
            json!({"identity": {"firstName": "Jane", "nickname": "JJ"}, "extra": 1}),
        )
        .unwrap();
        assert_eq!(p.identity.first_name, "Jane");
        assert!(
            serde_json::from_value::<Profile>(json!({"workAuth": {"visaStatus": "tourist"}}))
                .is_err()
        );
    }

    #[test]
    fn validation_cleans_and_checks() {
        let mut p: Profile = serde_json::from_value(json!({
            "identity": {"firstName": "  Jane  "},
            "links": {"github": "github.com/jane", "linkedin": "https://www.linkedin.com/in/jane"},
            "education": [{"school": "MIT", "endDate": "2026-05"}, {"school": " "}],
            "experience": [{"company": "Acme", "startDate": "2024", "description": "a\n\n\n\nb"}],
            "skills": ["Rust", "rust", " Go ", ""],
            "eeo": {"gender": "  "}
        }))
        .unwrap();
        p.validate().unwrap();
        assert_eq!(p.identity.first_name, "Jane");
        assert_eq!(p.links.github, "https://github.com/jane");
        assert_eq!(p.education.len(), 1);
        assert_eq!(p.experience[0].description, "a\n\nb");
        assert_eq!(p.skills, ["Rust", "Go"]);
        assert_eq!(p.eeo.gender, None);
    }

    #[test]
    fn rejects_bad_values() {
        let bad = |v: Value| {
            serde_json::from_value::<Profile>(v)
                .unwrap()
                .validate()
                .unwrap_err()
        };
        assert!(matches!(
            bad(json!({"links": {"portfolio": "javascript:alert(1)"}})),
            ProfileError::BadLink(_)
        ));
        assert!(matches!(
            bad(json!({"links": {"website": "data:text/html,hi"}})),
            ProfileError::BadLink(_)
        ));
        assert!(matches!(
            bad(json!({"contact": {"email": "not-an-email"}})),
            ProfileError::BadEmail(_)
        ));
        assert!(matches!(
            bad(json!({"workAuth": {"optEndDate": "2026-13"}})),
            ProfileError::BadDate(..)
        ));
        assert!(matches!(
            bad(json!({"preferences": {"earliestStart": "2026-02-30"}})),
            ProfileError::BadDate(..)
        ));
        // Education and job dates may carry a day, but it must be real.
        assert!(matches!(
            bad(json!({"education": [{"school": "MIT", "endDate": "2026-02-30"}]})),
            ProfileError::BadDate(..)
        ));
        let mut ok: Profile = serde_json::from_value(json!({
            "education": [{"school": "MIT", "startDate": "2022", "endDate": "2026-05-15"}],
            "experience": [{"company": "Acme", "startDate": "2024-01"}]
        }))
        .unwrap();
        ok.validate().unwrap();
        assert_eq!(ok.education[0].end_date, "2026-05-15");
        assert!(matches!(
            bad(json!({"identity": {"firstName": "x".repeat(101)}})),
            ProfileError::TooLong(..)
        ));
        let many: Vec<Value> = (0..21)
            .map(|i| json!({"company": format!("c{i}")}))
            .collect();
        assert!(matches!(
            bad(json!({"experience": many})),
            ProfileError::TooMany("experience", 20)
        ));
    }

    #[test]
    fn user_edits_are_tracked_per_field() {
        let old = Profile::default();
        let mut new = old.clone();
        new.identity.first_name = "Jane".into();
        new.skills = vec!["Rust".into()];
        let mut sources = Sources::new();
        mark_user_edits(&old, &new, &mut sources);
        assert_eq!(
            sources.get("identity.firstName").map(String::as_str),
            Some("user")
        );
        assert_eq!(sources.get("skills").map(String::as_str), Some("user"));
        assert!(!sources.contains_key("identity.lastName"));
    }

    #[test]
    fn importing_a_resume_respects_the_user() {
        let r1 = Uuid::new_v4();
        let r2 = Uuid::new_v4();
        let mut profile = Profile::default();
        profile.identity.first_name = "Janie".into(); // typed by the user
        let mut sources = Sources::from([("identity.firstName".to_owned(), "user".to_owned())]);
        // The user also cleared the phone on purpose.
        sources.insert("contact.phone".into(), "user".into());

        let mut parsed = Profile::default();
        parsed.identity.first_name = "Jane".into();
        parsed.identity.last_name = "Doe".into();
        parsed.contact.phone = "555-0100".into();
        parsed.skills = vec!["Rust".into()];

        let changed = import_resume(&mut profile, &mut sources, &parsed, &r1);
        assert_eq!(profile.identity.first_name, "Janie");
        assert_eq!(profile.identity.last_name, "Doe");
        assert_eq!(profile.contact.phone, "");
        assert_eq!(profile.skills, ["Rust"]);
        assert_eq!(changed, ["identity.lastName", "skills"]);
        assert_eq!(sources["identity.lastName"], format!("resume:{r1}"));

        // A newer resume may replace what an older resume filled.
        parsed.identity.last_name = "Doe-Smith".into();
        parsed.skills = vec!["Rust".into(), "Go".into()];
        import_resume(&mut profile, &mut sources, &parsed, &r2);
        assert_eq!(profile.identity.last_name, "Doe-Smith");
        assert_eq!(profile.skills, ["Rust", "Go"]);
        assert_eq!(sources["skills"], format!("resume:{r2}"));
    }

    #[test]
    fn importing_never_replaces_untracked_values() {
        // A value with no recorded source (typed before tracking existed) counts as the user's.
        let mut profile = Profile::default();
        profile.contact.email = "jane@old.example".into();
        let mut parsed = Profile::default();
        parsed.contact.email = "jane@new.example".into();
        let changed = import_resume(&mut profile, &mut Sources::new(), &parsed, &Uuid::new_v4());
        assert!(changed.is_empty());
        assert_eq!(profile.contact.email, "jane@old.example");
    }
}
