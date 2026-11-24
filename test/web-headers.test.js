'use strict';

// vercel.json's security headers: every page gets them, and the CSP never
// allows inline scripts or eval on the app pages.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../vercel.json');

const forAll = config.headers.find((h) => h.source === '/(.*)').headers;
const get = (list, key) => list.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

test('every response carries the basic security headers', () => {
  assert.equal(get(forAll, 'X-Content-Type-Options'), 'nosniff');
  assert.match(get(forAll, 'Strict-Transport-Security') || '', /max-age=(\d{8,})/);
  assert.equal(get(forAll, 'X-Frame-Options'), 'DENY');
  assert.ok(get(forAll, 'Referrer-Policy'));
  assert.ok(get(forAll, 'Permissions-Policy'));
});

test('the app CSP has no inline scripts or eval and can’t be framed', () => {
  const app = config.headers.find((h) => h.source.startsWith('/((?!')).headers;
  const csp = get(app, 'Content-Security-Policy');
  const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  assert.doesNotMatch(script, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
});
