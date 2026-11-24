'use strict';

// fetchJson under a platform-wide rate limit (src/collectors/http.js). On
// 2026-11-24 248 of 256 Workday employers failed one run with HTTP 429,
// because every tenant retried on its own. Fake fetch; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchJson, resetRateLimits, GIVE_UP_AFTER, NODE_HTTP_PLATFORMS } = require('../src/collectors/http');

NODE_HTTP_PLATFORMS.clear(); // Workday through the faked fetch below

const realFetch = global.fetch;
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const limited = (seconds) => new Response('slow down', { status: 429, headers: { 'retry-after': String(seconds) } });

test.afterEach(() => {
  global.fetch = realFetch;
  resetRateLimits();
});

test('one 429 pauses every request to that platform, then both succeed', async () => {
  const calls = [];
  let first = true;
  global.fetch = async (url) => {
    calls.push({ url, at: Date.now() });
    if (first) {
      first = false;
      return limited(0.3);
    }
    return json({ ok: url });
  };
  const a = fetchJson('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/x/jobs');
  await new Promise((r) => setTimeout(r, 50));
  const b = fetchJson('https://other.wd1.myworkdayjobs.com/wday/cxs/other/y/jobs');
  assert.deepEqual(await Promise.all([a, b]), [
    { ok: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/x/jobs' },
    { ok: 'https://other.wd1.myworkdayjobs.com/wday/cxs/other/y/jobs' },
  ]);
  const limitedAt = calls[0].at;
  for (const c of calls.slice(1)) assert.ok(c.at - limitedAt >= 280, 'waited out the shared pause');
});

test('a platform that keeps answering 429 is given up on, without more requests', async () => {
  let sent = 0;
  global.fetch = async () => {
    sent++;
    return limited(0.01);
  };
  const url = 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/x/jobs';
  let gaveUp = null;
  for (let i = 0; i < 10 && !gaveUp; i++) {
    await fetchJson(url).catch((err) => {
      if (/gave up/.test(err.message)) gaveUp = err;
    });
  }
  assert.ok(gaveUp, 'stopped trying');
  assert.equal(gaveUp.status, 429);
  assert.equal(sent, GIVE_UP_AFTER);
  // Other platforms are unaffected.
  global.fetch = async () => json({ fine: true });
  assert.deepEqual(await fetchJson('https://boards-api.greenhouse.io/v1/boards/x/jobs'), { fine: true });
});
