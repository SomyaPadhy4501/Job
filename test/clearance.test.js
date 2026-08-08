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
const { classifyRestriction, isDisqualifying } = require('../src/services/clearance');

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

test('only the three hard tiers disqualify', () => {
  for (const r of ['CLEARANCE', 'EXPORT_CONTROL', 'CITIZENSHIP']) {
    assert.strictEqual(isDisqualifying(r), true, r);
  }
  // These name a restriction without imposing one, and must stay visible.
  for (const r of ['EXPORT_ADVISORY', 'CLEARANCE_PREFERRED', '']) {
    assert.strictEqual(isDisqualifying(r), false, r);
  }
});
