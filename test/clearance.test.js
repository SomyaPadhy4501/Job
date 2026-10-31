'use strict';

// Regression tests for the work-authorization restriction classifier.
//
// Every "must NOT block" case below is a real posting from the live corpus that
// an earlier version of these patterns got wrong. They are the point of this
// file: the failure mode here is silent, because a wrongly-blocked job simply
// stops appearing and nobody notices. Do not delete a case without checking the
// company it names.

const test = require('node:test');
const assert = require('node:assert');
const { classifyRestriction, deriveRestriction, isDisqualifying } = require('../src/services/clearance');
const { classifySponsorship } = require('../src/services/classifier');

// ─── Must BLOCK ───────────────────────────────────────────────────────────────

const BLOCKING = [
  ['Active Security Clearance required', 'CLEARANCE'],
  // "eligible to obtain" is as blocking as holding one — clearance eligibility
  // itself requires US citizenship (Anduril, Applied Intuition phrase it this way).
  ['Must hold or be eligible to obtain and maintain a U.S. security clearance', 'CLEARANCE'],
  ['must currently possess and maintain an active TS/SCI security clearance with polygraph', 'CLEARANCE'],
  // Amazon's export-control clause. Reported as EXPORT_CONTROL rather than
  // CITIZENSHIP because the bar is statutory, not a company preference.
  [
    'Due to applicable export control laws and regulations, candidates must be a U.S. citizen or national, U.S. permanent resident',
    'EXPORT_CONTROL',
  ],
  ['Must be a U.S. Person due to required access to U.S. export controlled information', 'EXPORT_CONTROL'],
  ['ITAR REQUIREMENTS: applicant must be a (i) US citizen or national', 'EXPORT_CONTROL'],
  ['this role requires access to export-controlled items that require "U.S. person" status', 'EXPORT_CONTROL'],
  ['applicants for this position must be U.S. citizens', 'CITIZENSHIP'],
  ['Proof of U.S. citizenship and residency', 'CITIZENSHIP'],
  // Anduril's export clause — "either" and the curly quotes defeated the
  // earlier pattern.
  ['must either be a “U.S. person” as defined by 22 C.F.R. § 120.62', 'EXPORT_CONTROL'],
  ['U.S. Citizen or Green Card (Lawful Permanent Resident) holder only', 'CITIZENSHIP'],
  ['Must be clearance eligible', 'CLEARANCE'],
];

test('blocks roles that require clearance, US-person status, or citizenship', () => {
  for (const [text, expected] of BLOCKING) {
    assert.strictEqual(classifyRestriction(text), expected, `text: ${text}`);
  }
});

// ─── Must NOT block ───────────────────────────────────────────────────────────

const NON_BLOCKING = [
  // EEO boilerplate. "citizenship" appears in ~105 postings as a protected
  // class, imposing nothing. Only verb-anchored forms are requirements.
  ['we are an equal opportunity employer regardless of race, age, citizenship, marital status', ''],
  // "military" contains the substring "itar". An unbounded /itar/ matched 245
  // rows in the corpus; 237 were this boilerplate. Word boundaries cut it to 8.
  ['protected veteran status, discharge status from the military, genetic information', ''],
  // Compliance-framework name-drop, not an eligibility bar (Saronic).
  ['ensure compliance with regulatory and audit frameworks (e.x ITAR, FedRAMP)', ''],
  // Databricks and Cloudflare — export control named with NO personal
  // requirement. Both are prolific H-1B sponsors; blocking these would hide
  // exactly the jobs this board exists to surface.
  [
    "Compliance: if access to export-controlled technology is required, it is within Employer's discretion whether to apply for a license",
    'EXPORT_ADVISORY',
  ],
  ['This position may require access to information protected under U.S. export control laws', 'EXPORT_ADVISORY'],
  // Clearance named but optional — still applicable, so shown.
  ['Top Secret Clearance Highly Desired', 'CLEARANCE_PREFERRED'],
  ['Security clearance is a plus', 'CLEARANCE_PREFERRED'],
  // "secret" in a product sense.
  ['We build secret management tooling and handle secret sauce', ''],
];

test('does not block EEO boilerplate, advisory export notes, or optional clearance', () => {
  for (const [text, expected] of NON_BLOCKING) {
    assert.strictEqual(classifyRestriction(text), expected, `text: ${text}`);
  }
});

// ─── Input normalization ──────────────────────────────────────────────────────

test('sees through entity-encoded HTML and inline markup', () => {
  // stripHtml() in normalize.js decodes entities AFTER stripping tags, so
  // entity-encoded input arrives as live markup — 616 stored descriptions
  // contain literal <p>/<li>. classifyRestriction normalizes independently.
  assert.strictEqual(
    classifyRestriction('&lt;p&gt;&lt;strong&gt;Must be a U.S. citizen.&lt;/strong&gt;&lt;/p&gt;'),
    'CITIZENSHIP',
  );
  // Markup splitting a target phrase must not defeat the match.
  assert.strictEqual(classifyRestriction('Active <b>Security</b> Clearance required'), 'CLEARANCE');
});

test('returns empty string, never null, for unusable input', () => {
  for (const input of ['', null, undefined, 42, {}]) {
    assert.strictEqual(classifyRestriction(input), '');
  }
});

// ─── Disqualification set ─────────────────────────────────────────────────────

