//! The skill vocabulary (`data/skills.txt`) and finding its skills in text.
//!
//! Matching is whole-word and ignores ASCII case, with care for names that
//! end in symbols (`C++`, `C#`) or contain them (`Node.js`, `CI/CD`). Names
//! that are also everyday words (`Go`, `Swift`, `R`) are matched with exact
//! case and only when another skill is mentioned nearby.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};

use crate::rank::FAMILIES;

/// Index of a skill in the vocabulary.
pub type SkillId = u16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    /// Skills in the same non-empty group earn partial credit for each other.
    pub group: String,
    /// Role families from [`crate::rank`] this skill points to.
    pub families: Vec<&'static str>,
}

/// A skill found in a text, as a byte range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hit {
    pub skill: SkillId,
    pub start: usize,
    pub end: usize,
}

pub struct Vocabulary {
    skills: Vec<Skill>,
    by_name: HashMap<String, SkillId>,
    /// Aliases matched ignoring ASCII case.
    loose: AhoCorasick,
    loose_ids: Vec<SkillId>,
    /// Aliases matched with exact case, which need another skill nearby.
    strict: AhoCorasick,
    strict_ids: Vec<SkillId>,
    /// Lowercase single-word aliases, so text similarity can skip them.
    words: HashSet<String>,
}

/// An ambiguous alias counts only with another skill this close (bytes).
const CONTEXT_BYTES: usize = 60;

static VOCABULARY: LazyLock<Vocabulary> =
    LazyLock::new(|| Vocabulary::parse(include_str!("../../data/skills.txt")));

/// The built-in vocabulary.
pub fn vocabulary() -> &'static Vocabulary {
    &VOCABULARY
}

impl Vocabulary {
    /// Reads the `Canonical | aliases | group | families` format. Panics on a
    /// malformed line: the file is compiled in and covered by tests.
    pub fn parse(source: &str) -> Vocabulary {
        let mut skills = Vec::new();
        let mut by_name = HashMap::new();
        let (mut loose, mut loose_ids) = (Vec::<String>::new(), Vec::new());
        let (mut strict, mut strict_ids) = (Vec::<String>::new(), Vec::new());
        let mut words = HashSet::new();
        for (n, line) in source.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<&str> = line.split('|').map(str::trim).collect();
            assert!(
                fields.len() == 4,
                "skills.txt line {}: expected 4 fields",
                n + 1
            );
            let id = SkillId::try_from(skills.len()).expect("fewer than 65536 skills");
            let name = fields[0].to_owned();
            let aliases: Vec<&str> = fields[1]
                .split(',')
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .collect();
            let families = fields[3]
                .split(',')
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .map(|f| {
                    FAMILIES
                        .iter()
                        .map(|(name, _)| *name)
                        .find(|name| *name == f)
                        .unwrap_or_else(|| panic!("skills.txt line {}: unknown family {f}", n + 1))
                })
                .collect();
            let strict_self = aliases.iter().any(|a| a.strip_prefix('=') == Some(&name));
            let mut add = |alias: &str| {
                if let Some(exact) = alias.strip_prefix('=') {
                    strict.push(exact.to_owned());
                    strict_ids.push(id);
                } else {
                    let lower = alias.to_ascii_lowercase();
                    if !lower.contains(|c: char| !c.is_ascii_alphanumeric()) {
                        words.insert(lower.clone());
                    }
                    loose.push(lower);
                    loose_ids.push(id);
                }
            };
            if !strict_self {
                add(&name);
            }
            for alias in aliases {
                add(alias);
            }
            by_name.insert(name.to_lowercase(), id);
            skills.push(Skill {
                name,
                group: fields[2].to_owned(),
                families,
            });
        }
        let build = |patterns: &[String], ignore_case: bool| {
            AhoCorasickBuilder::new()
                .ascii_case_insensitive(ignore_case)
                .match_kind(MatchKind::Standard)
                .build(patterns)
                .expect("skill patterns build")
        };
        Vocabulary {
            loose: build(&loose, true),
            strict: build(&strict, false),
            skills,
            by_name,
            loose_ids,
            strict_ids,
            words,
        }
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    pub fn skill(&self, id: SkillId) -> &Skill {
        &self.skills[usize::from(id)]
    }

    /// The skill with this canonical name, ignoring case.
    pub fn lookup(&self, name: &str) -> Option<SkillId> {
        self.by_name.get(&name.to_lowercase()).copied()
    }

    /// Whether `word` (lowercase) is a one-word skill alias.
    pub fn is_skill_word(&self, word: &str) -> bool {
        self.words.contains(word)
    }

