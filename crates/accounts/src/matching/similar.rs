//! How much two lines talk about the same thing, by their content words:
//! lowercase, stopwords and skill names removed (skills are scored on their
//! own), crudely stemmed so "scaling" meets "scalable".

use super::skills::vocabulary;

/// A line's distinct content-word stems, sorted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Bag(Vec<String>);

impl Bag {
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

pub fn bag(text: &str) -> Bag {
    let vocab = vocabulary();
    let mut terms: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3 && !w.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_lowercase)
        .filter(|w| !STOPWORDS.contains(&w.as_str()) && !vocab.is_skill_word(w))
        .map(|w| stem(&w))
        .filter(|w| w.chars().count() >= 3)
        .collect();
    terms.sort_unstable();
    terms.dedup();
    Bag(terms)
}

/// Shared stems over the geometric mean of the sizes (cosine of the sets).
pub fn cosine(a: &Bag, b: &Bag) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut shared) = (0, 0, 0usize);
    while i < a.0.len() && j < b.0.len() {
        match a.0[i].cmp(&b.0[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                shared += 1;
                i += 1;
                j += 1;
            }
        }
    }
    shared as f32 / ((a.0.len() * b.0.len()) as f32).sqrt()
}

const SUFFIXES: &[&str] = &[
    "ations", "ation", "ments", "ment", "ities", "ity", "ings", "ing", "ions", "ion", "able",
    "ible", "ers", "ies", "er", "ed", "es", "ly", "al", "s", "e",
];

/// Strips one common suffix, then keeps at most 7 characters.
fn stem(word: &str) -> String {
    let mut w = word;
    for suffix in SUFFIXES {
        if let Some(rest) = w.strip_suffix(suffix)
            && rest.chars().count() >= 3
        {
            w = rest;
            break;
        }
    }
    w.chars().take(7).collect()
}

const STOPWORDS: &[&str] = &[
    // English
    "the", "and", "for", "are", "but", "not", "you", "your", "yours", "our", "ours", "they",
    "them", "their", "this", "that", "these", "those", "with", "without", "from", "into", "onto",
    "over", "under", "about", "above", "after", "before", "between", "through", "during", "each",
    "other", "some", "such", "than", "then", "too", "very", "can", "will", "would", "should",
    "could", "may", "might", "must", "shall", "have", "has", "had", "having", "was", "were",
    "been", "being", "who", "whom", "which", "what", "when", "where", "why", "how", "all", "any",
    "both", "few", "more", "most", "own", "same", "also", "just", "only", "well", "via", "per",
    "etc", "its", "it's", "his", "her", "she", "him", "out", "off", "again", "once", "here",
    "there", "use", "used", "uses", "using", "new", "one", "two", "three", "within", "across",
    "including", "include", "includes", "like", "least", "plus", "while", "whether", "able",
    "every", "make", "making", "way", "ways", "get", "getting", "help", "helping", "want",
    // Words every posting or resume has
    "experience", "experienced", "years", "year", "work", "working", "worked", "team", "teams",
    "strong", "ability", "skills", "skill", "knowledge", "related", "field", "degree", "bachelor",
    "bachelors", "master", "masters", "preferred", "required", "requirements", "qualifications",
    "responsibilities", "role", "job", "candidate", "candidates", "opportunity", "company",
    "minimum", "equivalent", "relevant", "excellent", "good", "great", "communication",
    "written", "verbal", "environment", "fast", "paced", "passion", "passionate", "ideal",
    "looking", "join", "part", "high", "quality", "understanding", "demonstrated", "proven",
    "familiarity", "familiar", "hands", "solid", "deep", "nice", "bonus", "engineer",
    "engineers", "engineering", "software", "developer", "developers", "development",
    "responsible", "developed", "implemented", "utilized", "created", "various", "multiple",
    "opportunities", "including", "computer", "science", "related", "technical", "technology",
    "technologies", "tools", "projects", "project", "product", "products",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_meet() {
        assert_eq!(stem("scaling"), stem("scale"));
        assert_eq!(stem("pipelines"), stem("pipeline"));
        assert_eq!(stem("distributed"), stem("distribution"));
    }

    #[test]
    fn content_words_only() {
        let b = bag("Experience building data pipelines with Python and Kafka");
        // "Python" and "Kafka" are skills; "experience" and "with" are noise.
        assert_eq!(b.0, ["build", "data", "pipelin"]);
    }

    #[test]
    fn similarity() {
        let req = bag("Design and operate low latency payment services at scale");
        let close = bag("Designed payment services handling 2M requests at low latency");
        let far = bag("Trained convolutional models for medical image segmentation");
        assert!(cosine(&req, &close) > 0.4, "{}", cosine(&req, &close));
        assert_eq!(cosine(&req, &far), 0.0);
        assert_eq!(cosine(&req, &Bag::default()), 0.0);
    }
}
