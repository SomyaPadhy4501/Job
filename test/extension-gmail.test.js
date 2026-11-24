'use strict';
// gmail.js in the worker, against a fake Gmail API: which mail it reads and
// what it hands back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pages = require('../extension/application-pages');

const source = fs.readFileSync(path.join(__dirname, '../extension/gmail.js'), 'utf8');
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

function store(initial) {
  const data = { ...initial };
  return {
    data,
    get: async (k) =>
      typeof k === 'string'
        ? k in data
          ? { [k]: data[k] }
          : {}
        : Object.fromEntries(Object.keys(k || {}).map((x) => [x, x in data ? data[x] : k[x]])),
    set: async (v) => Object.assign(data, v),
    remove: async (k) => [].concat(k).forEach((x) => delete data[x]),
  };
}

function load(messages, { connected = true } = {}) {
  const opened = [];
  const queries = [];
  const sandbox = {
    self: { JOB_CONFIG: { gmailClientId: 'client' } },
    chrome: {
      storage: {
        session: store(connected ? { gmailToken: { token: 't', until: Date.now() + 60_000 } } : {}),
        local: store(connected ? { gmailEmail: 'pat@example.invalid' } : {}),
      },
      tabs: {
        create: async (o) => (opened.push(o.url), { id: 1 }),
        remove: async () => {},
        onUpdated: { addListener() {}, removeListener() {} },
      },
      identity: { getRedirectURL: () => 'https://id.chromiumapp.org/' },
    },
    fetch: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/messages')) {
        queries.push(u.searchParams.get('q'));
        return new Response(JSON.stringify({ messages: messages.map((m) => ({ id: m.id })) }));
      }
      const id = u.pathname.split('/').pop();
      const m = messages.find((x) => x.id === id);
      return new Response(
        JSON.stringify({
          id,
          internalDate: String(m.at ?? Date.now()),
          payload: {
            headers: [{ name: 'From', value: m.from }],
            mimeType: m.html ? 'text/html' : 'text/plain',
            body: { data: b64url(m.body) },
          },
        })
      );
    },
    JobApplicationPages: pages,
    URL,
    URLSearchParams,
    TextDecoder,
    atob,
    crypto: globalThis.crypto,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    Response,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return { G: sandbox.self.AutofillGmail, opened, queries };
}

test('codes: only this company, recent mail, the requested shape, each email once', async () => {
  const { G, queries } = load([
    { id: 'old', from: 'Acme <acme@myworkday.com>', body: 'Your code is 111111', at: Date.now() - 20 * 60_000 },
    { id: 'other', from: 'Other <other@myworkday.com>', body: 'Your verification code is 222222' },
    { id: 'mine', from: 'Acme <acme@myworkday.com>', body: 'Your verification code is 482913. It expires soon.' },
  ]);
  assert.equal(await G.findCode('workday', 'acme', { length: 6, charset: 'digits' }), '482913');
  assert.match(queries[0], /^from:myworkday\.com/);
  assert.equal(await G.findCode('workday', 'acme', { length: 6, charset: 'digits' }), null, 'used once');
});

test('Greenhouse security codes and code shapes', async () => {
  const { G, queries } = load([
    {
      id: 'g',
      from: 'Greenhouse <no-reply@us.greenhouse-mail.io>',
      body: 'Copy and paste this code into the security code field on your application:\n\nA1B2C3D4\n',
    },
  ]);
  assert.equal(await G.findCode('greenhouse', '', { length: 8, charset: 'alnum' }), 'A1B2C3D4');
  assert.match(queries[0], /greenhouse/);
  assert.equal(G.pickCode('Your code: 1234', { length: 6, charset: 'digits' }), null, 'wrong length');
  assert.equal(G.pickCode('Use code ABCDEF to continue', { length: 6, charset: 'alnum' }), null, 'a word, not a code');
});

test('verify links: this company only, opened by the worker', async () => {
  const { G, opened } = load([
    {
      id: 'x',
      from: 'Acme <acme@myworkday.com>',
      html: true,
      body:
        '<a href="https://evil.example/verify?x=1">Verify</a>' +
        '<a href="https://other.wd5.myworkdayjobs.com/verify?t=2">no</a>' +
        '<a href="https://acme.wd5.myworkdayjobs.com/en-US/External/activate?token=abc&amp;x=1">Verify your account</a>',
    },
  ]);
  assert.equal(await G.openVerifyLink('acme'), true);
  assert.deepEqual(opened, ['https://acme.wd5.myworkdayjobs.com/en-US/External/activate?token=abc&x=1']);
});

test('not connected: a clear message and no Gmail call', async () => {
  const { G, queries } = load([], { connected: false });
  await assert.rejects(G.findCode('workday', 'acme', {}), /Connect Gmail/);
  assert.equal(queries.length, 0);
});
