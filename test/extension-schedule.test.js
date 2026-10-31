'use strict';

// Daily-run rule for the browser extension (extension/schedule.js): once per
// local day, at or after the set time, and immediately on the first check
// after a missed time ("if I wasn't on at 10, run when I turn on").

const test = require('node:test');
const assert = require('node:assert');
const S = require('../extension/schedule.js');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);

test('not due before the scheduled time', () => {
  assert.strictEqual(S.isDue(at(2026, 11, 2, 9, 59), '2026-11-01', '10:00'), false);
});

test('due at or after the scheduled time, once per day', () => {
  assert.strictEqual(S.isDue(at(2026, 11, 2, 10, 0), '2026-11-01', '10:00'), true);
  assert.strictEqual(S.isDue(at(2026, 11, 2, 10, 5), '2026-11-02', '10:00'), false);
});

test('a missed run fires on the first check after the computer comes back', () => {
  // Off at 10:00, switched on at 15:30 the same day.
  assert.strictEqual(S.isDue(at(2026, 11, 2, 15, 30), '2026-11-01', '10:00'), true);
  // Off all day yesterday too — still just one run today.
  assert.strictEqual(S.isDue(at(2026, 11, 2, 15, 30), '2026-10-30', '10:00'), true);
});

test('nextRun is today if the time is still ahead, else tomorrow', () => {
  assert.deepStrictEqual(S.nextRun(at(2026, 11, 2, 8, 0), '10:00'), at(2026, 11, 2, 10, 0));
  assert.deepStrictEqual(S.nextRun(at(2026, 11, 2, 11, 0), '10:00'), at(2026, 11, 3, 10, 0));
});

test('malformed time falls back to 10:00', () => {
  assert.deepStrictEqual(S.parseTime('banana'), { h: 10, m: 0 });
});
