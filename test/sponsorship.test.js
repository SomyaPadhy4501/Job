'use strict';

// Regression tests for the sponsorship classifier's text rules.
//
// The costly error here is a false YES: a candidate who needs a visa applies to
// a role whose own posting says it won't sponsor. Before these cases existed,
// "not eligible for visa sponsorship" came back YES on the words "visa
// sponsorship", and "authorized to work ... with or without sponsorship" came
// back NO. Every phrasing below is from a live posting (2026-10-26) unless
// marked otherwise; the company is named so a case can be traced before it's
// changed or deleted.
//
// The company argument is '' throughout so the USCIS lookup can't answer and
// each case exercises the text alone.

const test = require('node:test');
const assert = require('node:assert');
const { classifySponsorship } = require('../src/services/classifier');

const fromText = (t) => classifySponsorship(t, '');

// ─── Refusals → NO ────────────────────────────────────────────────────────────

const REFUSALS = [
  'This position is not eligible for visa sponsorship.',
  '*This position is not eligible for employment-based sponsorship*', // ServiceNow
  'This role is not eligible for employment based sponsorship',
  'Harvard University is unable to provide visa sponsorship for this position', // Harvard
  'SmartAsset is unable to provide employment visa sponsorship for this position, now or in the future',
  'Visa sponsorship is not available for this role.',
  'Visa sponsorship is not offered for this role.',
  'Future sponsorship for work authorization not available',
  'Please note that at this time, Everlaw is not sponsoring US employment visas for this role', // Everlaw
  'Extend does not provide immigration-related sponsorship for this role', // Extend
  'The Harvard Chan School of Public Health does not provide visa sponsorship, now or in the future',
  'UJET does not sponsor employment visas for this role',
  'We are not able to sponsor work visas at this time',
  'We’re not able to sponsor visas for this role', // Spectral Labs' phrasing, typographic apostrophe
  'iSpot is not able to sponsor or take over sponsorship of an employment visa for this position',
  'We are unable to sponsor or take over sponsorship of an employment visa at this time',
  'Applicants must be authorized to work without the need for visa sponsorship by the start date of employment',
  'Candidates must be authorized to work in the US without current sponsorship',
  'Must be currently authorized to work in the USA without sponsorship or transfer',
  'Applicants must be legally authorized to work in the country in which this position is located, without the need for current or future employer-sponsored visa sponsorship',
  'Permanent U.S. work authorization is a condition of employment with onX', // onX
  'Applicants must be authorized to work for any employer in the U.S.',
  // Not from the corpus — common phrasings in the same family.
  'Candidates must not require visa sponsorship now or in the future.',
  'No visa sponsorship is available for this position.',
  'Visa sponsorship: No',
  'We will not sponsor visas for this role.',
];

test('explicit refusals classify NO', () => {
  for (const t of REFUSALS) assert.strictEqual(fromText(t), 'NO', t);
});

test('a refusal is still read through markup and entities', () => {
  // stripHtml decodes Greenhouse's entity-encoded content after stripping tags,
  // so tags come back as literal text mid-sentence.
  assert.strictEqual(fromText('<p>Visa sponsorship is <strong>not</strong> available</p>'), 'NO');
  assert.strictEqual(fromText('We can&#39;t sponsor visas for this role'), 'NO');
});

test('a refusal beats an offer elsewhere in the posting', () => {
  assert.strictEqual(
    fromText('We sponsor H-1B visas for most engineering roles. This position is not eligible for visa sponsorship.'),
    'NO'
  );
});

// ─── Offers → YES ─────────────────────────────────────────────────────────────

const OFFERS = [
  // 21 live postings pair the offer with this hedge. "For every role" qualifies
  // the offer; it isn't a refusal.
  "Visa sponsorship: We do sponsor visas. However, we aren't able to successfully sponsor visas for every role and every candidate.",
  'Additional information: We do sponsor and take over sponsorship of employment visas for this role.',
  'We sponsor visas end-to-end, and benefits include health insurance',
  'Visas: we’re happy to sponsor international candidates',
  'We offer visa sponsorship and can support relocation to the US for the right candidates',
  'Visa sponsorship and relocation assistance for international candidates',
];

