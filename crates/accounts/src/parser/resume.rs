//! Rule-based resume fields: name, contact details, links, location,
//! education, experience and skills.
//!
//! The text is split into sections by their headings. Contact details are read
//! from the lines above the first heading. Education and experience entries
//! are anchored on their dates. Everything is a best guess that the user
//! reviews before it reaches their profile; a field that can't be found is
//! left empty rather than guessed.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::profile::{self, Education, Experience, Profile};
use crate::{clean_line, truncate_chars};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ParsedResume {
    pub parser_version: i16,
    pub first_name: String,
    pub middle_name: String,
    pub last_name: String,
    pub emails: Vec<String>,
    pub phone: String,
    pub phone_country_code: String,
    pub linkedin: String,
    pub github: String,
    pub portfolio: String,
    pub city: String,
    pub state: String,
    pub country: String,
    pub education: Vec<Education>,
    pub experience: Vec<Experience>,
    pub skills: Vec<String>,
    /// Section headings found, in order.
    pub sections: Vec<String>,
    /// Fields the parser couldn't find, for the review screen.
    pub missing: Vec<String>,
}

impl ParsedResume {
    /// The parsed fields in profile form, for importing.
    pub fn to_profile(&self) -> Profile {
        let mut p = Profile::default();
        p.identity.first_name = self.first_name.clone();
        p.identity.middle_name = self.middle_name.clone();
        p.identity.last_name = self.last_name.clone();
        p.contact.email = self.emails.first().cloned().unwrap_or_default();
        p.contact.phone = self.phone.clone();
        p.contact.phone_country_code = self.phone_country_code.clone();
        p.links.linkedin = self.linkedin.clone();
        p.links.github = self.github.clone();
        p.links.portfolio = self.portfolio.clone();
        p.address.city = self.city.clone();
        p.address.state = self.state.clone();
        p.address.country = self.country.clone();
        p.education = self.education.clone();
        p.experience = self.experience.clone();
        p.skills = self.skills.clone();
        let fallback = Profile {
            identity: p.identity.clone(),
            contact: p.contact.clone(),
            ..Profile::default()
        };
        if p.validate().is_ok() {
            return p;
        }
        let mut fallback = fallback;
        if fallback.validate().is_ok() {
            fallback
        } else {
            Profile::default()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Education,
    Experience,
    Projects,
    Skills,
    Other,
}

use Section::*;

const HEADINGS: &[(&str, Section)] = &[
    ("education", Education),
    ("academic background", Education),
    ("educational background", Education),
    ("academics", Education),
    ("academic history", Education),
    ("education & training", Education),
    ("education & certifications", Education),
    ("experience", Experience),
    ("work experience", Experience),
    ("professional experience", Experience),
    ("relevant experience", Experience),
    ("employment", Experience),
    ("employment history", Experience),
    ("work history", Experience),
    ("internships", Experience),
    ("internship experience", Experience),
    ("industry experience", Experience),
    ("technical experience", Experience),
    ("research experience", Experience),
    ("research", Experience),
    ("work & research experience", Experience),
    ("teaching experience", Experience),
    ("professional background", Experience),
    ("career history", Experience),
    ("projects", Projects),
    ("personal projects", Projects),
    ("academic projects", Projects),
    ("selected projects", Projects),
    ("technical projects", Projects),
    ("side projects", Projects),
    ("project experience", Projects),
    ("key projects", Projects),
    ("notable projects", Projects),
    ("skills", Skills),
    ("technical skills", Skills),
    ("skills & interests", Skills),
    ("technical skills & interests", Skills),
    ("skills & certifications", Skills),
    ("core competencies", Skills),
    ("technologies", Skills),
    ("technical proficiencies", Skills),
    ("languages & technologies", Skills),
    ("skills & tools", Skills),
    ("tools & technologies", Skills),
    ("tech stack", Skills),
    ("competencies", Skills),
    ("skills summary", Skills),
    ("additional skills", Skills),
    ("programming languages", Skills),
    ("technical expertise", Skills),
    ("areas of expertise", Skills),
    ("expertise", Skills),
    ("summary", Other),
    ("professional summary", Other),
    ("objective", Other),
    ("career objective", Other),
    ("profile", Other),
    ("about", Other),
    ("about me", Other),
    ("certifications", Other),
    ("certificates", Other),
    ("licenses & certifications", Other),
    ("awards", Other),
    ("honors", Other),
    ("honors & awards", Other),
    ("awards & honors", Other),
    ("achievements", Other),
    ("accomplishments", Other),
    ("publications", Other),
    ("leadership", Other),
    ("leadership experience", Other),
    ("leadership & activities", Other),
    ("activities", Other),
    ("extracurricular activities", Other),
    ("extracurriculars", Other),
    ("volunteer", Other),
    ("volunteering", Other),
    ("volunteer experience", Other),
    ("community involvement", Other),
    ("interests", Other),
    ("hobbies", Other),
    ("coursework", Other),
    ("relevant coursework", Other),
    ("languages", Other),
    ("references", Other),
    ("patents", Other),
    ("involvement", Other),
    ("organizations", Other),
    ("affiliations", Other),
    ("military service", Other),
];

/// Sub-headings that may appear inside a skills section without ending it.
const SKILL_SUBHEADINGS: &[&str] = &[
    "languages",
    "technologies",
    "programming languages",
    "tools & technologies",
];

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid pattern")
}

const MONTH: &str = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

fn date_pattern() -> String {
    format!(
        r"(?:{MONTH}\.?,?\s*(?:(?:19|20)\d{{2}}|'\d{{2}})\b|(?:spring|summer|fall|autumn|winter)\s+(?:19|20)\d{{2}}\b|(?:0?[1-9]|1[0-2])\s*/\s*(?:19|20)\d{{2}}\b|(?:19|20)\d{{2}}\s*[/.-]\s*(?:0[1-9]|1[0-2])\b|(?:19|20)\d{{2}}\b)"
    )
}

static RANGE: LazyLock<Regex> = LazyLock::new(|| {
    let d = date_pattern();
    re(&format!(
        r"(?i)\(?\b({d})\s*(?:-|–|—|−|~|\bto\b|\buntil\b|\bthrough\b|\bthru\b)\s*({d}|present\b|current(?:ly)?\b|now\b|today\b|ongoing\b|(?:expected|anticipated|exp\.)\s*{d})\)?"
    ))
});
static SINGLE_DATE: LazyLock<Regex> = LazyLock::new(|| {
    let d = date_pattern();
    re(&format!(
        r"(?i)\(?(?:\b(?:expected|anticipated|exp\.|graduat(?:ed|ion|ing)|grad\.|class\s+of|degree\s+expected)[:\s]*)?({d})\)?"
    ))
});
static YEAR4: LazyLock<Regex> = LazyLock::new(|| re(r"(?:19|20)\d{2}"));
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\b[a-z0-9][a-z0-9._%+\-]*@(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,24}\b")
});
static PHONE_INTL: LazyLock<Regex> =
    LazyLock::new(|| re(r"\+(\d{1,3})[\s.\-]+((?:\d[\s.\-]?){6,13}\d)"));
