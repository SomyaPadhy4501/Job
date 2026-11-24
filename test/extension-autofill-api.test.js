'use strict';
// Runs the worker's autofill-api.js against stub chrome/IndexedDB/fetch and
// checks it speaks the portal contract: paths, bearer auth, null handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pages = require('../extension/application-pages');

const source = fs.readFileSync(path.join(__dirname, '../extension/autofill-api.js'), 'utf8');
const POPUP = 'chrome-extension://ext/popup.html';
const ATS_TAB = { id: 'ext', url: 'https://jobs.lever.co/acme/1234/apply', tab: { id: 1 } };
const FROM_POPUP = { id: 'ext', url: POPUP };

function area(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      return Object.fromEntries(Object.entries(keys || {}).map(([k, v]) => [k, k in data ? data[k] : v]));
    },
    async set(v) {
      Object.assign(data, structuredClone(v));
    },
    async remove(k) {
      for (const key of [].concat(k)) delete data[key];
    },
  };
}
function fakeIndexedDB() {
  const store = {};
  return {
    open() {
      const req = {};
      setImmediate(() => {
        req.result = {
          close() {},
          transaction() {
            const tx = {
              objectStore: () => ({
                put(value, k) {
                  store[k] = structuredClone(value);
                  setImmediate(() => tx.oncomplete());
                  return { result: k };
                },
                get(k) {
                  const r = { result: store[k] && structuredClone(store[k]) };
                  setImmediate(() => tx.oncomplete());
                  return r;
                },
              }),
            };
            return tx;
          },
        };
        req.onsuccess();
      });
      return req;
    },
  };
}
const contractProfile = {
  user: { email: 'pat@example.invalid', name: 'Pat Example' },
  profile: {
    schema: 1,
    identity: { firstName: 'Pat', middleName: null, lastName: 'Example', preferredName: null, pronouns: null },
    workAuth: { authorizedUS: null, requiresSponsorshipNow: null, requiresSponsorshipFuture: null, visaStatus: null, optEndDate: null },
    eeo: { gender: 'decline', hispanicLatino: null, race: null, veteran: null, disability: null },
    misc: { over18: null, howDidYouHear: null },
  },
  resumes: [
    { id: 'r-1', title: 'Backend', tags: ['Backend'], isDefault: true, fileName: 'cv.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
    { id: 'r-2', title: 'ML', tags: ['ML'], isDefault: false, fileName: 'ml.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
  ],
  answers: [{ question: 'Why us?', answer: 'Because.' }],
};

function load({ portalUrl = 'https://portal.example', routes = {}, granted = [] } = {}) {
  const calls = [];
  let listener;
  const local = area({ portalUrl });
  const session = area();
  const chrome = {
    runtime: {
      id: 'ext',
      getURL: (p) => 'chrome-extension://ext/' + p,
      onMessage: { addListener: (fn) => (listener = fn) },
    },
    storage: { local, session },
    // Sites allowed with "Autofill this page" (optional host permissions).
    permissions: { contains: async ({ origins }) => origins.every((o) => granted.includes(o)) },
  };
  async function fetch(url, init) {
    calls.push({ url, init });
    const u = new URL(url);
    const route = routes[(init.method || 'GET') + ' ' + u.pathname + u.search];
    if (!route) return new Response('', { status: 404 });
    return typeof route === 'function' ? route(init) : route();
  }
  const sandbox = {
    chrome,
    fetch,
    indexedDB: fakeIndexedDB(),
    crypto: globalThis.crypto,
    AbortSignal,
    URL,
    btoa,
    JobApplicationPages: pages,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  // Replies are JSON-serialized, as chrome.runtime messaging does.
  const send = (msg, sender = ATS_TAB) =>
    new Promise((resolve) => {
      assert.equal(listener(msg, sender, (r) => resolve(JSON.parse(JSON.stringify(r)))), true);
    });
  return { send, calls, local, session, share: (...a) => sandbox.AutofillShare(...a) };
}
const json = (body, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('profile, resume file, ranking and answers use the /api/autofill contract with bearer auth', async () => {
  let posted;
  const api = load({
    routes: {
      'GET /api/autofill/profile': json(contractProfile),
      'GET /api/autofill/resumes?title=Software%20Engineer%2C%20New%20Grad': json({ resumes: [contractProfile.resumes[1], contractProfile.resumes[0]] }),
      'GET /api/autofill/resumes/r-1/file': () =>
        new Response(new Uint8Array([37, 80, 68]), {
          headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="cv.pdf"' },
        }),
      'POST /api/autofill/answers': (init) => {
        posted = { body: JSON.parse(init.body), type: init.headers['Content-Type'] };
        return json({ saved: 1 })();
      },
    },
  });
  assert.deepEqual(await api.send({ type: 'autofill:configure', token: ' tok-1 ' }, FROM_POPUP), { ok: true, data: {} });
  const profile = await api.send({ type: 'autofill:getProfile' });
  assert.equal(profile.ok, true, profile.error);
  assert.equal(profile.data.user.email, 'pat@example.invalid');
  assert.equal(profile.data.profile.workAuth.authorizedUS, null);
  const binding = profile.data.binding;
  assert.ok(binding);

  const first = api.calls[0];
  assert.equal(first.url, 'https://portal.example/api/autofill/profile');
  assert.equal(first.init.headers.Authorization, 'Bearer tok-1');
  assert.equal(first.init.credentials, 'omit');
  assert.equal(first.init.redirect, 'error');

  const ranked = await api.send({ type: 'autofill:rankResumes', title: '  Software Engineer,\n New Grad ', binding });
  assert.deepEqual(ranked.data.resumes.map((r) => r.id), ['r-2', 'r-1']);

  const file = await api.send({ type: 'autofill:getResume', id: 'r-1', binding });
  assert.deepEqual(file.data, { base64: Buffer.from('%PD').toString('base64'), fileName: 'cv.pdf', mimeType: 'application/pdf' });

  const saved = await api.send({ type: 'autofill:saveAnswers', binding, answers: [{ question: 'Why us?', answer: 'Mission.', extra: 1 }] });
  assert.deepEqual(saved, { ok: true, data: { saved: 1 } });
  assert.deepEqual(posted, { body: { answers: [{ question: 'Why us?', answer: 'Mission.' }] }, type: 'application/json' });

  // Saving invalidates the cached profile so the new answer is used next fill.
  await api.send({ type: 'autofill:getProfile' });
  assert.equal(api.calls.filter((c) => c.url.endsWith('/profile')).length, 2);
  assert.ok(api.calls.every((c) => c.url.startsWith('https://portal.example/api/autofill/')));
});

test('a portal without server-side ranking answers 404 and the extension falls back', async () => {
  const api = load({ routes: { 'GET /api/autofill/profile': json(contractProfile) } });
  await api.send({ type: 'autofill:configure', token: 'tok' }, FROM_POPUP);
  const { data } = await api.send({ type: 'autofill:getProfile' });
  assert.deepEqual(await api.send({ type: 'autofill:rankResumes', title: 'SWE', binding: data.binding }), {
    ok: true,
    data: { resumes: null },
  });
});

test('a rejected token tells the user to reconnect', async () => {
  const api = load({ routes: { 'GET /api/autofill/profile': json({}, 401) } });
  await api.send({ type: 'autofill:configure', token: 'old' }, FROM_POPUP);
  const r = await api.send({ type: 'autofill:getProfile' }, FROM_POPUP);
  assert.equal(r.ok, false);
  assert.match(r.error, /Token rejected.*[Rr]econnect/);
});

test('only HTTPS (or loopback) portals, the popup for configuration, and ATS tabs for data', async () => {
  const insecure = load({ portalUrl: 'http://portal.example' });
  assert.match((await insecure.send({ type: 'autofill:configure', token: 't' }, FROM_POPUP)).error, /HTTPS/);
  const loopback = load({ portalUrl: 'http://127.0.0.1:8787' });
  assert.equal((await loopback.send({ type: 'autofill:configure', token: 't' }, FROM_POPUP)).ok, true);

  const api = load({ routes: { 'GET /api/autofill/profile': json(contractProfile) } });
  assert.match((await api.send({ type: 'autofill:configure', token: 't' })).error, /popup/);
  await api.send({ type: 'autofill:configure', token: 't' }, FROM_POPUP);
  for (const sender of [
    { id: 'ext', url: 'https://evil.example/apply', tab: { id: 2 } },
    { id: 'ext', url: 'http://jobs.lever.co/acme/1/apply', tab: { id: 2 } },
    { id: 'other', url: ATS_TAB.url, tab: { id: 2 } },
  ])
    assert.equal((await api.send({ type: 'autofill:getProfile' }, sender)).ok, false, sender.url);
  assert.equal(api.calls.length, 0);
  // A stale binding (token changed since the panel opened) is refused.
  assert.match((await api.send({ type: 'autofill:getResume', id: 'r-1', binding: 'stale' })).error, /Account changed/);
  // Changing the portal URL after connecting invalidates the token.
  api.local.data.portalUrl = 'https://other.example';
  assert.match((await api.send({ type: 'autofill:getProfile' })).error, /Connect the autofill token/);
  // The token is never written to chrome.storage (readable by content scripts).
  assert.ok(!JSON.stringify(api.local.data).includes('"t"'));
});

test('malformed answers are refused before anything is sent', async () => {
  const api = load({ routes: { 'GET /api/autofill/profile': json(contractProfile) } });
  await api.send({ type: 'autofill:configure', token: 't' }, FROM_POPUP);
  const { data } = await api.send({ type: 'autofill:getProfile' });
  for (const answers of [[], [{ question: 'Q', answer: '  ' }], [{ question: '', answer: 'A' }], 'x'])
    assert.equal((await api.send({ type: 'autofill:saveAnswers', binding: data.binding, answers })).ok, false);
  assert.equal(api.calls.filter((c) => c.init.method === 'POST').length, 0);
});

test('a site allowed from the popup may ask for the profile; others, and plain http, may not', async () => {
  const api = load({
    routes: { 'GET /api/autofill/profile': json(contractProfile) },
    granted: ['https://www.tesla.com/*', 'http://insecure.example/*'],
  });
  await api.send({ type: 'autofill:configure', token: 't' }, FROM_POPUP);
  const tesla = { id: 'ext', url: 'https://www.tesla.com/careers/search/job/apply/123', tab: { id: 3 } };
  assert.equal((await api.send({ type: 'autofill:getProfile' }, tesla)).ok, true);
  for (const sender of [
    { id: 'ext', url: 'https://www.amazon.jobs/en/jobs/1/apply', tab: { id: 3 } },
    { id: 'ext', url: 'http://insecure.example/apply', tab: { id: 3 } },
    { id: 'ext', url: 'https://www.tesla.com/careers/apply' },
  ])
    assert.equal((await api.send({ type: 'autofill:getProfile' }, sender)).ok, false, sender.url);
});

test("shared listings go to /api/capture/jobs with the user's token, in batches of 200", async () => {
  const bodies = [];
  const api = load({
    routes: {
      'POST /api/capture/jobs': (init) => {
        bodies.push({ body: JSON.parse(init.body), auth: init.headers.Authorization, credentials: init.credentials });
        return json({ inserted: 1, updated: 2, rejected: 3, refused: 4 })();
      },
    },
  });
  await assert.rejects(api.share('https://www.tesla.com/careers', [{}]), /Connect the autofill token/);
  await api.send({ type: 'autofill:configure', token: 'tok-9' }, FROM_POPUP);
  const rows = Array.from({ length: 250 }, (_, i) => ({ job_title: 'SWE ' + i, apply_url: 'https://www.tesla.com/' + i }));
  const total = await api.share('https://www.tesla.com/careers', rows);
  assert.deepEqual(JSON.parse(JSON.stringify(total)), { inserted: 2, updated: 4, rejected: 6, refused: 8 });
  assert.deepEqual(bodies.map((b) => b.body.jobs.length), [200, 50]);
  assert.equal(bodies[0].body.pageUrl, 'https://www.tesla.com/careers');
  assert.equal(bodies[0].auth, 'Bearer tok-9');
  assert.equal(bodies[0].credentials, 'omit');
});

test("a refused share reports the portal's reason", async () => {
  const api = load({
    routes: { 'POST /api/capture/jobs': json({ error: "You've shared 3000 listings today" }, 429) },
  });
  await api.send({ type: 'autofill:configure', token: 't' }, FROM_POPUP);
  await assert.rejects(api.share('https://www.tesla.com/', [{}]), /3000 listings today/);
});

const WORKDAY = (extra = {}) => ({
  id: 'ext',
  url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Boston/SWE_1/apply',
  tab: { id: 7 },
  frameId: 0,
  documentLifecycle: 'active',
  ...extra,
});

test('job site password: set from the popup only, with real rules', async () => {
  const api = load();
  assert.match((await api.send({ type: 'autofill:setSitePassword', password: 'Str0ng!Password' }, WORKDAY())).error, /popup/);
  assert.match((await api.send({ type: 'autofill:setSitePassword', password: 'short' }, FROM_POPUP)).error, /12 characters/);
  assert.match((await api.send({ type: 'autofill:setSitePassword', password: 'alllowercase1234!' }, FROM_POPUP)).error, /upper and lower/);
  assert.equal((await api.send({ type: 'autofill:setSitePassword', password: 'Str0ng!Password' }, FROM_POPUP)).ok, true);
  const status = await api.send({ type: 'autofill:sitePasswordStatus' }, FROM_POPUP);
  assert.equal(status.data.set, true);
  assert.match((await api.send({ type: 'autofill:sitePasswordStatus' }, WORKDAY())).error, /popup/);
  // Nothing about it is in storage content scripts can read.
  assert.ok(!JSON.stringify(api.local.data).includes('Str0ng'));
  assert.ok(!JSON.stringify(api.session.data).includes('Str0ng'));
});

test('job site password: only the top frame of a Workday page gets it', async () => {
  const api = load({ granted: ['https://careers.example/*'] });
  await api.send({ type: 'autofill:setSitePassword', password: 'Str0ng!Password' }, FROM_POPUP);
  const ok = await api.send({ type: 'autofill:sitePassword' }, WORKDAY());
  assert.deepEqual(ok, { ok: true, data: { password: 'Str0ng!Password', autoSignIn: true } });
  for (const sender of [
    ATS_TAB, // Lever
    { id: 'ext', url: 'https://careers.example/apply', tab: { id: 3 }, frameId: 0 }, // a site allowed with "Autofill this page"
    WORKDAY({ frameId: 2 }), // a frame inside the Workday page
    WORKDAY({ documentLifecycle: 'prerender' }),
    FROM_POPUP,
  ]) {
    const r = await api.send({ type: 'autofill:sitePassword' }, sender);
    assert.equal(r.ok, false, sender.url);
  }
});

test('job site password: a failed sign-in stops automatic attempts; a new password resets it', async () => {
  const api = load();
  await api.send({ type: 'autofill:setSitePassword', password: 'Str0ng!Password' }, FROM_POPUP);
  assert.equal((await api.send({ type: 'autofill:sitePassword' }, WORKDAY())).data.autoSignIn, true);
  await api.send({ type: 'autofill:loginResult', result: 'failed' }, WORKDAY());
  assert.equal((await api.send({ type: 'autofill:sitePassword' }, WORKDAY())).data.autoSignIn, false);
  // Another company is unaffected.
  const other = WORKDAY({ url: 'https://other.wd1.myworkdayjobs.com/x/job/1' });
  assert.equal((await api.send({ type: 'autofill:sitePassword' }, other)).data.autoSignIn, true);
  // Three fills per company per 10 minutes.
  assert.equal((await api.send({ type: 'autofill:sitePassword' }, WORKDAY())).ok, true);
  assert.match((await api.send({ type: 'autofill:sitePassword' }, WORKDAY())).error, /Too many/);
  await api.send({ type: 'autofill:setSitePassword', password: 'An0ther!Password' }, FROM_POPUP);
  assert.deepEqual((await api.send({ type: 'autofill:sitePassword' }, WORKDAY())).data, { password: 'An0ther!Password', autoSignIn: true });
});

test('Workday companies are told apart on both Workday hosts', () => {
  assert.equal(pages.workdayTenant('https://nvidia.wd5.myworkdayjobs.com/en-US/X/job/1'), 'nvidia');
  assert.equal(pages.workdayTenant('https://wd1.myworkdaysite.com/en-US/recruiting/Acme/External/job/1'), 'acme');
  assert.equal(pages.workdayTenant('https://wd1.myworkdaysite.com/recruiting/beta/x'), 'beta');
  assert.equal(pages.workdayTenant('https://jobs.lever.co/acme/1'), '');
});
