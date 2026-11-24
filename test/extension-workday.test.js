'use strict';
// extension/workday-collect.js against a fake Workday: what it reads, how
// fast, when it stops, and what it sends. No network; a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../extension/workday-collect');

const NOW = Date.parse('2026-11-24T12:00:00Z');
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const posting = (title, path, postedOn = 'Posted Today', locationsText = 'Austin, TX') => ({ title, externalPath: path, postedOn, locationsText });

function world(boards, { blockAfter = Infinity, html = false } = {}) {
  let t = NOW;
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, at: t, method: init.method || 'GET' });
    if (calls.length > blockAfter) return new Response('<html>blocked</html>', { status: 429, headers: { 'content-type': 'text/html' } });
    if (html) return new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } });
    const u = new URL(url);
    const tenant = u.hostname.split('.')[0];
    const board = boards[tenant];
    if (init.method === 'POST') {
      const { offset, limit, searchText } = JSON.parse(init.body);
      const all = searchText ? board.search?.[searchText] || [] : board.jobs;
      return json({ total: offset === 0 ? board.total ?? all.length : 0, jobPostings: all.slice(offset, offset + limit) });
    }
    return json({ jobPostingInfo: { jobDescription: `<p>About ${u.pathname.split('/').pop()}</p>` } });
  };
  return {
    calls,
    clock: () => t,
    sleep: async (ms) => { t += ms; },
    fetch: fetchFn,
    advance: (ms) => { t += ms; },
  };
}

function store(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (k) => Object.fromEntries(Object.keys(k).map((x) => [x, x in data ? data[x] : k[x]])),
    set: async (v) => Object.assign(data, JSON.parse(JSON.stringify(v))),
    remove: async (k) => [].concat(k).forEach((x) => delete data[x]),
  };
}

const acme = { slug: 'acme', displayName: 'Acme', tenant: 'acme', wd: '5', site: 'Careers' };

test('reads one employer: US tech rows only, descriptions for fresh unread ones, newest plain titles first', async () => {
  const w = world({
    acme: {
      jobs: [
        posting('Senior Software Engineer', '/job/Austin-TX/Senior_R1'),
        posting('Software Engineer', '/job/Austin-TX/SWE_R2', 'Posted 3 Days Ago'),
        posting('Software Engineer', '/job/Austin-TX/Known_R3'),
        posting('Store Associate', '/job/Austin-TX/Store_R4'),
        posting('Software Engineer', '/job/Bangalore/Blr_R5', 'Posted Today', 'Bangalore, India'),
        posting('Data Engineer', '/job/Austin-TX/Old_R6', 'Posted 30+ Days Ago'),
        posting('ML Engineer', '/job/Reston-VA/Multi_R7', 'Posted Yesterday', '2 Locations'),
      ],
    },
  });
  const request = W.requester(w.fetch, w.sleep, w.clock);
  const known = 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin-TX/Known_R3';
  const rows = await W.collectTenant(acme, { request, described: { [known]: NOW }, now: new Date(NOW) });

  assert.deepEqual(rows.map((r) => r.external_id).sort(), ['/job/Austin-TX/Known_R3', '/job/Austin-TX/SWE_R2', '/job/Austin-TX/Senior_R1', '/job/Reston-VA/Multi_R7']);
  const details = w.calls.filter((c) => c.method === 'GET').map((c) => c.url.split('/').pop());
  assert.deepEqual(details, ['Multi_R7', 'SWE_R2', 'Senior_R1'], 'plain titles before senior ones, newest first; the known one is skipped');
  const multi = rows.find((r) => /Multi_R7/.test(r.apply_url));
  assert.equal(multi.location, 'Reston, VA');
  assert.equal(multi.company_name, 'Acme');
  assert.match(multi.description, /Multi_R7/);
  assert.equal(rows.find((r) => r.apply_url === known).description, '');
  assert.equal(rows.find((r) => /SWE_R2/.test(r.apply_url)).date_posted.slice(0, 10), '2026-11-21');
});

test('no more than one request a second', async () => {
  const w = world({ acme: { jobs: Array.from({ length: 45 }, (_, i) => posting('Software Engineer', `/job/Austin-TX/R${i}`)) } });
  await W.collectTenant(acme, { request: W.requester(w.fetch, w.sleep, w.clock) });
  for (let i = 1; i < w.calls.length; i++) assert.ok(w.calls[i].at - w.calls[i - 1].at >= W.GAP_MS);
});

