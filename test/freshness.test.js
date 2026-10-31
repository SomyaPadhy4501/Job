'use strict';

// Regression tests for which sources the delisting sweep may prune.
//
// pruneUnseenJobs deletes every row of a source that this run didn't refresh,
// so this decision is the only thing standing between a flaky upstream and an
// emptied board. Each failing case below is a shape that occurs in production
// collect runs (2026-10-26): getro rate-limited on most networks, uber
// "succeeding" with zero rows, and a few dozen dead greenhouse slugs that 404
// on every run.

const test = require('node:test');
const assert = require('node:assert');
const { refreshedSources } = require('../src/services/freshness');

const ok = (source, n) => ({ company: { source }, ok: true, jobs: Array(n).fill({}) });
const fail = (source) => ({ company: { source }, ok: false, jobs: [], error: 'HTTP 429' });

test('a source that returned rows is refreshed', () => {
  assert.deepStrictEqual(refreshedSources([ok('amazon', 1286)]), ['amazon']);
});

test('a source whose every fetch failed is not refreshed', () => {
  assert.deepStrictEqual(refreshedSources([fail('workday'), fail('workday')]), []);
});

test('a source that "succeeded" with zero rows is not refreshed', () => {
  // Uber's collector catches every query error and returns []. Treating that as
  // a refresh would delete all its rows three days into the outage.
  assert.deepStrictEqual(refreshedSources([ok('uber', 0)]), []);
});

test('dead boards in a minority do not block their source', () => {
  // 31 of ~230 greenhouse slugs 404 every run. Their rows should age out like
  // any delisted job, and the rest of greenhouse must still be pruned.
  const results = [ok('greenhouse', 40), ok('greenhouse', 12), ok('greenhouse', 0), fail('greenhouse')];
  assert.deepStrictEqual(refreshedSources(results), ['greenhouse']);
});

test('a source that mostly failed is treated as down', () => {
  // getro: 4 networks ok, 12 rate-limited. The 12 networks' rows weren't
  // refreshed because of the 429s, not because their jobs closed.
  const results = [...Array(4)].map(() => ok('getro', 100)).concat([...Array(12)].map(() => fail('getro')));
  assert.deepStrictEqual(refreshedSources(results), []);
});

test('sources are judged independently and listed once', () => {
  const results = [ok('lever', 5), fail('getro'), ok('lever', 7), ok('ashby', 3), ok('uber', 0)];
  assert.deepStrictEqual(refreshedSources(results).sort(), ['ashby', 'lever']);
});

test('sampled sources are never refreshed', () => {
  // Adzuna returns the 50 newest matches per search and JSearch the last 3
  // days; a job outside that sample is still open and must not be pruned.
  assert.deepStrictEqual(refreshedSources([ok('adzuna', 50), ok('jsearch', 9), ok('lever', 2)]), ['lever']);
});
