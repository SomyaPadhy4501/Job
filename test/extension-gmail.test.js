'use strict';
// gmail.js in the worker, against a fake portal: what it asks for, what it
// trusts in the answer, and which links it opens. Gmail itself is read by the
// portal (crates/api/src/connectors.rs, tested in crates/api/tests/api.rs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pages = require('../extension/application-pages');

// Objects from the sandbox have its own prototypes.
const plain = (v) => JSON.parse(JSON.stringify(v));

const source = fs.readFileSync(path.join(__dirname, '../extension/gmail.js'), 'utf8');

function store(initial) {
  const data = { ...initial };
  return {
    data,
    get: async (k) => (typeof k === 'string' ? (k in data ? { [k]: data[k] } : {}) : {}),
    set: async (v) => Object.assign(data, v),
    remove: async (k) => [].concat(k).forEach((x) => delete data[x]),
  };
}

// `answers`: path -> the portal's JSON answer (or a function of the body).
function load(answers) {
  const opened = [];
  const asked = [];
  const session = store({ gmailToken: { token: 'old' } });
  const local = store({ gmailEmail: 'old@example.invalid' });
  const sandbox = {
    self: {},
    chrome: {
      storage: { session, local },
      tabs: {
        create: async (o) => (opened.push(o.url), { id: 1 }),
        remove: async () => {},
        onUpdated: { addListener() {}, removeListener() {} },
      },
    },
    JobApplicationPages: pages,
    URL,
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  async function request(p, init, optional, say) {
    const body = init?.body ? JSON.parse(init.body) : null;
    asked.push({ path: p, method: init?.method || 'GET', body, say });
    const answer = answers[p];
    if (answer === undefined) {
      if (optional) return null;
      throw new Error('Portal request failed (HTTP 404).');
    }
    const value = typeof answer === 'function' ? answer(body) : answer;
    return new Response(JSON.stringify(value));
  }
  return { G: sandbox.self.AutofillGmail, request, opened, asked, session, local };
}

test('codes: asks the portal with the shape and the used ids, remembers each email', async () => {
  const { G, request, asked } = load({
    'gmail/code': (b) => (b.skip.includes('m1') ? { code: null, messageId: null } : { code: '482913', messageId: 'm1' }),
  });
  assert.equal(await G.findCode(request, 'workday', 'acme', { length: 6, charset: 'digits' }), '482913');
  assert.deepEqual(asked[0], {
    path: 'gmail/code',
    method: 'POST',
    body: { site: 'workday', tenant: 'acme', length: 6, charset: 'digits', skip: [] },
    say: true,
  });
  assert.equal(await G.findCode(request, 'workday', 'acme', { length: 6, charset: 'digits' }), null, 'used once');
  assert.deepEqual(plain(asked[1].body.skip), ['m1']);
});

test('codes: only the shape the page asked for, whatever the portal answers', async () => {
  for (const [code, shape] of [
    ['12345', { length: 6, charset: 'digits' }],
    ['A1B2C3', { length: 6, charset: 'digits' }],
    ['<img src=x>', { length: 0, charset: 'alnum' }],
    [42, { length: 0, charset: 'alnum' }],
  ]) {
    const { G, request } = load({ 'gmail/code': { code, messageId: 'x1' } });
    assert.equal(await G.findCode(request, 'greenhouse', '', shape), null, String(code));
  }
  const { G, request, asked } = load({ 'gmail/code': { code: 'A1B2C3D4', messageId: 'g1' } });
  assert.equal(await G.findCode(request, 'greenhouse', '', { length: 8, charset: 'alnum' }), 'A1B2C3D4');
  assert.equal('tenant' in asked[0].body, false);
  assert.equal('company' in asked[0].body, false);
  // With the board and the company on the page: both go to the portal.
  await G.findCode(request, 'greenhouse', 'discord', { length: 8, charset: 'alnum' }, 'Discord');
  assert.equal(asked[1].body.tenant, 'discord');
  assert.equal(asked[1].body.company, 'Discord');
});

test('verify links: this company only, https, opened by the worker', async () => {
  for (const link of [
    'https://evil.example/verify?x=1',
    'https://other.wd5.myworkdayjobs.com/verify?t=2',
    'http://acme.wd5.myworkdayjobs.com/verify?t=2',
    'https://acme.wd5.myworkdayjobs.com/en-US/External/jobs',
    'javascript:alert(1)',
    null,
  ]) {
    const { G, request, opened } = load({ 'gmail/verify-link': { link, messageId: 'x' } });
    assert.equal(await G.openVerifyLink(request, 'acme'), false, String(link));
    assert.deepEqual(opened, []);
  }
  const good = 'https://acme.wd5.myworkdayjobs.com/en-US/External/activate?token=abc&x=1';
  const { G, request, opened, session } = load({ 'gmail/verify-link': { link: good, messageId: 'v1' } });
  assert.equal(await G.openVerifyLink(request, 'acme'), true);
  assert.deepEqual(opened, [good]);
  assert.deepEqual(plain(session.data.gmailUsed), ['v1']);
});

test('the old in-extension token is cleared', async () => {
  const { session, local } = load({});
  await new Promise((r) => setImmediate(r));
  assert.equal(session.data.gmailToken, undefined);
  assert.equal(local.data.gmailEmail, undefined);
});

test('the portal saying "not connected" reaches the caller', async () => {
  const { G } = load({});
  const request = async () => {
    throw new Error('Connect Gmail in Alerts & Connectors on the job board to fill codes.');
  };
  await assert.rejects(G.findCode(request, 'workday', 'acme', {}), /Alerts & Connectors/);
});
