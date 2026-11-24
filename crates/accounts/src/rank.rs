//! Picking the resume that fits a job: each resume's title and tags are
//! matched against the job title through role families, so the tag "AI
//! Engineer" matches a "Machine Learning Engineer, LLM" job and "Platform"
//! matches "Site Reliability Engineer".

use uuid::Uuid;

/// Role families. A term matches whole words, so "ml" doesn't match "html".
pub(crate) const FAMILIES: &[(&str, &[&str])] = &[
    (
        "ai",
        &[
            "ai",
            "ml",
            "machine learning",
            "llm",
            "genai",
            "generative ai",
            "deep learning",
            "nlp",
            "computer vision",
            "applied scientist",
            "research scientist",
            "research engineer",
            "ai engineer",
            "ml engineer",
            "mlops",
        ],
    ),
    (
        "data",
        &[
            "data",
            "data engineer",
            "data engineering",
            "analytics",
            "analytics engineer",
            "etl",
            "data scientist",
            "data science",
            "data analyst",
            "business intelligence",
            "bi",
        ],
    ),
    (
        "platform",
        &[
            "platform",
            "infrastructure",
            "infra",
            "cloud",
            "devops",
            "sre",
            "site reliability",
            "reliability",
            "kubernetes",
            "production engineer",
            "systems engineer",
            "distributed systems",
        ],
    ),
    (
        "backend",
        &[
            "backend",
            "back end",
            "server",
            "api",
            "distributed systems",
            "services",
        ],
    ),
    (
        "frontend",
        &[
            "frontend",
            "front end",
            "ui",
            "web",
            "react",
            "javascript",
            "typescript",
        ],
    ),
    ("fullstack", &["full stack", "fullstack"]),
    (
        "mobile",
        &[
            "mobile",
            "ios",
            "android",
            "swift",
            "kotlin",
            "react native",
            "flutter",
        ],
    ),
    (
        "security",
        &[
            "security",
            "appsec",
            "infosec",
            "cybersecurity",
            "cyber",
            "offensive security",
            "detection",
        ],
    ),
    (
        "embedded",
        &[
            "embedded",
            "firmware",
            "hardware",
            "fpga",
            "robotics",
            "systems software",
        ],
    ),
    (
        "qa",
        &["qa", "sdet", "test", "quality", "automation engineer"],
    ),
    (
        "swe",
        &[
            "swe",
            "sde",
            "software engineer",
            "software engineering",
            "software developer",
            "developer",
            "programmer",
            "engineer",
            "new grad",
            "generalist",
        ],
    ),
];

/// Resume-title words too common to say which job a resume is for.
const TITLE_STOPWORDS: &[&str] = &[
    "resume",
    "cv",
    "the",
    "and",
    "for",
    "engineer",
    "software",
    "developer",
    "new",
    "grad",
];

pub struct Candidate<'a> {
    pub id: Uuid,
    pub title: &'a str,
    pub tags: &'a [String],
    pub is_default: bool,
}

/// Lowercase words separated by single spaces, padded with spaces, so a term
/// matches with `contains(" term ")`.
fn padded(s: &str) -> String {
    let words: Vec<String> = s
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect();
    format!(" {} ", words.join(" "))
}

pub(crate) fn families(text: &str) -> Vec<&'static str> {
    let text = padded(text);
    FAMILIES
        .iter()
        .filter(|(_, terms)| terms.iter().any(|t| text.contains(&format!(" {t} "))))
        .map(|(name, _)| *name)
        .collect()
}

/// Scores and orders resumes for a job title, best first. Ties keep the
/// default resume first, then the input order.
pub fn rank(job_title: &str, candidates: &[Candidate<'_>]) -> Vec<(Uuid, u32)> {
    let job = families(job_title);
    let job_words = padded(job_title);
    let mut scored: Vec<(usize, Uuid, u32)> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mut text = c.title.to_owned();
            for tag in c.tags {
                text.push(' ');
                text.push_str(tag);
            }
            let theirs = families(&text);
            // A specific family (AI, Platform…) counts more than the generic SWE one.
            let mut score: u32 = job
                .iter()
                .filter(|f| theirs.contains(f))
                .map(|f| if *f == "swe" { 3 } else { 10 })
                .sum();
            for tag in c.tags {
                let tag = padded(tag);
                if tag.trim().len() > 1 && job_words.contains(tag.as_str()) {
                    score += 5;
                }
            }
            // Resumes are named now ("Backend SWE"), not tagged: title words found
            // in the job title break ties between resumes of the same family.
            let title = padded(c.title);
            let mut seen: Vec<&str> = Vec::new();
            for word in title.split_whitespace() {
                if word.chars().count() < 3
                    || TITLE_STOPWORDS.contains(&word)
                    || seen.contains(&word)
                {
                    continue;
                }
                seen.push(word);
                if job_words.contains(&format!(" {word} ")) {
                    score += 5;
                }
            }
            if c.is_default {
                score += 1;
            }
            (i, c.id, score)
        })
        .collect();
    scored.sort_by(|a, b| b.2.cmp(&a.2).then(a.0.cmp(&b.0)));
    scored
        .into_iter()
        .map(|(_, id, score)| (id, score))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn matches_role_families() {
        let ai = tags(&["AI Engineer"]);
        let platform = tags(&["Platform", "SRE/DevOps"]);
        let swe = tags(&["SWE"]);
        let ids: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
        let cands = [
            Candidate {
                id: ids[0],
                title: "General",
                tags: &swe,
                is_default: true,
            },
            Candidate {
                id: ids[1],
                title: "ML resume",
                tags: &ai,
                is_default: false,
            },
            Candidate {
                id: ids[2],
                title: "Infra",
                tags: &platform,
                is_default: false,
            },
        ];
        assert_eq!(
            rank("Machine Learning Engineer, LLM Inference", &cands)[0].0,
            ids[1]
        );
        assert_eq!(rank("Site Reliability Engineer II", &cands)[0].0, ids[2]);
        assert_eq!(rank("Software Engineer, New Grad", &cands)[0].0, ids[0]);
        // Nothing specific: the default wins.
        assert_eq!(rank("Product Designer", &cands)[0].0, ids[0]);
    }

    #[test]
    fn resume_title_words_break_ties() {
        fn named(id: Uuid, title: &str) -> Candidate<'_> {
            Candidate {
                id,
                title,
                tags: &[],
                is_default: false,
            }
        }
        let ids: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
        let job = "Backend Engineer, Payments";
        let cands = [named(ids[0], "Frontend SWE"), named(ids[1], "Backend SWE")];
        assert_eq!(rank(job, &cands)[0].0, ids[1]);
        // Same family: the title word "Payments" decides.
        let cands = [
            named(ids[1], "Backend SWE"),
            named(ids[2], "Payments Backend SWE"),
        ];
        assert_eq!(rank(job, &cands)[0].0, ids[2]);
        // A tie still goes to the default resume.
        let cands = [
            named(ids[0], "Backend SWE"),
            Candidate {
                is_default: true,
                ..named(ids[1], "Backend SWE")
            },
        ];
        assert_eq!(rank(job, &cands)[0].0, ids[1]);
    }

    #[test]
    fn terms_match_whole_words() {
        assert!(!families("HTML email developer").contains(&"ai"));
        assert!(families("Applied ML Scientist").contains(&"ai"));
        assert!(families("Full-Stack Engineer").contains(&"fullstack"));
    }
}
