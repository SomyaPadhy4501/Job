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

test('a bare country code is a country; a trailing one counts only if no state shares it', () => {
  // From the production dry run (2026-11-02, 15,690 rows).
  assert.deepStrictEqual(storedCountries(row('microsoft', 'CA')), ['abroad'], 'country-wide Canada');
  assert.deepStrictEqual(storedCountries(row('microsoft', 'IL')), ['abroad'], 'country-wide Israel');
  assert.deepStrictEqual(storedCountries(row('pcsx', 'Cork, CO, IE')), ['abroad']);
  assert.deepStrictEqual(storedCountries(row('microsoft', 'Cambridge, England, GB')), ['abroad']);
  // April-era Microsoft rows carry no country: "Redmond, WA" was flagged by the
  // first version of this rule. Codes a state shares are left to looksUS.
  assert.strictEqual(storedCountries(row('microsoft', 'Redmond, WA')), undefined);
  assert.strictEqual(storedCountries(row('microsoft', 'Mountain View, CA')), undefined);
  assert.strictEqual(storedCountries(row('pcsx', 'Markham, ON, CA')), undefined);
  assert.strictEqual(reason(row('microsoft', 'Redmond, WA')), null);
  assert.strictEqual(reason(row('microsoft', 'Mountain View, CA')), null);
  // A shared code with a foreign marker is still caught by looksUS.
  assert.strictEqual(reason(row('pcsx', 'Noida, UP, IN')), 'not US');
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
