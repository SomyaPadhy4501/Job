'use strict';

// prune-rejected.js re-checks stored rows, which keep only the joined location
// string. These are the rows it has to judge the way the collectors now do
// with structured countries — all live in production on 2026-11-01.

const test = require('node:test');
const assert = require('node:assert');
const { reason, storedCountries } = require('../src/scripts/prune-rejected');

const row = (source, location, job_title = 'Software Engineer') => ({ source, location, job_title });

test('stored Microsoft / PCSX rows are judged by their trailing country codes', () => {
  assert.deepStrictEqual(storedCountries(row('microsoft', 'IN')), ['abroad']);
  assert.deepStrictEqual(storedCountries(row('pcsx', 'Hsinchu, Hsinchu City, TW')), ['abroad']);
  assert.deepStrictEqual(storedCountries(row('microsoft', 'Redmond, WA, US')), ['US']);
  assert.deepStrictEqual(storedCountries(row('microsoft', 'US, Redmond, WA, US, Mountain View, CA, US')), ['US']);
  assert.deepStrictEqual(storedCountries(row('pcsx', 'San Diego, CA, US, Hsinchu, Hsinchu City, TW')), ['US']);
  // Not the standardized shape (raw `locations` fallback): looksUS decides.
  assert.strictEqual(storedCountries(row('microsoft', 'United States, Washington, Redmond')), undefined);
});

test('stored Getro rows whose only US entry is a bare state beside places abroad', () => {
  assert.deepStrictEqual(
    storedCountries(row('getro', 'Tennessee, USA, Bengaluru, Karnataka, India, Chennai, Tamil Nadu, India')),
    ['abroad']
  );
  assert.deepStrictEqual(storedCountries(row('getro', 'Bengaluru, Karnataka, India, Ohio, USA')), ['abroad']);
  // A US city entry, a US-wide entry, or a state with nothing abroad settles nothing here.
  assert.strictEqual(storedCountries(row('getro', 'San Jose, CA, USA, Bengaluru, Karnataka, India')), undefined);
  assert.strictEqual(storedCountries(row('getro', 'United States, Remote')), undefined);
  assert.strictEqual(storedCountries(row('getro', 'Florida, USA')), undefined);
  assert.strictEqual(storedCountries(row('getro', 'Florida, USA, Remote')), undefined);
});

test('reason() flags the leaked rows and keeps the US ones', () => {
  for (const r of [
    row('microsoft', 'IN'),
    row('getro', 'Tennessee, USA, Bengaluru, Karnataka, India, Chennai, Tamil Nadu, India'),
    row('workday', 'IN Sector 142 Noida'),
  ]) {
    assert.strictEqual(reason(r), 'not US', r.location);
  }
  for (const r of [
    row('microsoft', 'Redmond, WA, US'),
    row('getro', 'Broomfield, CO, USA, Fort Collins, CO, USA'),
    row('ghlistings', 'Indianapolis, IN'),
    row('ghlistings', 'Abbott Park, Green Oaks, IL'),
  ]) {
    assert.strictEqual(reason(r), null, r.location);
  }
});
