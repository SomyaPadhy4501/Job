'use strict';

// Regression tests for the US-location heuristic.
//
// This function decides whether a row is collected at all, so both directions
// matter: a false negative silently drops a US job, a false positive pollutes
// the board with roles that can't be applied to from the US.

const test = require('node:test');
const assert = require('node:assert');
const { looksUS } = require('../src/services/normalize');

test('accepts plain US locations', () => {
  for (const loc of ['New York, NY', 'Austin, TX', 'San Francisco, CA, USA', 'Boston, Massachusetts']) {
    assert.strictEqual(looksUS(loc), true, loc);
  }
});

test('accepts multi-country labels that always include the US', () => {
  // These used to fall through every branch and return false.
  for (const loc of ['North America', 'Americas', 'USCA']) {
    assert.strictEqual(looksUS(loc), true, loc);
  }
});

test('a named US city outranks a foreign marker in the same string', () => {
  // Stripe and Databricks post multi-city roles. Checking foreign markers first
  // rejected these outright on the word "Toronto" / "Europe", dropping genuine
  // US openings.
  assert.strictEqual(looksUS('Toronto, New York, San Francisco'), true);
  assert.strictEqual(looksUS('San Francisco or Remote (North America, Europe)'), true);
  assert.strictEqual(looksUS('Dallas, Texas; San Francisco, California; Vancouver, Canada'), true);
});

test('still rejects genuinely foreign locations', () => {
  for (const loc of [
    'London, United Kingdom',
    'Bengaluru',
    'Remote - Canada',
    'Toronto, Ontario',
    'Remote, United Arab Emirates',
  ]) {
    assert.strictEqual(looksUS(loc), false, loc);
  }
});

test('rejects Vancouver BC without the two-letter state token rescuing it', () => {
  // The ambiguous "ca" token matches both California and Canada, which is why
  // the two-letter check must stay BELOW the foreign-marker check even though
  // the city check moved above it.
  assert.strictEqual(looksUS('Vancouver, BC, CA'), false);
});

test('accepts US facility names that carry no state abbreviation', () => {
  // Enterprise Workday boards name buildings, not cities. 88 USAA postings were
  // dropped on "San Antonio Home Office" alone before these cities were added.
  for (const loc of [
    'San Antonio Home Office I',
    'Tampa Campus',
    'Plano Legacy',
    'Phoenix Campus (Main)',
    'SMYRNA PACES SUMMIT - 9125',
    'JOLIET RDC - 5851',
  ]) {
    assert.strictEqual(looksUS(loc), true, loc);
  }
});

test('rejects foreign locations that use an ISO alpha-3 country code', () => {
  // "Barcelona, ESP" / "Kraków, POL" appear in Workday feeds and match no
  // foreign-marker word.
  for (const loc of ['Barcelona, ESP', 'Kraków, POL', 'Amman, JOR', 'Barcelona ESP', 'Dublin, IRL']) {
    assert.strictEqual(looksUS(loc), false, loc);
  }
});

test('an ISO-3 country code outranks a US city name that also exists abroad', () => {
  // Cambridge and Birmingham are in the US city list AND in the UK. The ISO
  // check must run before the city check or these pass as US.
  assert.strictEqual(looksUS('Cambridge, GBR'), false);
  assert.strictEqual(looksUS('Birmingham, GBR'), false);
  // ...while the US ones still resolve.
  assert.strictEqual(looksUS('Cambridge, MA'), true);
});

test('treats a missing location as unknown rather than foreign', () => {
  assert.strictEqual(looksUS(''), true);
  assert.strictEqual(looksUS(null), true);
  assert.strictEqual(looksUS(undefined), true);
});

test('bare remote is assumed US on a US-focused board', () => {
  assert.strictEqual(looksUS('Remote'), true);
  // ...but not when a foreign marker is present.
  assert.strictEqual(looksUS('Remote - United Kingdom'), false);
});

// ─── Apply-link dedupe ────────────────────────────────────────────────────────

const { stripTracking, canonicalUrl } = require('../src/services/normalize');
const { dedupeBatch } = require('../src/services/dedupe');

test('stripTracking drops tracking params but keeps ones that identify the job', () => {
  assert.strictEqual(
    stripTracking('https://careers.roblox.com/jobs/8259453?gh_jid=8259453&utm_source=simplify&gh_src=x'),
    'https://careers.roblox.com/jobs/8259453?gh_jid=8259453',
  );
});

test('canonicalUrl ignores scheme, www, trailing slash, tracking and param order', () => {
  assert.strictEqual(
    canonicalUrl('http://WWW.amazon.jobs/en/jobs/1/ds/?utm_source=x&b=2&a=1'),
    canonicalUrl('https://amazon.jobs/en/jobs/1/ds?a=1&b=2'),
  );
  assert.notStrictEqual(canonicalUrl('https://x.com/job?jobId=1'), canonicalUrl('https://x.com/job?jobId=2'));
});

test('dedupeBatch keeps the direct, described copy of a job seen twice', () => {
  const rows = [
    { source: 'ghlistings', company_name: 'Amazon', job_title: 'Data Scientist 1', location: 'Seattle', apply_url: 'https://www.amazon.jobs/en/jobs/1/ds?utm_source=Simplify', description: '' },
    { source: 'amazon', company_name: 'Amazon', job_title: 'Data Scientist I', location: 'Seattle, WA', apply_url: 'https://amazon.jobs/en/jobs/1/ds', description: 'Build models.' },
    { source: 'amazon', company_name: 'Amazon', job_title: 'SDE I', location: 'Seattle, WA', apply_url: 'https://amazon.jobs/en/jobs/2/sde', description: 'x' },
  ];
  assert.deepStrictEqual(dedupeBatch(rows).map((r) => r.job_title), ['Data Scientist I', 'SDE I']);
});

test('domain words do not reject a title whose head is an engineering role', () => {
  const { classifyRole } = require('../src/services/normalize');
  assert.strictEqual(classifyRole('Data Scientist (Marketing preferred)'), 'DS');
  assert.strictEqual(classifyRole('Data Scientist - Marketing'), 'DS');
  assert.strictEqual(classifyRole('Software Engineer, Finance Platform'), 'SWE');
  assert.strictEqual(classifyRole('Product Manager, Machine Learning'), 'OTHER');
  assert.strictEqual(classifyRole('Marketing Manager'), 'OTHER');
});
