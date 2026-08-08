'use strict';

// Regression tests for years-of-experience extraction.
//
// The "must NOT extract" cases are all real postings that a naive
// /(\d+)\s*years?/ matched. Each one would silently mislabel a job's level, so
// check the company named in the comment before removing any of them.

const test = require('node:test');
const assert = require('node:assert');
const { extractExperience, levelFromYears } = require('../src/services/experience');

const min = (text) => {
  const y = extractExperience(text);
  return y ? y.min : null;
};

// ─── Must extract ─────────────────────────────────────────────────────────────

test('extracts the stated minimum from requirement phrasings', () => {
  assert.strictEqual(min('3+ years of professional android development experience'), 3);
  assert.strictEqual(min('minimum requirements 2+ years of experience working with java'), 2);
  assert.strictEqual(min('at least 1 year of experience securing macos'), 1);
  assert.strictEqual(min('required qualifications 15+ years of experience as a machining expert'), 15);
  // No cue word nearby — "N years of X" is itself requirement-shaped.
  assert.strictEqual(min('bachelor degree or equivalent - 3+ years of software development'), 3);
});

test('takes the low end of a range', () => {
  assert.strictEqual(min('2-6 years of experience in android development'), 2);
  assert.strictEqual(min('minimum 0-1 years of experience with phd, or 3+ years industry'), 0);
  // An en-dash entity must survive as a range. The generic entity strip used to
  // turn "8&ndash;10 years" into "8 10 years", which read as two separate
  // numbers and took the wrong end (Capgemini).
  assert.strictEqual(min('with 8&ndash;10 years of experience in infrastructure'), 8);
});

test('takes the lowest requirement when several are listed', () => {
  // Deliberate: the lowest bar is what gets you considered, and erring low
  // shows a stretch role rather than hiding a reachable one.
  assert.strictEqual(
    min('3+ years of experience in security engineering. at least 1 year of experience securing macos'),
    1,
  );
});

// ─── Must NOT extract ─────────────────────────────────────────────────────────

test('ignores numbers that are not the candidate experience', () => {
  // Amazon — an age floor, in an otherwise requirements-shaped sentence.
  assert.strictEqual(min('are 18 years of age or older - enrolled in a bachelor degree'), null);
  // Chainguard — stock option exercise window.
  assert.strictEqual(
    min('you can participate in secondary offerings and have 10 years to exercise your options'),
    null,
  );
  // Company-history prose, not a requirement.
  assert.strictEqual(min('named to fortune best workplaces for 7+ years'), null);
  assert.strictEqual(min('for 8 years, scale has been the leading ai data foundry'), null);
  assert.strictEqual(min('we have been pioneering for more than 25 years, we build'), null);
  // Degree duration bound directly to the degree noun.
  assert.strictEqual(min('a 4 year degree in computer science'), null);
});

test('returns null rather than throwing on unusable input', () => {
  for (const input of ['', null, undefined, 42, {}]) {
    assert.strictEqual(extractExperience(input), null);
  }
});

// ─── Level mapping ────────────────────────────────────────────────────────────

test('maps years to level flags', () => {
  assert.deepStrictEqual(levelFromYears({ min: 0 }), { is_entry_level: 1, is_mid_level: 0 });
  assert.deepStrictEqual(levelFromYears({ min: 1 }), { is_entry_level: 1, is_mid_level: 0 });
  assert.deepStrictEqual(levelFromYears({ min: 2 }), { is_entry_level: 0, is_mid_level: 1 });
  assert.deepStrictEqual(levelFromYears({ min: 3 }), { is_entry_level: 0, is_mid_level: 1 });
  assert.deepStrictEqual(levelFromYears({ min: 4 }), { is_entry_level: 0, is_mid_level: 0 });
});

test('returns null for unknown years so callers fall back to title heuristics', () => {
  assert.strictEqual(levelFromYears(null), null);
  assert.strictEqual(levelFromYears({}), null);
});