test('blocking tiers disqualify, advisory ones do not', () => {
  for (const r of ['CLEARANCE', 'EXPORT_CONTROL', 'CITIZENSHIP', 'GOVERNMENT', 'DEFENSE_EMPLOYER', 'NO_SPONSORSHIP']) {
    assert.strictEqual(isDisqualifying(r), true, r);
  }
  // These name a restriction without imposing one, and must stay visible.
  for (const r of ['EXPORT_ADVISORY', 'CLEARANCE_PREFERRED', '']) {
    assert.strictEqual(isDisqualifying(r), false, r);
  }
});

// ─── deriveRestriction: rows with little or no description ───────────────────

const LONG_NEUTRAL = 'Build distributed systems in Go and Python. '.repeat(10);

test('title alone can block', () => {
  assert.strictEqual(deriveRestriction({ job_title: 'Software Engineer - Cleared' }), 'CLEARANCE');
  assert.strictEqual(deriveRestriction({ job_title: 'Software Engineer II - CTJ - Top Secret' }), 'CLEARANCE');
  assert.strictEqual(deriveRestriction({ job_title: 'Software Engineer - Federal' }), 'GOVERNMENT');
  assert.strictEqual(
    deriveRestriction({ job_title: 'Forward Deployed Software Engineer - U.S. Government' }),
    'GOVERNMENT',
  );
});

test('title rules leave ordinary titles alone', () => {
  for (const job_title of [
    'Software Engineer, Secrets Management', // "secrets", not a clearance
    'Forward Deployed AI Engineer, Land Use and Government Affairs', // Zipline
    'Software Engineer, Mission Control', // Torc Robotics
  ]) {
    assert.strictEqual(deriveRestriction({ job_title, description: LONG_NEUTRAL }), '', job_title);
  }
});

test('defense employers block always; RTX only without a description', () => {
  // Anduril with a description that omits the citizenship clause — the gap
  // that kept 9 Anduril rows visible.
  assert.strictEqual(
    deriveRestriction({ job_title: 'Software Engineer', company_name: 'Anduril Industries', description: LONG_NEUTRAL }),
    'DEFENSE_EMPLOYER',
  );
  assert.strictEqual(
    deriveRestriction({ job_title: 'Software Engineer', company_name: 'RTX' }),
    'DEFENSE_EMPLOYER',
  );
  assert.strictEqual(
    deriveRestriction({ job_title: 'Software Engineer', company_name: 'Northrop Grumman' }),
    'DEFENSE_EMPLOYER',
  );
  assert.strictEqual(
    deriveRestriction({ job_title: 'Software Engineer', company_name: 'The Boeing Company' }),
    'DEFENSE_EMPLOYER',
  );
  // With text, the description decides. RTX does sponsor specific roles.
  assert.strictEqual(
    deriveRestriction({
      job_title: 'Software Engineer',
      company_name: 'RTX',
      description: `${LONG_NEUTRAL} The company will offer immigration sponsorship for this role.`,
    }),
    '',
  );
  // Name must start with the employer, not merely contain it.
  assert.strictEqual(
    deriveRestriction({ job_title: 'Software Engineer', company_name: 'Friends of Boeing Field' }),
    '',
  );
});

test('explicit no-sponsorship blocks; source labels win', () => {
  assert.strictEqual(deriveRestriction({ job_title: 'SWE', sponsorship: 'NO' }), 'NO_SPONSORSHIP');
  assert.strictEqual(
    deriveRestriction({ job_title: 'SWE', sponsorship: 'NO', restriction_override: 'CITIZENSHIP' }),
    'CITIZENSHIP',
  );
});

// ─── Sponsorship NO patterns ──────────────────────────────────────────────────

test('sponsorship NO needs an explicit refusal', () => {
  for (const text of [
    'You must be authorized to work in the United States without the need for employer sponsorship',
    'This position is not eligible for employment-based sponsorship',
    'We will not sponsor visas for this role',
    'Candidates must not now or in the future require visa sponsorship',
    'Visa sponsorship is not available for this position',
  ]) {
    assert.strictEqual(classifySponsorship(text.toLowerCase(), ''), 'NO', text);
  }
  // H-1B and OPT holders ARE authorized to work; this line alone says nothing.
  assert.notStrictEqual(
    classifySponsorship('must be legally authorized to work in the united states', ''),
    'NO',
  );
});

test("owner's exclusion list hides Netflix, xAI and Capgemini from any source", () => {
  for (const company_name of ['Netflix', 'xAI', 'X.ai', 'Capgemini', 'Capgemini America']) {
    assert.strictEqual(
      deriveRestriction({ job_title: 'Software Engineer', company_name, description: LONG_NEUTRAL, sponsorship: 'YES' }),
      'EXCLUDED_EMPLOYER',
      company_name,
    );
  }
  assert.strictEqual(deriveRestriction({ job_title: 'Software Engineer', company_name: 'Netlify', description: LONG_NEUTRAL }), '');
});

test('USCIS lookup matches brand names that prefix the legal petitioner name', () => {
  // "capital-one-services", "american-express-travel-related-services-company"
  assert.strictEqual(classifySponsorship('software engineer', 'Capital One'), 'YES');
  assert.strictEqual(classifySponsorship('software engineer', 'American Express'), 'YES');
  // An explicit refusal still beats the lookup.
  assert.strictEqual(classifySponsorship('we are unable to sponsor visas', 'Capital One'), 'NO');
});
