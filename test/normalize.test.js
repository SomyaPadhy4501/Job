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
