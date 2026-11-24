'use strict';
// The listing-capture hook must never run on, or forward data from,
// application pages. hook.js runs in the page world and carries its own copy
// of the rules in application-pages.js; this keeps the two in step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pages = require('../extension/application-pages');

const hook = fs.readFileSync(path.join(__dirname, '../extension/hook.js'), 'utf8');

function runHook(href) {
  const location = new URL(href);
  const origFetch = async () => {};
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  const origOpen = XMLHttpRequest.prototype.open;
  const window = {
    location,
    fetch: origFetch,
    addEventListener() {},
    postMessage() {},
  };
  vm.runInNewContext(hook, { window, location, XMLHttpRequest, URL, URLSearchParams });
  return { hooked: window.fetch !== origFetch || XMLHttpRequest.prototype.open !== origOpen };
}
function response(url) {
  return {
    url,
    headers: { get: () => 'application/json' },
    clone: () => ({ text: async () => '{"jobs":[]}' }),
  };
}

const PRIVATE = [
  'https://jobs.lever.co/acme/5f1c/apply',
  'https://jobs.lever.co/acme/5f1c',
  'https://jobs.ashbyhq.com/acme/5f1c/application',
  'https://jobs.ashbyhq.com/acme/5f1c',
  'https://boards.greenhouse.io/acme/jobs/123',
  'https://boards.greenhouse.io/embed/job_app?for=acme&token=123',
  'https://job-boards.greenhouse.io/acme/jobs/123',
  'https://boards.greenhouse.io/acme?gh_jid=123',
  'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/SWE_R1/apply',
  'https://acme.wd5.myworkdayjobs.com/en-US/Careers/userHome',
  'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Boston/SWE_R1',
  'https://acme.wd1.myworkdaysite.com/recruiting/acme/Careers/candidateHome',
  'https://careers.acme.example/jobs/123/apply',
  'https://careers.acme.example/application/step-2',
  'https://careers.acme.example/login',
];
const PUBLIC = [
  'https://jobs.lever.co/acme',
  'https://jobs.ashbyhq.com/acme',
  'https://boards.greenhouse.io/acme',
  'https://acme.wd5.myworkdayjobs.com/en-US/Careers',
  'https://careers.acme.example/jobs',
];

test('the network hook is not installed on application, candidate or login pages', () => {
  for (const href of PRIVATE) {
    assert.equal(pages.privatePage(href), true, href);
    assert.equal(runHook(href).hooked, false, href);
  }
  for (const href of PUBLIC) {
    assert.equal(pages.privatePage(href), false, href);
    assert.equal(runHook(href).hooked, true, href);
  }
});

test('on an ATS board only public listing endpoints are forwarded', async () => {
  const cases = [
    ['https://jobs.lever.co/acme', 'https://jobs.lever.co/v0/postings/acme', true],
    ['https://jobs.lever.co/acme', 'https://jobs.lever.co/acme/5f1c/apply/parse', false],
    ['https://acme.wd5.myworkdayjobs.com/en-US/Careers', 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs', true],
    ['https://acme.wd5.myworkdayjobs.com/en-US/Careers', 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/userProfile', false],
    ['https://jobs.ashbyhq.com/acme', 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', true],
    ['https://jobs.ashbyhq.com/acme', 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobApplication', false],
    ['https://boards.greenhouse.io/acme', 'https://api.example.invalid/v1/boards/acme/jobs', false],
  ];
  for (const [page, url, forwarded] of cases) {
    const location = new URL(page);
    const posted = [];
    function XMLHttpRequest() {}
    XMLHttpRequest.prototype.open = function () {};
    const window = {
      location,
      fetch: async (u) => response(u),
      addEventListener() {},
      postMessage: (m) => posted.push(m.url),
    };
    vm.runInNewContext(hook, { window, location, XMLHttpRequest, URL, URLSearchParams });
    await window.fetch(url);
    await new Promise(setImmediate);
    assert.deepEqual(posted, forwarded ? [url] : [], url);
    assert.equal(pages.publicResponse(page, url), forwarded, url);
  }
});

test('a response that arrives after the SPA moved to an application route is dropped', async () => {
  const location = new URL('https://jobs.lever.co/acme');
  const posted = [];
  let release;
  const origFetch = () => new Promise((r) => (release = r));
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  const window = { location, fetch: origFetch, addEventListener() {}, postMessage: (m) => posted.push(m.url) };
  vm.runInNewContext(hook, { window, location, XMLHttpRequest, URL, URLSearchParams });
  const pending = window.fetch('https://jobs.lever.co/v0/postings/acme');
  location.pathname = '/acme/5f1c/apply';
  release(response('https://jobs.lever.co/v0/postings/acme'));
  await pending;
  await new Promise(setImmediate);
  assert.deepEqual(posted, []);

  // The same response on the board page itself is forwarded.
  location.pathname = '/acme';
  const again = window.fetch('https://jobs.lever.co/v0/postings/acme');
  release(response('https://jobs.lever.co/v0/postings/acme'));
  await again;
  await new Promise(setImmediate);
  assert.deepEqual(posted, ['https://jobs.lever.co/v0/postings/acme']);
});
