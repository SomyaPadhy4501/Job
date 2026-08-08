'use strict';

// Years-of-experience extractor.
//
// Job titles are a poor level signal on their own — 1,229 of 1,731 rows in this
// corpus carry neither an entry nor a mid flag, because most titles say only
// "Software Engineer". Descriptions are far better: 35.5% state an explicit
// number. This module pulls that number out so the level flags reflect what the
// posting actually asks for.
//
// Returns { min, max } in years, or null when the text states nothing usable.
// `min` is what callers should key on — it's the bar you must clear.
//
// No LLM / no API — pure regex over the normalized description.

const { normalizeForMatch } = require('./clearance');

// Company-history and tenure boilerplate, which is the dominant false positive:
//   "named to Fortune's best workplaces for 7+ years"
//   "for 8 years, Scale has been the leading AI data foundry"
//   "for more than 25 years, we've been pioneering..."
// These read as "N years" but describe the employer, not the candidate. Matched
// against the text immediately BEFORE the number.
const NARRATIVE_BEFORE =
  /(?:\bfor\b|more than|over the (?:past|last)|in the (?:past|last)|history of|founded|celebrating|been (?:named|recognized))\s*$/i;

// Degree durations — "a 4 year degree", "4-year program". Distinct from
// "Bachelor's degree + 3 years of experience", which is a real requirement, so
// this only fires when the number is directly bound to the degree noun.
const DEGREE_BOUND = /\b\d{1,2}[\s-]*year\b[\s-]*(?:degree|program|diploma|course)/i;

// "N years" that measures something other than the candidate's experience.
// Checked against the text starting AT the number:
//   "are 18 years of age or older"                  — Amazon, an age floor
//   "you have 10 years to exercise your options"    — Chainguard, an option window
// Both otherwise land in a requirements-shaped sentence and would be counted.
const NOT_EXPERIENCE_AFTER =
  /^\d{1,2}\s*\+?\s*(?:-|–|—|to)?\s*\d{0,2}\s*years?\s+(?:of age\b|to exercise|to vest|of vesting|of warranty|of service\b)/i;

// Ranges first — "2-4 years", "2 to 4 years". Captures both ends.
const RANGE = /\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*years?\b/gi;

// Single values — "3+ years", "minimum of 5 years", "at least 2 years".
const SINGLE = /\b(\d{1,2})\s*\+?\s*years?\b/gi;

// A match only counts as a requirement if the surrounding window looks like a
// qualifications statement rather than prose. Deliberately broad: many postings
// write "4+ years as a software engineer" with no literal "experience" nearby.
const REQUIREMENT_CONTEXT =
  /experience|exp\.|background|minimum|at least|require|qualification|proven|track record|working|professional|industry|hands[\s-]?on|building|developing|as an?\b|\bin\b/i;

// "N years of/as/in <something>" is itself requirement-shaped, even when no
// other cue word is nearby — "3+ years of software development" carries no
// word from REQUIREMENT_CONTEXT but is plainly a requirement. Checked on the
// text starting at the number, and only after the exclusions above have run,
// so "18 years of age" and "10 years to exercise" are already gone.
const YEARS_OF_SHAPE =
  /^\d{1,2}\s*\+?\s*(?:-|–|—|to)?\s*\d{0,2}\s*years?\s+(?:of|as|in|with|working|building|shipping|developing|leading|designing|professional|relevant|industry|hands)/i;

const MAX_REASONABLE_YEARS = 25; // guards against "25 years, we've been pioneering"

function isNarrative(before) {
  return NARRATIVE_BEFORE.test(before.slice(-28));
}

function collect(text, regex, handler) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index, m.index + 70);
    if (isNarrative(before)) continue;
    if (DEGREE_BOUND.test(after)) continue;
    if (NOT_EXPERIENCE_AFTER.test(after)) continue;
    if (!YEARS_OF_SHAPE.test(after) && !REQUIREMENT_CONTEXT.test(before + after)) continue;
    handler(m);
  }
}

function extractExperience(text) {
  if (!text || typeof text !== 'string') return null;
  const t = normalizeForMatch(text);
  if (!t) return null;

  const mins = [];
  const maxes = [];

  // Ranges are unambiguous, so take them first and let them define both ends.
  collect(t, RANGE, (m) => {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (lo > MAX_REASONABLE_YEARS || hi > MAX_REASONABLE_YEARS) return;
    if (hi < lo) return;
    mins.push(lo);
    maxes.push(hi);
  });

  collect(t, SINGLE, (m) => {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n > MAX_REASONABLE_YEARS) return;
    mins.push(n);
  });

  if (!mins.length) return null;

  // Take the LOWEST stated requirement. Postings routinely list several
  // ("3+ years backend, 5+ years distributed systems"); the lowest is the bar
  // for being considered at all. Erring low also matches the priority here —
  // wrongly hiding a reachable job costs more than showing a stretch one.
  const min = Math.min(...mins);
  const max = maxes.length ? Math.max(...maxes) : null;
  return { min, max: max != null && max >= min ? max : null };
}

// Map extracted years to the board's two level flags.
//   0-1 years  → entry   (new grad / early career)
//   2-3 years  → mid     (matches the existing "mid · 1-2y" bucket's intent)
//   4+ years   → neither (too senior for this board's audience)
// Returns { is_entry_level, is_mid_level } or null when years are unknown, so
// callers can fall back to the title heuristics.
function levelFromYears(years) {
  if (!years || typeof years.min !== 'number') return null;
  if (years.min <= 1) return { is_entry_level: 1, is_mid_level: 0 };
  if (years.min <= 3) return { is_entry_level: 0, is_mid_level: 1 };
  return { is_entry_level: 0, is_mid_level: 0 };
}

module.exports = { extractExperience, levelFromYears };