static PHONE_US: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:\+?1[\s.\-]?)?\(?\b([1-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})\b"));
static LINKEDIN: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)(?:https?://)?(?:[a-z]{2,3}\.)?linkedin\.com/(?:in|pub)/([a-z0-9\-_%]+)")
});
static GITHUB: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)(?:https?://)?(?:www\.)?github\.com/([a-z0-9](?:[a-z0-9\-]{0,38}))"));
static URL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:https?://)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+(?:com|dev|io|me|app|net|org|ai|co|xyz|tech|page|site|codes|engineer|design|studio|blog|us|info))(/[^\s|,;()<>]*)?",
    )
});
static SEGMENT_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| re(r"\s*(?:[|•·◦▪●⋄♦❖✦➢►\u{f0b7}\u{f0a7}]|\s[–—-]\s|\t|\s{2,})\s*"));
static NAME_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"^[\p{L}][\p{L}\p{M}'’.\-]*$"));
static SCHOOL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:\b(?:[A-Z][\w.&'’\-]*|of|the|and|at|for|de)\s+){0,6}?(?:University|College|Institute|School|Academy|Polytechnic|Universit[éeà]|Universidad|Hochschule)\b(?:\s+(?:of|at|for|in)\s+[A-Z][\w.&'’\-]*(?:\s+(?:[A-Z][\w.&'’\-]*|of|and|&)){0,5})?",
    )
});
static KNOWN_SCHOOL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b(?:UC\s+(?:Berkeley|Davis|Irvine|San Diego|Santa Barbara|Santa Cruz|Riverside|Merced)|UCLA|UCSD|UCSB|UCSC|UCI|MIT|NYU|USC|CMU|UIUC|UT\s+(?:Austin|Dallas)|Georgia\s+Tech|Virginia\s+Tech|Caltech|IIIT\s+[A-Z][a-z]+|IIT\s+[A-Z][a-z]+|NIT\s+[A-Z][a-z]+|BITS\s+Pilani)\b",
    )
});
static CAMPUS: LazyLock<Regex> =
    LazyLock::new(|| re(r"^,\s*([A-Z][a-z]+(?:[\s\-][A-Z][a-z]+){0,2})"));
static DEGREE_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:(?:bachelor|master|doctor|associate)(?:['’]?s)?(?:\s+of\s+(?:science|arts|engineering|technology|applied\s+science|business\s+administration|fine\s+arts|computer\s+applications|philosophy|information\s+technology|mathematics))?|doctorate)\b",
    )
});
static DEGREE_ABBR: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b(?:B\.?\s?Sc?|B\.?\s?A(?:\.?\s?Sc)?|B\.?\s?E|B\.?\s?Tech|B\.?\s?Eng|M\.?\s?Sc?|M\.?\s?A|M\.?\s?E|M\.?\s?Tech|M\.?\s?Eng|M\.?\s?B\.?\s?A|Ph\.?\s?D|MCA|BCA|A\.?\s?S|A\.?\s?A)\b\.?",
    )
});
static FIELD_END: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)[,|;•·(]|\s[-–—]\s|\bgpa\b|\bcgpa\b|\bminors?\b|\bconcentration\b|\bspeciali[sz]ation\b|\btrack\b|\bwith\b|\bhonou?rs\b|\bcum laude\b|\bdean",
    )
});
static GPA: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:cumulative\s+|overall\s+|major\s+)?c?gpa\b[\s:]*(\d{1,2}(?:\.\d{1,3})?)(?:\s*/\s*(\d{1,3}(?:\.\d{1,2})?))?",
    )
});
static TITLE_WORD: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:engineer|engineering intern|developer|intern|internship|co-?op|scientist|analyst|researcher|assistant|associate|architect|consultant|specialist|designer|fellow|manager|lead|head of|director|officer|administrator|technician|programmer|tutor|instructor|founder|co-?founder|contractor|apprentice|member of technical staff|sde|swe|mts|representative|coordinator|president|volunteer)\b",
    )
});
static COMPANY_HINT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:inc|llc|ltd|corp|corporation|company|labs?|technologies|technology|systems|solutions|group|university|college|institute|bank|capital|partners|ventures|studios?|health|hospital|foundation|agency|gmbh|plc)\b",
    )
});
static LOCATION_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(.*?),\s*([A-Z]{2}|United States|USA|U\.S\.A?\.?|Canada|India|United Kingdom|UK|Germany|France|Ireland|Netherlands|Singapore|Australia|Israel|China|Japan|Mexico|Brazil|Spain|Switzerland|Sweden|Poland)\.?$",
    )
});
static REMOTE_TAIL: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^(.*?)[\s,(]*\b(remote|hybrid)\)?$"));

const US_STATES: &[(&str, &str)] = &[
    ("AL", "Alabama"),
    ("AK", "Alaska"),
    ("AZ", "Arizona"),
    ("AR", "Arkansas"),
    ("CA", "California"),
    ("CO", "Colorado"),
    ("CT", "Connecticut"),
    ("DE", "Delaware"),
    ("DC", "District of Columbia"),
    ("FL", "Florida"),
    ("GA", "Georgia"),
    ("HI", "Hawaii"),
    ("ID", "Idaho"),
    ("IL", "Illinois"),
    ("IN", "Indiana"),
    ("IA", "Iowa"),
    ("KS", "Kansas"),
    ("KY", "Kentucky"),
    ("LA", "Louisiana"),
    ("ME", "Maine"),
    ("MD", "Maryland"),
    ("MA", "Massachusetts"),
    ("MI", "Michigan"),
    ("MN", "Minnesota"),
    ("MS", "Mississippi"),
    ("MO", "Missouri"),
    ("MT", "Montana"),
    ("NE", "Nebraska"),
    ("NV", "Nevada"),
    ("NH", "New Hampshire"),
    ("NJ", "New Jersey"),
    ("NM", "New Mexico"),
    ("NY", "New York"),
    ("NC", "North Carolina"),
    ("ND", "North Dakota"),
    ("OH", "Ohio"),
    ("OK", "Oklahoma"),
    ("OR", "Oregon"),
    ("PA", "Pennsylvania"),
    ("PR", "Puerto Rico"),
    ("RI", "Rhode Island"),
    ("SC", "South Carolina"),
    ("SD", "South Dakota"),
    ("TN", "Tennessee"),
    ("TX", "Texas"),
    ("UT", "Utah"),
    ("VT", "Vermont"),
    ("VA", "Virginia"),
    ("WA", "Washington"),
    ("WV", "West Virginia"),
    ("WI", "Wisconsin"),
    ("WY", "Wyoming"),
];