test('a big employer is searched, not listed in full', async () => {
  const w = world({
    acme: {
      total: 2000,
      jobs: [posting('Nurse', '/job/Austin-TX/N1')],
      search: { 'software engineer': [posting('Software Engineer', '/job/Austin-TX/S1')] },
    },
  });
  const rows = await W.collectTenant(acme, { request: W.requester(w.fetch, w.sleep, w.clock) });
  assert.deepEqual(rows.map((r) => r.external_id), ['/job/Austin-TX/S1']);
  assert.equal(w.calls.filter((c) => c.method === 'POST').length, 8, 'one page to learn the size, then seven searches');
});

test('a run goes employer by employer across ticks, sends rows, and finishes', async () => {
  const boards = {};
  const tenants = [];
  for (let i = 0; i < 4; i++) {
    const name = `co${i}`;
    tenants.push({ slug: name, displayName: `Co ${i}`, tenant: name, wd: '1', site: 'Jobs' });
    boards[name] = { jobs: Array.from({ length: 15 }, (_, k) => posting('Software Engineer', `/job/Austin-TX/${name}_${k}`)) };
  }
  const w = world(boards);
  const sent = [];
  const storage = store();
  const deps = {
    storage,
    clock: w.clock,
    sleep: w.sleep,
    fetch: async (url, init) => (url.endsWith('workday-tenants.json') ? json({ tenants }) : w.fetch(url, init)),
    tenantsUrl: 'https://board.example/downloads/workday-tenants.json',
    post: async (rows) => (sent.push(rows), { inserted: rows.length, updated: 0, rejected: 0 }),
  };
  assert.equal(await W.start(deps), 4);
  let ticks = 0;
  let result = {};
  while (!result.done && ticks < 10) {
    result = await W.tick(deps);
    ticks++;
    w.advance(60_000);
  }
  assert.ok(result.done);
  assert.ok(ticks > 1, 'took more than one tick');
  assert.equal(result.summary.ok, 4);
  assert.equal(result.summary.found, 60);
  assert.equal(result.summary.inserted, 60);
  assert.equal(result.summary.stoppedFor, '');
  assert.equal(sent.flat().length, 60);
  assert.equal(storage.data.workdayRun, undefined);
  assert.equal(Object.keys(storage.data.workdayDescribed).length, 60);

  // The next run reads no descriptions again.
  const before = w.calls.length;
  await W.start(deps);
  result = {};
  while (!result.done) {
    result = await W.tick(deps);
    w.advance(60_000);
  }
  assert.equal(w.calls.slice(before).filter((c) => c.method === 'GET' && !c.url.endsWith('.json')).length, 0);
});

test('the first 429 ends the run; rows already read are still sent', async () => {
  const tenants = [acme, { ...acme, slug: 'beta', tenant: 'beta' }];
  const jobs = [posting('Software Engineer', '/job/Austin-TX/A1')];
  const w = world({ acme: { jobs }, beta: { jobs } }, { blockAfter: 2 });
  const sent = [];
  const deps = {
    storage: store(),
    clock: w.clock,
    sleep: w.sleep,
    fetch: async (url, init) => (url.endsWith('.json') ? json({ tenants }) : w.fetch(url, init)),
    tenantsUrl: 'https://board.example/downloads/workday-tenants.json',
    post: async (rows) => (sent.push(...rows), { inserted: rows.length }),
  };
  await W.start(deps);
  const callsAtStart = w.calls.length;
  const result = await W.tick(deps);
  assert.ok(result.done);
  assert.match(result.summary.stoppedFor, /429/);
  assert.equal(result.summary.ok, 1);
  assert.equal(sent.length, 1, "acme's row went out");
  assert.equal(w.calls.length - callsAtStart, 3, 'no request after the 429');
});

test('a web page instead of data counts as a block', async () => {
  const w = world({ acme: { jobs: [] } }, { html: true });
  await assert.rejects(W.collectTenant(acme, { request: W.requester(w.fetch, w.sleep, w.clock) }), W.Blocked);
});

test('a second tick while one is running does nothing', async () => {
  const storage = store({ workdayRun: { tenants: [acme], index: 0 }, workdayTickUntil: NOW + 60_000 });
  const result = await W.tick({ storage, clock: () => NOW });
  assert.deepEqual(result, { busy: true });
});
