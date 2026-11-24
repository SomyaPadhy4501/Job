import test from 'node:test';
import assert from 'node:assert/strict';
import { webHref, resumeId } from '../web/src/safe-url.js';

test('job links: only http(s) reach an href; script and data links become nothing', () => {
  assert.equal(webHref('https://boards.greenhouse.io/acme/jobs/1'), 'https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(webHref('http://example.com/x'), 'http://example.com/x');
  for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x',
    'vbscript:x', '/relative', '', null, undefined, 42]) {
    assert.equal(webHref(bad), undefined, String(bad));
  }
});

test('resume ids from the address bar: a UUID or nothing', () => {
  assert.equal(resumeId('5C1E2D3F-0000-4000-8000-000000000001'), '5c1e2d3f-0000-4000-8000-000000000001');
  for (const bad of ['../../me/tokens', '5c1e2d3f-0000-4000-8000-000000000001/../x', 'abc', '', null]) {
    assert.equal(resumeId(bad), '', String(bad));
  }
});