/// First words of two-word US city names ("San Jose", "College Station").
const CITY_FIRST_WORDS: &[&str] = &[
    "New",
    "San",
    "Santa",
    "Los",
    "Las",
    "St.",
    "Saint",
    "Fort",
    "Ft.",
    "Palo",
    "Mountain",
    "Redwood",
    "Menlo",
    "Foster",
    "Culver",
    "Long",
    "Grand",
    "Baton",
    "Ann",
    "College",
    "Kansas",
    "Jersey",
    "Oklahoma",
    "Carson",
    "Iowa",
    "Rapid",
    "Sioux",
    "Overland",
    "Cedar",
    "Bowling",
    "Coral",
    "Boca",
    "Winston",
    "Chapel",
    "Silver",
    "Round",
    "Pleasant",
    "Sugar",
    "Daly",
    "Half",
    "Fair",
    "Glen",
    "Elk",
    "Bloomfield",
    "Cherry",
    "Royal",
    "Park",
    "Mount",
    "Mt.",
    "Del",
    "El",
    "La",
    "Port",
    "Virginia",
    "Cape",
    "Lake",
    "West",
    "East",
    "North",
    "South",
];
const CITIES_THREE_WORDS: &[&str] = &[
    "Salt Lake City",
    "San Luis Obispo",
    "Rancho Santa Margarita",
    "Port St. Lucie",
    "Winston Salem",
];

const PARTICLES: &[&str] = &[
    "van", "von", "de", "da", "di", "del", "della", "der", "den", "du", "la", "le", "bin", "binti",
    "al", "el", "dos", "das", "do", "ter", "ten",
];
const NAME_SUFFIXES: &[&str] = &[
    "jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "phd", "ph.d.", "md", "m.d.", "mba", "cpa", "pe",
];
const NOT_NAME_WORDS: &[&str] = &[
    "resume",
    "résumé",
    "curriculum",
    "vitae",
    "cv",
    "email",
    "phone",
    "linkedin",
    "github",
    "portfolio",
    "address",
    "contact",
    "profile",
    "summary",
    "objective",
    "page",
    "software",
    "engineer",
    "developer",
    "university",
    "college",
    "street",
    "avenue",
    "road",
];
const BULLETS: &[char] = &[
    '•', '-', '*', '▪', '◦', '●', '–', '—', '■', '➢', '►', '✓', '○', '·', '❖', '\u{f0b7}',
    '\u{f0a7}', '\u{2023}',
];

/// Reads a resume's text into fields.
pub fn parse_resume(text: &str) -> ParsedResume {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let mut out = ParsedResume {
        parser_version: super::PARSER_VERSION,
        ..Default::default()
    };

    let (header, sections) = split_sections(&lines);
    out.sections = sections.iter().map(|s| s.heading.clone()).collect();

    read_contact(&header, &lines, &mut out);
    if let Some((first, middle, last)) = header.iter().take(5).find_map(|l| find_name(l)) {
        out.first_name = first;
        out.middle_name = middle;
        out.last_name = last;
    }
    read_location(&header, &mut out);

    for SectionText { kind, body, .. } in &sections {
        match kind {
            Education if out.education.is_empty() => out.education = parse_education(body),
            Experience => {
                let room = profile::MAX_EXPERIENCE.saturating_sub(out.experience.len());
                out.experience
                    .extend(parse_experience(body).into_iter().take(room));
            }
            Skills => {
                for skill in parse_skills(body) {
                    if out.skills.len() < profile::MAX_SKILLS
                        && !out.skills.iter().any(|s| s.eq_ignore_ascii_case(&skill))
                    {
                        out.skills.push(skill);
                    }
                }
            }
            _ => {}
        }
    }

    for (missing, field) in [
        (out.first_name.is_empty(), "name"),
        (out.emails.is_empty(), "email"),
        (out.phone.is_empty(), "phone"),
        (out.education.is_empty(), "education"),
        (out.experience.is_empty(), "experience"),
        (out.skills.is_empty(), "skills"),
    ] {
        if missing {
            out.missing.push(field.to_owned());
        }
    }
    out
}

/// One section of a resume: its kind, normalized label, heading as written,
/// and the lines under it.
struct SectionText<'a> {
    kind: Section,
    label: String,
    heading: String,
    body: Vec<&'a str>,
}

/// Splits trimmed, non-empty lines into the header (the lines above the first
/// heading, at most 12) and the sections. A skills sub-heading ("Languages")
/// stays inside its skills section.
fn split_sections<'a>(lines: &[&'a str]) -> (Vec<&'a str>, Vec<SectionText<'a>>) {
    let mut header: Vec<&str> = Vec::new();
    let mut sections: Vec<SectionText<'a>> = Vec::new();
    for line in lines {
        if let Some((kind, label)) = heading(line) {
            if let Some(last) = sections.last_mut()
                && last.kind == Skills
                && SKILL_SUBHEADINGS.contains(&label.as_str())
            {
                last.body.push(line);
                continue;
            }
            sections.push(SectionText {
                kind,
                label,
                heading: clean_line(line.trim_end_matches(':')),
                body: Vec::new(),
            });
        } else if let Some(last) = sections.last_mut() {
            last.body.push(line);
        } else if header.len() < 12 {
            header.push(line);
        }
    }
    // No headings at all: treat the top of the text as the header.
    if sections.is_empty() && header.is_empty() {
        header = lines.iter().take(12).copied().collect();
    }
    (header, sections)
}

/// Everything a resume says, by section, for matching it against job
/// postings. Unlike [`ParsedResume`] it keeps projects, the summary and
/// coursework, and the skills section's lines as written.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResumeDocument {
    /// Entries with their dates; `description` holds the bullets, one per line.
    pub experience: Vec<Experience>,
    /// Project lines (names and bullets), bullet marks removed.
    pub projects: Vec<String>,
    /// Summary, objective or profile lines.
    pub summary: Vec<String>,
    /// The skills sections' lines, bullet marks removed.
    pub skills: Vec<String>,
    /// Education and coursework lines.
    pub education: Vec<String>,
    /// Every other section's lines (awards, leadership, activities…).
    pub other: Vec<String>,
    /// The resume had no section headings at all; everything is in `other`.
    pub unsectioned: bool,
}

const SUMMARY_LABELS: &[&str] = &[
    "summary",
    "professional summary",
    "objective",
    "career objective",
    "profile",
    "about",
    "about me",
];
const COURSEWORK_LABELS: &[&str] = &["coursework", "relevant coursework"];

