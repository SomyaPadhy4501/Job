'use strict';

// Platforms in NODE_HTTP_PLATFORMS (Workday) go through Node's http(s) module
// instead of fetch (src/collectors/http.js). A local server stands in for
// Workday; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchJson, nodeFetch, resetRateLimits, NODE_HTTP_PLATFORMS } = require('../src/collectors/http');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, body, res));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('nodeFetch sends the method, headers and body and reads the answer', async () => {
  let seen;
  const server = await serve((req, body, res) => {
    seen = { method: req.method, ua: req.headers['user-agent'], type: req.headers['content-type'], body };
    res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'yes' });
    res.end(JSON.stringify({ total: 1 }));
  });
  const { port } = server.address();
  const res = await nodeFetch(`http://127.0.0.1:${port}/wday/cxs/acme/x/jobs`, {
    method: 'POST',
    headers: { 'user-agent': 'job-aggregator/1.0', 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 20 }),
  });
  server.close();
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(res.headers.get('X-Test'), 'yes');
  assert.deepEqual(await res.json(), { total: 1 });
  assert.deepEqual(seen, { method: 'POST', ua: 'job-aggregator/1.0', type: 'application/json', body: '{"limit":20}' });
});

test('fetchJson over nodeFetch still waits out a 429 and retries', async () => {
  let calls = 0;
  const server = await serve((req, body, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { 'retry-after': '0.2', 'content-type': 'text/html' });
      return res.end('slow down');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const { port } = server.address();
  NODE_HTTP_PLATFORMS.add('0.1'); // 127.0.0.1's platform key
  try {
    assert.deepEqual(await fetchJson(`http://127.0.0.1:${port}/jobs`, { method: 'POST', body: {} }), { ok: true });
    assert.equal(calls, 2);
  } finally {
    NODE_HTTP_PLATFORMS.delete('0.1');
    resetRateLimits();
    server.close();
  }
});