    /// Skills that share a group with `id` (not `id` itself).
    pub fn siblings(&self, id: SkillId) -> impl Iterator<Item = SkillId> + '_ {
        let group = &self.skill(id).group;
        self.skills
            .iter()
            .enumerate()
            .filter(move |(i, s)| !group.is_empty() && s.group == *group && *i != usize::from(id))
            .map(|(i, _)| i as SkillId)
    }

    /// Every skill mention in `text`, left to right, without overlaps (the
    /// longer match wins, so `C++` beats `C` and `React Native` beats `React`).
    pub fn find(&self, text: &str) -> Vec<Hit> {
        let mut found: Vec<(Hit, bool)> = Vec::new();
        for m in self.loose.find_overlapping_iter(text) {
            if bounded(text, m.start(), m.end(), false) {
                let skill = self.loose_ids[m.pattern().as_usize()];
                found.push((hit(skill, m.start(), m.end()), false));
            }
        }
        for m in self.strict.find_overlapping_iter(text) {
            if bounded(text, m.start(), m.end(), true) {
                let skill = self.strict_ids[m.pattern().as_usize()];
                found.push((hit(skill, m.start(), m.end()), true));
            }
        }
        // Longest first, then leftmost; keep what doesn't overlap a kept one.
        found.sort_by_key(|(h, _)| (std::cmp::Reverse(h.end - h.start), h.start));
        let mut kept: Vec<(Hit, bool)> = Vec::new();
        for (h, ambiguous) in found {
            if kept
                .iter()
                .all(|(k, _)| h.end <= k.start || h.start >= k.end)
            {
                kept.push((h, ambiguous));
            }
        }
        let sure: Vec<Hit> = kept.iter().filter(|(_, a)| !a).map(|(h, _)| *h).collect();
        let mut out: Vec<Hit> = kept
            .into_iter()
            .filter(|(h, ambiguous)| {
                !ambiguous
                    || sure.iter().any(|s| {
                        s.skill != h.skill
                            && s.start < h.end + CONTEXT_BYTES
                            && h.start < s.end + CONTEXT_BYTES
                    })
            })
            .map(|(h, _)| h)
            .collect();
        out.sort_by_key(|h| h.start);
        out
    }

    /// The distinct skills mentioned in `text`.
    pub fn skills_in(&self, text: &str) -> Vec<SkillId> {
        let mut ids: Vec<SkillId> = self.find(text).into_iter().map(|h| h.skill).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }
}

fn hit(skill: SkillId, start: usize, end: usize) -> Hit {
    Hit { skill, start, end }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether the match `text[start..end]` stands on its own: not part of a
/// longer word, an email, `C++` inside `C+++`, or (for short exact-case names)
/// `R&D`, `C-suite`, `Series C's`.
fn bounded(text: &str, start: usize, end: usize, strict: bool) -> bool {
    let alias = &text[start..end];
    let (Some(first), Some(last)) = (alias.chars().next(), alias.chars().next_back()) else {
        return false;
    };
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    if let Some(b) = before {
        if (is_word(first) && is_word(b)) || b == '@' || (is_word(first) && b == '.') {
            return false;
        }
    }
    if let Some(a) = after {
        if is_word(last) && is_word(a) {
            return false;
        }
        if matches!(last, '+' | '#') && (is_word(a) || matches!(a, '+' | '#')) {
            return false;
        }
        if a == '@' {
            return false;
        }
        // "Node.js" is one name: a word continuing after a dot is not ours.
        if a == '.' && text[end + 1..].chars().next().is_some_and(is_word) {
            return false;
        }
    }
    if strict && alias.chars().count() <= 2 {
        let joined = |c: Option<char>| c.is_some_and(|c| matches!(c, '-' | '&' | '\'' | '’'));
        if joined(before) || joined(after) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(text: &str) -> Vec<String> {
        let v = vocabulary();
        v.find(text)
            .into_iter()
            .map(|h| v.skill(h.skill).name.clone())
            .collect()
    }

    #[test]
    fn the_vocabulary_loads_and_names_are_unique() {
        let v = vocabulary();
        assert!(v.len() > 200);
        assert_eq!(v.by_name.len(), v.len(), "duplicate canonical names");
        for s in &v.skills {
            if !s.group.is_empty() {
                assert!(
                    v.skills.iter().filter(|o| o.group == s.group).count() > 1,
                    "group {} has one skill ({}); leave it empty",
                    s.group,
                    s.name
                );
            }
        }
    }

    #[test]
    fn aliases_map_to_canonical_names() {
        assert_eq!(
            names("Built services in golang on k8s with Postgres and pyspark"),
            ["Go", "Kubernetes", "PostgreSQL", "Apache Spark"]
        );
    }

    #[test]
    fn symbols_in_names() {
        assert_eq!(names("C++, C# and .NET"), ["C++", "C#", ".NET"]);
        assert_eq!(names("Node.js and CI/CD"), ["Node.js", "CI/CD"]);
        assert_eq!(names("C/C++ firmware"), ["C", "C++", "Firmware"]);
    }

    #[test]
    fn whole_words_only() {
        assert!(names("HTML email templates").contains(&"HTML".to_owned()));
        assert!(!names("HTML email templates").contains(&"Machine learning".to_owned()));
        assert!(names("javascripts gorgeous ruby-red").iter().all(|n| n != "Go"));
        assert!(names("mail me at java@example.com").is_empty());
        assert_eq!(names("JavaScript"), ["JavaScript"]);
    }

    #[test]
    fn everyday_words_need_context() {
        // Plain English: no skill.
        assert!(names("Go above and beyond for customers").is_empty());
        assert!(names("We're a Series C company").is_empty());
        assert!(names("Our R&D team").is_empty());
        // A list of languages: yes.
        assert_eq!(names("Go, Python or Java"), ["Go", "Python", "Java"]);
        assert_eq!(names("Swift and Kotlin"), ["Swift", "Kotlin"]);
        // Exact case only.
        assert!(names("a swift response, using Python").iter().all(|n| n != "Swift"));
    }

    #[test]
    fn longer_names_win() {
        assert_eq!(names("React Native apps"), ["React Native"]);
        assert_eq!(names("Ruby on Rails"), ["Ruby on Rails"]);
        assert_eq!(names("machine learning"), ["Machine learning"]);
    }

    #[test]
    fn siblings_share_a_group() {
        let v = vocabulary();
        let aws = v.lookup("AWS").unwrap();
        let sib: Vec<&str> = v.siblings(aws).map(|s| v.skill(s).name.as_str()).collect();
        assert!(sib.contains(&"Google Cloud") && sib.contains(&"Microsoft Azure"));
        assert_eq!(v.siblings(v.lookup("Python").unwrap()).count(), 0);
    }
}