/// Reads a resume's text into sections, for matching.
pub fn parse_document(text: &str) -> ResumeDocument {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let (_, sections) = split_sections(&lines);
    let mut doc = ResumeDocument::default();
    if sections.is_empty() {
        doc.unsectioned = true;
        doc.other = lines.iter().map(|l| clean_line(strip_bullet(l))).collect();
        return doc;
    }
    let cleaned = |body: &[&str]| -> Vec<String> {
        body.iter()
            .map(|l| clean_line(strip_bullet(l)))
            .filter(|l| !l.is_empty())
            .collect()
    };
    for s in &sections {
        match s.kind {
            Experience => {
                let room = profile::MAX_EXPERIENCE.saturating_sub(doc.experience.len());
                doc.experience
                    .extend(parse_experience(&s.body).into_iter().take(room));
            }
            Projects => doc.projects.extend(cleaned(&s.body)),
            Skills => doc.skills.extend(cleaned(&s.body)),
            Education => doc.education.extend(cleaned(&s.body)),
            Other if SUMMARY_LABELS.contains(&s.label.as_str()) => {
                doc.summary.extend(cleaned(&s.body))
            }
            Other if COURSEWORK_LABELS.contains(&s.label.as_str()) => {
                doc.education.extend(cleaned(&s.body))
            }
            Other => doc.other.extend(cleaned(&s.body)),
        }
    }
    doc
}

/// A section heading's kind and its normalized label.
fn heading(line: &str) -> Option<(Section, String)> {
    let trimmed = line
        .trim()
        .trim_start_matches(|c: char| c == '#' || BULLETS.contains(&c) || c.is_whitespace())
        .trim_end_matches(|c: char| {
            matches!(c, ':' | '.' | '-' | '—' | '–' | '|') || c.is_whitespace()
        });
    if trimmed.is_empty() || trimmed.chars().count() > 45 {
        return None;
    }
    // "E D U C A T I O N" and "W O R K  E X P E R I E N C E".
    let letter_spaced = trimmed
        .split(' ')
        .filter(|w| !w.is_empty())
        .all(|w| w.chars().count() == 1)
        && trimmed.len() > 4;
    let words: String = if letter_spaced {
        trimmed
            .split("  ")
            .map(|w| w.replace(' ', ""))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        trimmed.to_owned()
    };
    let label = clean_line(
        &words
            .to_lowercase()
            .replace(" and ", " & ")
            .replace('＆', "&"),
    );
    HEADINGS
        .iter()
        .find(|(h, _)| *h == label)
        .map(|(_, kind)| (*kind, label))
}

fn split_segments(line: &str) -> Vec<String> {
    SEGMENT_SPLIT
        .split(line)
        .map(clean_line)
        .filter(|s| !s.is_empty())
        .collect()
}

fn read_contact(header: &[&str], all: &[&str], out: &mut ParsedResume) {
    let top = header.join("\n");
    let wide = all.iter().take(20).copied().collect::<Vec<_>>().join("\n");

    for m in EMAIL.find_iter(&top).chain(EMAIL.find_iter(&wide)) {
        let email = m.as_str().to_lowercase();
        if !out.emails.contains(&email) && out.emails.len() < 3 {
            out.emails.push(email);
        }
    }
    let without_emails = EMAIL.replace_all(&top, " ");

    for text in [without_emails.as_ref(), wide.as_str()] {
        if !out.phone.is_empty() {
            break;
        }
        let intl = PHONE_INTL.captures(text).filter(|c| &c[1] != "1");
        if let Some(c) = intl {
            out.phone_country_code = format!("+{}", &c[1]);
            out.phone = clean_line(&c[2]);
        } else if let Some(c) = PHONE_US.captures(text) {
            out.phone_country_code = "+1".into();
            out.phone = format!("{}-{}-{}", &c[1], &c[2], &c[3]);
        }
    }

    if let Some(c) = LINKEDIN.captures(&top).or_else(|| LINKEDIN.captures(&wide)) {
        out.linkedin = format!(
            "https://www.linkedin.com/in/{}",
            c[1].trim_end_matches(['.', '/'])
        );
    }
    if let Some(c) = GITHUB.captures(&top).or_else(|| GITHUB.captures(&wide)) {
        out.github = format!("https://github.com/{}", &c[1]);
    }
    for m in URL.captures_iter(&without_emails) {
        let host = m[1].to_lowercase();
        let blocked = [
            "linkedin.com",
            "github.com",
            "gmail.com",
            "outlook.com",
            "yahoo.com",
            "hotmail.com",
            "icloud.com",
        ];
        if blocked
            .iter()
            .any(|b| host == *b || host.ends_with(&format!(".{b}")))
        {
            continue;
        }
        let path = m
            .get(2)
            .map_or("", |p| p.as_str())
            .trim_end_matches(['.', '/']);
        out.portfolio = format!("https://{host}{path}");
        break;
    }
}

fn find_name(line: &str) -> Option<(String, String, String)> {
    let first_segment = split_segments(line).into_iter().next().unwrap_or_default();
    parse_name(line).or_else(|| parse_name(&first_segment))
}

fn parse_name(raw: &str) -> Option<(String, String, String)> {
    let s = raw.split(',').next().unwrap_or("").trim();
    if s.is_empty()
        || s.chars().count() > 60
        || s.chars()
            .any(|c| c.is_ascii_digit() || matches!(c, '@' | '/' | ':' | '|' | '(' | ')'))
        || heading(s).is_some()
    {
        return None;
    }
    let mut words: Vec<&str> = s.split_whitespace().collect();
    while words.len() > 2
        && words
            .last()
            .is_some_and(|w| NAME_SUFFIXES.contains(&w.to_lowercase().as_str()))
    {
        words.pop();
    }
    if !(2..=5).contains(&words.len()) {
        return None;
    }
    for w in &words {
        let lower = w.to_lowercase();
        if NOT_NAME_WORDS.contains(&lower.as_str()) || !NAME_WORD.is_match(w) {
            return None;
        }
        let starts_upper = w.chars().next().is_some_and(char::is_uppercase);
        if !starts_upper && !PARTICLES.contains(&lower.as_str()) {
            return None;
        }
    }
    let all_caps = words.iter().all(|w| {
        w.chars()
            .filter(|c| c.is_alphabetic())
            .all(char::is_uppercase)
    });
    let fix = |w: &str| -> String {
        let lower = w.to_lowercase();
        if all_caps && PARTICLES.contains(&lower.as_str()) {
            lower
        } else if all_caps {
            title_case(w)
        } else {
            w.to_owned()
        }
    };
    // The last name takes the particles right before it: "Ludwig van Beethoven".
    let mut last_start = words.len() - 1;
    while last_start > 1 && PARTICLES.contains(&words[last_start - 1].to_lowercase().as_str()) {
        last_start -= 1;
    }
    let first = title_case_if(all_caps, words[0]);
    let middle = words[1..last_start]
        .iter()
        .map(|w| fix(w))
        .collect::<Vec<_>>()
        .join(" ");
    let last = words[last_start..]
        .iter()
        .map(|w| fix(w))
        .collect::<Vec<_>>()
        .join(" ");
    Some((first, middle, last))
}

fn title_case_if(all_caps: bool, w: &str) -> String {
    if all_caps {
        title_case(w)
    } else {
        w.to_owned()
    }
}

/// "O'BRIEN" → "O'Brien", "SMITH-JONES" → "Smith-Jones".
fn title_case(w: &str) -> String {
    let mut out = String::with_capacity(w.len());
    let mut upper_next = true;
    for c in w.chars() {
        if upper_next {
            out.extend(c.to_uppercase());
        } else {
            out.extend(c.to_lowercase());
        }
        upper_next = matches!(c, '-' | '\'' | '’' | '.');
    }
    out
}