test('explicit offers classify YES', () => {
  for (const t of OFFERS) assert.strictEqual(fromText(t), 'YES', t);
});

test('an explicit offer outranks a bare work-authorization line', () => {
  // Wispr: the authorization line used to win and the posting read NO.
  assert.strictEqual(
    fromText('Applicants must be authorized to work in the US. We sponsor H1B, O1, EB1, L1, STEM OPT, and more.'),
    'YES'
  );
});

// ─── Work-authorization lines ─────────────────────────────────────────────────

test('a bare "must be authorized to work" still reads NO', () => {
  for (const t of [
    'Applicants must be legally authorized to work in the U.S.',
    'Applicants must be currently authorized to work in the US on a full-time basis',
  ]) {
    assert.strictEqual(fromText(t), 'NO', t);
  }
});

test('"with or without sponsorship" is not a refusal', () => {
  assert.strictEqual(fromText('You must be authorized to work in the U.S., with or without sponsorship.'), 'UNKNOWN');
});

test('a refusal scoped to candidates abroad is not a blanket NO', () => {
  // Firecrawl. Someone already in the US may still be sponsored, so this must
  // not hide the role from them.
  assert.strictEqual(
    fromText(
      'Work authorization: open to candidates already authorized to work in the US or Canada. ' +
      "In the US, we also support H-1B transfers, but we're not able to sponsor new H-1B visas for candidates outside the US."
    ),
    'UNKNOWN'
  );
});

// ─── Neither ──────────────────────────────────────────────────────────────────

const NEUTRAL = [
  // Amazon's export-control clause: about licenses, not visas.
  'Any offer of employment may be conditioned on your authorization to receive software or technology controlled under these U.S. export laws without sponsorship for an export license.',
  // AWS: a security clearance, not a visa.
  'Upon start, the selected candidate will be sponsored for a commensurate clearance for each government agency',
  'Individuals must meet work location sponsorship requirements prior to employment',
  'The Sponsored Products and Brands team at Amazon Ads is re-imagining the advertising landscape',
  'Do you currently require, or will you require in the future, sponsorship for an employment visa?',
  "We can't guarantee sponsorship for every role, but if we make you an offer we'll make every reasonable effort",
  'We do not offer relocation, but our benefits are great',
];

test('text that names sponsorship without deciding it stays UNKNOWN', () => {
  for (const t of NEUTRAL) assert.strictEqual(fromText(t), 'UNKNOWN', t);
});

// ─── USCIS lookup aliases ─────────────────────────────────────────────────────

test('every employer alias points at a sponsor in the USCIS data', () => {
  // A wrong target fails silently — the employer just reads UNKNOWN again.
  const { EMPLOYER_ALIASES, USCIS_THRESHOLD } = require('../src/services/classifier');
  const data = require('../src/data/h1b-sponsors.json');
  for (const [alias, key] of Object.entries(EMPLOYER_ALIASES)) {
    assert.ok(data[key], `${alias} → ${key} is not in h1b-sponsors.json`);
    assert.ok(data[key].approvals_last_2fy >= USCIS_THRESHOLD, `${alias} → ${key} is under the threshold`);
  }
});

test('board names resolve through the aliases', () => {
  // The names as job boards print them, 2026-10-26 snapshot.
  for (const name of ['Capital One', 'Cisco', 'JPMorgan Chase', 'Oracle', 'Walmart', 'T-Mobile', 'HPE', 'Instana']) {
    assert.strictEqual(classifySponsorship('Software Engineer', name), 'YES', name);
  }
  // Text still wins: a stated refusal beats the employer's filing history.
  assert.strictEqual(classifySponsorship('We are unable to sponsor visas for this role.', 'Capital One'), 'NO');
});
