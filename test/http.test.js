'use strict';

// Regression tests for fetchJson's handling of rate limits.
//
// A 429 used to be retried after half a second — still inside the limit — and
// then thrown, so a rate-limited source recorded collector.fail. Six of the
// sixteen Getro networks did that on every run (2026-10-31).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fetchJson, parseRetryAfter } = require('../src/collectors/http');

test('parseRetryAfter reads seconds and HTTP dates, capped at 30s', () => {
  assert.strictEqual(parseRetryAfter('2'), 2000);
  assert.strictEqual(parseRetryAfter('0'), 0);
  assert.strictEqual(parseRetryAfter('3600'), 30_000);
  const soon = new Date(Date.now() + 5000).toUTCString();
  assert.ok(Math.abs(parseRetryAfter(soon) - 5000) <= 1000);
  assert.strictEqual(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
  assert.strictEqual(parseRetryAfter(null), null);
  assert.strictEqual(parseRetryAfter('soon'), null);
});

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/jobs` });
    });
  });
}

test('a 429 is retried after Retry-After instead of failing the source', async () => {
  let calls = 0;
  const { server, url } = await serve((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { 'retry-after': '0' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"jobs":[1]}');
  });
  try {
    assert.deepStrictEqual(await fetchJson(url, { retries: 1 }), { jobs: [1] });
    assert.strictEqual(calls, 2);
  } finally {
    server.close();
  }
});

test('a 429 that persists still fails, carrying its status', async () => {
  const { server, url } = await serve((req, res) => {
    res.writeHead(429, { 'retry-after': '0' });
    res.end();
  });
  try {
    await assert.rejects(fetchJson(url, { retries: 1 }), (err) => err.status === 429);
  } finally {
    server.close();
  }
});