fn read_location(header: &[&str], out: &mut ParsedResume) {
    for line in header {
        let cleaned = EMAIL.replace_all(line, " ");
        let cleaned = URL.replace_all(&cleaned, " ");
        for segment in split_segments(&cleaned) {
            if segment.chars().count() > 50
                || segment
                    .chars()
                    .any(|c| c.is_ascii_digit() && segment.matches(char::is_numeric).count() > 5)
            {
                continue;
            }
            if let Some((before, city, region)) = split_location_parts(&segment) {
                if before.split_whitespace().count() > 2 {
                    continue; // a sentence that happens to end in a place
                }
                out.city = city;
                match US_STATES
                    .iter()
                    .find(|(abbr, name)| *abbr == region || name.eq_ignore_ascii_case(&region))
                {
                    Some((abbr, _)) => {
                        out.state = (*abbr).to_owned();
                        out.country = "United States".into();
                    }
                    None => out.country = normalize_country(&region),
                }
                return;
            }
        }
    }
}

fn normalize_country(region: &str) -> String {
    match region.trim_end_matches('.') {
        "USA" | "U.S.A" | "U.S" | "United States" => "United States".into(),
        "UK" => "United Kingdom".into(),
        other => other.to_owned(),
    }
}

/// "Google, Mountain View, CA" → ("Google", "Mountain View", "CA").
fn split_location_parts(text: &str) -> Option<(String, String, String)> {
    let text = text.trim().trim_end_matches(['.', ')']);
    let caps = LOCATION_TAIL
        .captures(text)
        .or_else(|| full_state_tail(text))?;
    let region = caps.get(2)?.as_str().to_owned();
    if region.len() == 2 && !US_STATES.iter().any(|(abbr, _)| *abbr == region) {
        return None;
    }
    let before = caps.get(1)?.as_str().trim();
    let words: Vec<&str> = before.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let take = city_word_count(&words);
    let city = words[words.len() - take..].join(" ");
    if !city.chars().next().is_some_and(char::is_uppercase) {
        return None;
    }
    let rest = words[..words.len() - take].join(" ");
    let rest = rest.trim_end_matches(|c: char| {
        matches!(c, ',' | '-' | '–' | '—' | '|' | '(') || c.is_whitespace()
    });
    Some((rest.to_owned(), city, region))
}

fn full_state_tail(text: &str) -> Option<regex::Captures<'_>> {
    static FULL: LazyLock<Regex> = LazyLock::new(|| {
        let names: Vec<&str> = US_STATES.iter().map(|(_, name)| *name).collect();
        re(&format!(r"^(.*?),\s*({})$", names.join("|")))
    });
    FULL.captures(text)
}

fn city_word_count(words: &[&str]) -> usize {
    let n = words.len();
    if n >= 3 && CITIES_THREE_WORDS.contains(&words[n - 3..].join(" ").as_str()) {
        return 3;
    }
    if n >= 2 && CITY_FIRST_WORDS.contains(&words[n - 2]) {
        return 2;
    }
    1
}

/// "Jun 2024", "06/2024", "2024-06" → "2024-06"; "2024" → "2024".
fn to_month(raw: &str) -> String {
    let lower = raw.to_lowercase();
    // "Expected May 2025": the qualifier comes before the month name.
    let lower = ["expected", "anticipated", "exp."]
        .iter()
        .find_map(|q| lower.strip_prefix(q))
        .map(|s| s.trim_start().to_owned())
        .unwrap_or(lower);
    let year = YEAR4
        .find(&lower)
        .map(|m| m.as_str().to_owned())
        .or_else(|| {
            lower
                .find('\'')
                .and_then(|i| lower.get(i + 1..i + 3))
                .map(|yy| format!("20{yy}"))
        });
    let Some(year) = year else {
        return String::new();
    };
    let names = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let seasons = [
        ("spring", 1),
        ("summer", 6),
        ("fall", 9),
        ("autumn", 9),
        ("winter", 1),
    ];
    let month = names
        .iter()
        .position(|m| {
            lower
                .trim_start_matches(|c: char| !c.is_alphabetic())
                .starts_with(m)
        })
        .map(|i| i + 1)
        .or_else(|| {
            seasons
                .iter()
                .find(|(s, _)| lower.starts_with(s))
                .map(|(_, m)| *m)
        })
        .or_else(|| {
            // "06/2024" or "2024-06"
            let digits: Vec<&str> = lower
                .split(|c: char| !c.is_ascii_digit())
                .filter(|d| !d.is_empty())
                .collect();
            match digits.as_slice() {
                [m, y] if y.len() == 4 => m.parse().ok(),
                [y, m] if y.len() == 4 => m.parse().ok(),
                _ => None,
            }
        })
        .filter(|m| (1..=12).contains(m));
    match month {
        Some(m) => format!("{year}-{m:02}"),
        None => year,
    }
}

struct Dates {
    start: String,
    end: String,
    current: bool,
}

/// Takes a date range out of a line: the dates, and the line without them.
fn take_range(line: &str) -> Option<(Dates, String)> {
    let caps = RANGE.captures(line)?;
    let whole = caps.get(0)?;
    let end_raw = caps[2].to_lowercase();
    let current = ["present", "current", "now", "today", "ongoing"]
        .iter()
        .any(|w| end_raw.starts_with(w));
    let end = if current {
        String::new()
    } else {
        to_month(&caps[2])
    };
    let rest = format!("{} {}", &line[..whole.start()], &line[whole.end()..]);
    Some((
        Dates {
            start: to_month(&caps[1]),
            end,
            current,
        },
        tidy_rest(&rest),
    ))
}

/// Takes one date out of a line (a graduation date): the date, and the rest.
fn take_single_date(line: &str) -> Option<(String, String)> {
    let caps = SINGLE_DATE.captures(line)?;
    let whole = caps.get(0)?;
    let rest = format!("{} {}", &line[..whole.start()], &line[whole.end()..]);
    Some((to_month(&caps[1]), tidy_rest(&rest)))
}

fn tidy_rest(s: &str) -> String {
    let s = s.replace("()", " ").replace("[]", " ");
    clean_line(s.trim_matches(|c: char| {
        matches!(c, ',' | '|' | '-' | '–' | '—' | '(' | ')') || c.is_whitespace()
    }))
}

fn is_bullet(line: &str) -> bool {
    line.chars().next().is_some_and(|c| BULLETS.contains(&c))
}

fn strip_bullet(line: &str) -> &str {
    line.trim_start_matches(|c: char| BULLETS.contains(&c) || c.is_whitespace())
}

