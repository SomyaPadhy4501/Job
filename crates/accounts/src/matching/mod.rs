//! Scoring each of a user's resumes against one job posting, with no AI
//! service: skills (with aliases, related skills, where the posting asks for
//! them and how rare they are), how strongly each resume shows them, role
//! family, focus, and how much the resume's lines talk about what the
//! posting's requirements do.
//!
//! - [`skills`]: the vocabulary and finding skills in text.
//! - [`job`]: a posting's sections, weighted skills and requirement lines.
//! - [`resume`]: a resume's skill evidence, lines, families and years.
//! - [`similar`]: word-overlap similarity between two lines.
//! - [`score`]: the four parts, the 0–100 score, reasons and the pick.

pub mod job;
pub mod resume;
pub mod score;
pub mod similar;
pub mod skills;

pub use job::{JobInput, JobProfile, Section};
pub use resume::{Month, Place, ResumeInput, ResumeProfile};
pub use score::{
    Candidate, Confidence, Corpus, Label, MatchResult, Pick, ResumeScore, Weights, score,
};

/// Weights per role family (the names in [`crate::rank`]). The generic "swe"
/// family counts less, since nearly every posting and resume has it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Families(Vec<(&'static str, f32)>);

const GENERIC_FAMILY: &str = "swe";
const GENERIC_SHARE: f32 = 0.3;

impl Families {
    pub fn add(&mut self, family: &'static str, weight: f32) {
        if weight <= 0.0 {
            return;
        }
        let weight = if family == GENERIC_FAMILY {
            weight * GENERIC_SHARE
        } else {
            weight
        };
        match self.0.iter_mut().find(|(f, _)| *f == family) {
            Some((_, w)) => *w += weight,
            None => self.0.push((family, weight)),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn norm(&self) -> f32 {
        self.0.iter().map(|(_, w)| w * w).sum::<f32>().sqrt()
    }

    /// Cosine similarity, 0 when either side is empty.
    pub fn cosine(&self, other: &Families) -> f32 {
        let (a, b) = (self.norm(), other.norm());
        if a == 0.0 || b == 0.0 {
            return 0.0;
        }
        let dot: f32 = self
            .0
            .iter()
            .filter_map(|(f, w)| other.0.iter().find(|(g, _)| g == f).map(|(_, v)| w * v))
            .sum();
        (dot / (a * b)).clamp(0.0, 1.0)
    }

    /// The families holding at least `min_share` of the weight, strongest
    /// first, at most `n`. "swe" is left out when anything else qualifies.
    pub fn top(&self, n: usize, min_share: f32) -> Vec<&'static str> {
        let total: f32 = self.0.iter().map(|(_, w)| w).sum();
        if total == 0.0 {
            return Vec::new();
        }
        let mut sorted = self.0.clone();
        sorted.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(b.0)));
        let specific: Vec<&'static str> = sorted
            .iter()
            .filter(|(f, w)| *f != GENERIC_FAMILY && w / total >= min_share)
            .map(|(f, _)| *f)
            .take(n)
            .collect();
        if specific.is_empty() {
            sorted
                .iter()
                .filter(|(f, _)| *f == GENERIC_FAMILY)
                .map(|(f, _)| *f)
                .collect()
        } else {
            specific
        }
    }
}

/// Families for a `role_type` from the job board's classifier.
fn role_type_families(role_type: &str) -> &'static [(&'static str, f32)] {
    match role_type {
        "MLE" | "AI" => &[("ai", 1.0)],
        "DS" => &[("data", 1.0), ("ai", 0.5)],
        "DATA_ENG" => &[("data", 1.0)],
        "SECURITY" => &[("security", 1.0)],
        "MOBILE" => &[("mobile", 1.0)],
        "SRE" => &[("platform", 1.0)],
        "SWE" => &[("swe", 1.0)],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_cosine_and_top() {
        let mut a = Families::default();
        a.add("backend", 2.0);
        a.add("swe", 2.0);
        let mut b = Families::default();
        b.add("backend", 1.0);
        assert!(a.cosine(&b) > 0.9);
        let mut c = Families::default();
        c.add("ai", 1.0);
        assert_eq!(a.cosine(&c), 0.0);
        assert_eq!(a.top(2, 0.25), ["backend"]);
        let mut only_swe = Families::default();
        only_swe.add("swe", 1.0);
        assert_eq!(only_swe.top(2, 0.25), ["swe"]);
        assert!(Families::default().top(2, 0.25).is_empty());
    }
}