fn parse_education(lines: &[&str]) -> Vec<Education> {
    let mut entries: Vec<Education> = Vec::new();
    let mut current: Option<Education> = None;
    for line in lines {
        if is_bullet(line) {
            continue;
        }
        let lower = line.to_lowercase();
        if lower.starts_with("relevant coursework")
            || lower.starts_with("coursework")
            || lower.starts_with("courses")
        {
            continue;
        }
        let (dates, rest) = match take_range(line) {
            Some((d, rest)) => (
                Some((d.start, if d.current { String::new() } else { d.end })),
                rest,
            ),
            None => match take_single_date(line) {
                Some((end, rest)) => (Some((String::new(), end)), rest),
                None => (None, line.to_string()),
            },
        };
        let gpa = GPA.captures(&rest).map(|c| match c.get(2) {
            Some(scale) => format!("{}/{}", &c[1], scale.as_str()),
            None => c[1].to_owned(),
        });
        let rest = GPA.replace(&rest, " ").to_string();
        let school = find_school(&rest);
        let degree = find_degree(&rest);

        let starts_new = |cur: &Option<Education>| match cur {
            None => true,
            Some(e) => {
                (school.is_some() && !e.school.is_empty())
                    || (school.is_none() && degree.is_some() && !e.degree.is_empty())
            }
        };
        if (school.is_some() || degree.is_some()) && starts_new(&current) {
            if let Some(done) = current.take() {
                entries.push(done);
            }
            current = Some(Education::default());
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        if let Some(s) = school {
            entry.school = truncate_chars(&s, 200).to_owned();
        }
        if let Some((d, field)) = degree {
            entry.degree = truncate_chars(&d, 120).to_owned();
            if !field.is_empty() {
                entry.field = truncate_chars(&field, 120).to_owned();
            }
        }
        if let Some(g) = gpa {
            entry.gpa = truncate_chars(&g, 20).to_owned();
        }
        if let Some((start, end)) = dates
            && entry.start_date.is_empty()
            && entry.end_date.is_empty()
        {
            entry.start_date = start;
            entry.end_date = end;
        }
    }
    entries.extend(current);
    // A second degree listed under the same school ("B.S. … / M.S. …").
    for i in 1..entries.len() {
        if entries[i].school.is_empty() {
            entries[i].school = entries[i - 1].school.clone();
        }
    }
    entries.retain(|e| !e.school.is_empty() || !e.degree.is_empty());
    entries.truncate(profile::MAX_EDUCATION);
    entries
}

fn find_school(text: &str) -> Option<String> {
    if let Some(m) = SCHOOL.find(text) {
        let mut name = m.as_str().trim().to_owned();
        // "University of California, Berkeley"
        if name.contains(" of ")
            && let Some(c) = CAMPUS.captures(&text[m.end()..])
        {
            let campus = &c[1];
            if !US_STATES.iter().any(|(abbr, _)| *abbr == campus) {
                name = format!("{name}, {campus}");
            }
        }
        return Some(clean_line(&name));
    }
    KNOWN_SCHOOL.find(text).map(|m| clean_line(m.as_str()))
}

/// The degree and the field of study after it.
fn find_degree(text: &str) -> Option<(String, String)> {
    let m = DEGREE_WORDS.find(text).or_else(|| {
        DEGREE_ABBR.find_iter(text).find(|m| {
            // "Boston, MA" is a state, not a Master of Arts.
            let before = text[..m.start()].trim_end();
            !before.ends_with(',')
        })
    })?;
    let degree = clean_line(m.as_str());
    let mut after = text[m.end()..].trim_start();
    // "Bachelor of Science (B.S.) in Computer Science"
    if after.starts_with('(')
        && let Some(close) = after.find(')')
    {
        after = after[close + 1..].trim_start();
    }
    let after = after.trim_start_matches(|c: char| {
        matches!(c, ',' | ':' | '-' | '–' | '—') || c.is_whitespace()
    });
    let after = after
        .strip_prefix("in ")
        .or_else(|| after.strip_prefix("In "))
        .or_else(|| after.strip_prefix("of "))
        .unwrap_or(after);
    let field = match FIELD_END.find(after) {
        Some(end) => &after[..end.start()],
        None => after,
    };
    let field = clean_line(field);
    // A school name after the degree isn't a field of study.
    let field = if SCHOOL.is_match(&field) || field.split_whitespace().count() > 8 {
        String::new()
    } else {
        field
    };
    Some((degree, field))
}

fn parse_experience(lines: &[&str]) -> Vec<Experience> {
    struct Entry {
        texts: Vec<String>,
        dates: Dates,
        bullets: Vec<String>,
    }
    let mut entries: Vec<Entry> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    for line in lines {
        if let Some((dates, rest)) = take_range(line).filter(|_| !is_bullet(line)) {
            let mut texts = std::mem::take(&mut pending);
            if !rest.is_empty() {
                texts.push(rest);
            }
            entries.push(Entry {
                texts,
                dates,
                bullets: Vec::new(),
            });
        } else if is_bullet(line) {
            pending.clear();
            if let Some(e) = entries.last_mut() {
                e.bullets.push(clean_line(strip_bullet(line)));
            }
        } else if let Some(e) = entries
            .last_mut()
            .filter(|e| e.bullets.is_empty() && e.texts.len() < 3)
        {
            // The line under a dated line: company and location (or title).
            e.texts.push(clean_line(line));
        } else if let Some(last) = entries
            .last_mut()
            .and_then(|e| e.bullets.last_mut())
            .filter(|_| line.chars().next().is_some_and(char::is_lowercase))
        {
            // A bullet that wrapped onto the next line.
            last.push(' ');
            last.push_str(&clean_line(line));
        } else {
            pending.push(clean_line(line));
            if pending.len() > 3 {
                pending.remove(0);
            }
        }
    }
    entries
        .into_iter()
        .filter_map(|e| {
            let (title, company, location) = resolve_header(&e.texts);
            if title.is_empty() && company.is_empty() {
                return None;
            }
            let description = e.bullets.join("\n");
            Some(Experience {
                company: truncate_chars(&company, 200).to_owned(),
                title: truncate_chars(&title, 200).to_owned(),
                location: truncate_chars(&location, 200).to_owned(),
                start_date: e.dates.start,
                end_date: e.dates.end,
                current: Some(e.dates.current),
                description: truncate_chars(&description, 2000).to_owned(),
            })
        })
        .take(profile::MAX_EXPERIENCE)
        .collect()
}

/// Title, company and location from an entry's header lines, whichever order
/// they come in.
fn resolve_header(texts: &[String]) -> (String, String, String) {
    let mut location = String::new();
    let mut parts: Vec<String> = Vec::new();
    for text in texts {
        for segment in split_segments(text) {
            if location.is_empty() {
                if let Some((before, city, region)) = split_location_parts(&segment) {
                    location = format!("{city}, {region}");
                    if !before.is_empty() {
                        parts.push(before);
                    }
                    continue;
                }
                if let Some(c) = REMOTE_TAIL.captures(&segment) {
                    location = title_case(&c[2].to_lowercase());
                    let before = tidy_rest(&c[1]);
                    if !before.is_empty() {
                        parts.push(before);
                    }
                    continue;
                }
            }
            parts.push(segment);
        }
    }
    let mut pieces: Vec<String> = Vec::new();
    for part in parts {
        if let Some((a, b)) = part.split_once(" at ").or_else(|| part.split_once(" @ ")) {
            pieces.push(clean_line(a));
            pieces.push(clean_line(b));
        } else if part.contains(',') {
            pieces.extend(part.split(',').map(clean_line).filter(|p| !p.is_empty()));
        } else {
            pieces.push(part);
        }
    }
    pieces.retain(|p| {
        let lower = p.to_lowercase();
        !matches!(
            lower.trim_end_matches('.'),
            "inc" | "llc" | "ltd" | "corp" | "co" | "l.l.c" | ""
        )
    });
    let title_at = pieces
        .iter()
        .position(|p| TITLE_WORD.is_match(p) && !COMPANY_HINT.is_match(p))
        .or_else(|| pieces.iter().position(|p| TITLE_WORD.is_match(p)));
    let (title, company) = match title_at {
        Some(i) => {
            let company = pieces
                .iter()
                .enumerate()
                .find(|(j, _)| *j != i)
                .map(|(_, p)| p.clone())
                .unwrap_or_default();
            (pieces[i].clone(), company)
        }
        None => match pieces.as_slice() {
            [] => (String::new(), String::new()),
            [only] => (String::new(), only.clone()),
            [a, b, ..] if COMPANY_HINT.is_match(a) => (b.clone(), a.clone()),
            [a, b, ..] => (a.clone(), b.clone()),
        },
    };
    (title, company, location)
}

fn parse_skills(lines: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for line in lines {
        let line = strip_bullet(line);
        let content = match line.split_once(':') {
            Some((label, rest)) if label.chars().count() <= 40 && !label.contains(',') => rest,
            _ => line,
        };
        for item in split_list(content) {
            let item = clean_line(item.trim_matches(|c: char| c == '.' || c.is_whitespace()));
            if item.is_empty() || item.chars().count() > 40 || item.split_whitespace().count() > 5 {
                continue;
            }
            if seen.insert(item.to_lowercase()) {
                out.push(item);
            }
        }
    }
    out.truncate(profile::MAX_SKILLS);
    out
}

/// Splits on commas, semicolons, bullets and pipes that aren't inside
/// parentheses, so "SQL (Postgres, MySQL)" stays one item.
fn split_list(s: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (i, c) in s.char_indices() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            ',' | ';' | '|' | '•' | '·' if depth == 0 => {
                items.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    items.push(&s[start..]);
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The text pdf-extract gives for the widely used "Jake's Resume" LaTeX
    /// template (synthetic person).
    const JAKE_STYLE: &str = "\
Jake Ryan
123-456-7890 | jake@su.edu | linkedin.com/in/jake | github.com/jake
Education
Southwestern University Georgetown, TX
Bachelor of Arts in Computer Science, Minor in Business Aug. 2018 – May 2021
Blinn College Bryan, TX
Associate’s in Liberal Arts Aug. 2014 – May 2018
Experience
Undergraduate Research Assistant June 2020 – Present
Texas A&M University College Station, TX
• Developed a REST API using FastAPI and PostgreSQL to store data from learning management systems
• Developed a full-stack web application using Flask, React, PostgreSQL and Docker to analyze GitHub data
Information Technology Support Specialist Sep. 2018 – Present
Southwestern University Georgetown, TX
• Communicate with managers to set up campus computers used on campus
Projects
Gitlytics | Python, Flask, React, PostgreSQL, Docker June 2020 – Present
• Developed a full-stack web application
Technical Skills
Languages: Java, Python, C/C++, SQL (Postgres), JavaScript, HTML/CSS, R
Frameworks: React, Node.js, Flask, JUnit, WordPress, Material-UI, FastAPI
Developer Tools: Git, Docker, TravisCI, Google Cloud Platform, VS Code
";

    /// A Word-style resume with a different layout (synthetic person).
    const WORD_STYLE: &str = "\
JANE MARIE DOE
San Francisco, CA • (415) 555-0100 • Jane.Doe@Example.com • janedoe.dev
EDUCATION
Stanford University — M.S. Computer Science, GPA 3.9/4.0 (Expected June 2026)
University of California, Berkeley — B.S. Electrical Engineering and Computer Sciences, 2020 – 2024
WORK EXPERIENCE
Software Engineer Intern, Google — Mountain View, CA (Jun 2025 – Sep 2025)
- Built a caching layer that cut p99 latency by 40%
- Wrote design docs and
  reviewed code
Stripe | Software Engineering Intern | May 2024 – Aug 2024
- Shipped payments features
SKILLS
Python, Go, TypeScript, Kubernetes, PostgreSQL
";

    #[test]
    fn reads_the_jake_template() {
        let r = parse_resume(JAKE_STYLE);
        assert_eq!(
            (r.first_name.as_str(), r.last_name.as_str()),
            ("Jake", "Ryan")
        );
        assert_eq!(r.emails, ["jake@su.edu"]);
        assert_eq!(
            (r.phone_country_code.as_str(), r.phone.as_str()),
            ("+1", "123-456-7890")
        );
        assert_eq!(r.linkedin, "https://www.linkedin.com/in/jake");
        assert_eq!(r.github, "https://github.com/jake");

        assert_eq!(r.education.len(), 2, "{:#?}", r.education);
        let e = &r.education[0];
        assert_eq!(e.school, "Southwestern University");
        assert_eq!(e.degree, "Bachelor of Arts");
        assert_eq!(e.field, "Computer Science");
        assert_eq!(
            (e.start_date.as_str(), e.end_date.as_str()),
            ("2018-08", "2021-05")
        );
        assert_eq!(r.education[1].school, "Blinn College");
        assert_eq!(r.education[1].degree, "Associate’s");

        assert_eq!(r.experience.len(), 2, "{:#?}", r.experience);
        let x = &r.experience[0];
        assert_eq!(x.title, "Undergraduate Research Assistant");
        assert_eq!(x.company, "Texas A&M University");
        assert_eq!(x.location, "College Station, TX");
        assert_eq!(x.start_date, "2020-06");
        assert_eq!(x.current, Some(true));
        assert!(x.description.starts_with("Developed a REST API"));
        assert_eq!(r.experience[1].company, "Southwestern University");
        assert_eq!(r.experience[1].location, "Georgetown, TX");
        assert_eq!(r.experience[1].start_date, "2018-09");

        for skill in [
            "Java",
            "C/C++",
            "SQL (Postgres)",
            "HTML/CSS",
            "Node.js",
            "Google Cloud Platform",
        ] {
            assert!(
                r.skills.iter().any(|s| s == skill),
                "missing {skill}: {:?}",
                r.skills
            );
        }
        assert!(!r.skills.iter().any(|s| s.contains("Languages")));
        assert_eq!(
            r.sections,
            ["Education", "Experience", "Projects", "Technical Skills"]
        );
    }

    #[test]
    fn reads_a_word_style_resume() {
        let r = parse_resume(WORD_STYLE);
        assert_eq!(
            (
                r.first_name.as_str(),
                r.middle_name.as_str(),
                r.last_name.as_str()
            ),
            ("Jane", "Marie", "Doe")
        );
        assert_eq!(r.emails, ["jane.doe@example.com"]);
        assert_eq!(r.phone, "415-555-0100");
        assert_eq!(r.portfolio, "https://janedoe.dev");
        assert_eq!(
            (r.city.as_str(), r.state.as_str(), r.country.as_str()),
            ("San Francisco", "CA", "United States")
        );

        assert_eq!(r.education.len(), 2, "{:#?}", r.education);
        let ms = &r.education[0];
        assert_eq!(
            (ms.school.as_str(), ms.degree.as_str(), ms.field.as_str()),
            ("Stanford University", "M.S.", "Computer Science")
        );
        assert_eq!(
            (ms.gpa.as_str(), ms.end_date.as_str()),
            ("3.9/4.0", "2026-06")
        );
        let bs = &r.education[1];
        assert_eq!(bs.school, "University of California, Berkeley");
        assert_eq!(bs.field, "Electrical Engineering and Computer Sciences");
        assert_eq!(
            (bs.start_date.as_str(), bs.end_date.as_str()),
            ("2020", "2024")
        );

        assert_eq!(r.experience.len(), 2, "{:#?}", r.experience);
        let g = &r.experience[0];
        assert_eq!(
            (g.title.as_str(), g.company.as_str(), g.location.as_str()),
            ("Software Engineer Intern", "Google", "Mountain View, CA")
        );
        assert_eq!(
            (g.start_date.as_str(), g.end_date.as_str(), g.current),
            ("2025-06", "2025-09", Some(false))
        );
        assert!(
            g.description
                .contains("Wrote design docs and reviewed code"),
            "{}",
            g.description
        );
        let s = &r.experience[1];
        assert_eq!(
            (s.title.as_str(), s.company.as_str()),
            ("Software Engineering Intern", "Stripe")
        );
        assert_eq!(
            r.skills,
            ["Python", "Go", "TypeScript", "Kubernetes", "PostgreSQL"]
        );
        assert!(r.missing.is_empty(), "{:?}", r.missing);
    }

    #[test]
    fn names() {
        let name = |s: &str| parse_name(s).map(|(f, m, l)| format!("{f}|{m}|{l}"));
        assert_eq!(
            name("Ludwig van Beethoven").as_deref(),
            Some("Ludwig||van Beethoven")
        );
        assert_eq!(
            name("MARÍA JOSÉ DE LA CRUZ").as_deref(),
            Some("María|José|de la Cruz")
        );
        assert_eq!(name("Sean O'Brien Jr.").as_deref(), Some("Sean||O'Brien"));
        assert_eq!(
            name("J. Robert Smith-Jones").as_deref(),
            Some("J.|Robert|Smith-Jones")
        );
        assert_eq!(name("Jane Doe, PhD").as_deref(), Some("Jane||Doe"));
        for not_a_name in [
            "Software Engineer",
            "Curriculum Vitae",
            "EDUCATION",
            "jane doe",
            "Jane",
            "123 Main St",
            "Senior Software Engineer at Google Inc",
        ] {
            assert_eq!(name(not_a_name), None, "{not_a_name}");
        }
    }

    #[test]
    fn international_phone_numbers_keep_their_country_code() {
        let r = parse_resume(
            "Priya Sharma\n+91 98765 43210 | priya@example.com\nEducation\nIIT Bombay\nB.Tech in Computer Science and Engineering 2021 – 2025\n",
        );
        assert_eq!(
            (r.phone_country_code.as_str(), r.phone.as_str()),
            ("+91", "98765 43210")
        );
        assert_eq!(r.education[0].school, "IIT Bombay");
        assert_eq!(r.education[0].degree, "B.Tech");
        assert_eq!(r.education[0].field, "Computer Science and Engineering");
    }

    #[test]
    fn dates() {
        assert_eq!(to_month("Aug. 2018"), "2018-08");
        assert_eq!(to_month("September 2024"), "2024-09");
        assert_eq!(to_month("06/2024"), "2024-06");
        assert_eq!(to_month("2024-06"), "2024-06");
        assert_eq!(to_month("Summer 2025"), "2025-06");
        assert_eq!(to_month("May '24"), "2024-05");
        assert_eq!(to_month("2024"), "2024");
        let (d, rest) = take_range("Data Intern Jan 2023 to Present").unwrap();
        assert_eq!(
            (d.start.as_str(), d.current, rest.as_str()),
            ("2023-01", true, "Data Intern")
        );
        let (d, _) = take_range("B.S. 2021 – Expected May 2025").unwrap();
        assert_eq!((d.start.as_str(), d.end.as_str()), ("2021", "2025-05"));
        // Prose isn't a date range.
        assert!(take_range("• improved throughput by 2x in 2023").is_none());
    }

    #[test]
    fn a_state_after_a_comma_is_not_a_degree() {
        let edu = parse_education(&[
            "Boston University Boston, MA",
            "Master of Science in Data Science 2024 – 2026",
        ]);
        assert_eq!(edu.len(), 1);
        assert_eq!(
            (edu[0].degree.as_str(), edu[0].field.as_str()),
            ("Master of Science", "Data Science")
        );
    }

    #[test]
    fn letter_spaced_and_decorated_headings() {
        assert_eq!(heading("E D U C A T I O N").map(|h| h.0), Some(Education));
        assert_eq!(
            heading("W O R K  E X P E R I E N C E").map(|h| h.0),
            Some(Experience)
        );
        assert_eq!(heading("Skills & Interests:").map(|h| h.0), Some(Skills));
        assert_eq!(heading("Skills and Interests").map(|h| h.0), Some(Skills));
        assert_eq!(heading("Languages: Java, Python"), None);
    }

    #[test]
    fn skills_keep_parenthesised_groups_together() {
        assert_eq!(
            split_list("SQL (Postgres, MySQL), Go; Rust"),
            ["SQL (Postgres, MySQL)", " Go", " Rust"]
        );
    }

    #[test]
    fn empty_and_headingless_text_does_not_panic() {
        assert_eq!(parse_resume("").first_name, "");
        let r = parse_resume("Jane Doe\njane@example.com\nSome text without any headings at all.");
        assert_eq!(r.first_name, "Jane");
        assert_eq!(r.emails, ["jane@example.com"]);
    }

    #[test]
    fn profile_patch_is_valid() {
        let p = parse_resume(WORD_STYLE).to_profile();
        assert_eq!(p.identity.first_name, "Jane");
        assert_eq!(p.contact.email, "jane.doe@example.com");
        assert_eq!(p.links.portfolio, "https://janedoe.dev");
        assert_eq!(p.education.len(), 2);
        assert_eq!(p.schema, 1);
    }
}
