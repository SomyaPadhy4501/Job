'use strict';

// Security checks for the Node job API (src/api/server.js): the /admin token,
// query limits on the public routes, and errors that never leak details.
// The database module is replaced with a fake, so no SQLite build is needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const calls = { queryJobs: [], bulkUpsert: 0, collect: 0 };
const fakeDb = {
  queryJobs: async (q) => {
    calls.queryJobs.push(q);
    if (q.search === 'explode') throw new Error('relation "secret_table" does not exist');
    return { total: 0, rows: [] };
  },
  queryCompanies: async () => ({ total: 0, rows: [] }),
  queryNewestJobs: async () => [],
  getJobById: async () => null,
  statsSummary: async () => ({}),
  upsertJob: async () => ({}),
  bulkUpsert: async (rows) => {
    calls.bulkUpsert++;
    if (rows.some((r) => r.company_name === 'Explode Inc')) throw new Error('duplicate key value violates "jobs_pkey"');
    return { inserted: rows.length, updated: 0 };
  },
};
require.cache[require.resolve('../src/db')] = { id: 'db', filename: 'db', loaded: true, exports: fakeDb };
require.cache[require.resolve('../src/services/collect')] = {
  id: 'collect', filename: 'collect', loaded: true,
  exports: { collectAll: async () => { calls.collect++; return { ok: 1 }; } },
};

const { createApp } = require('../src/api/server');

async function withServer(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const job = (company = 'Acme') => ({
  company_name: company,
  job_title: 'Software Engineer, New Grad',
  location: 'Austin, TX',
  apply_url: `https://boards.greenhouse.io/${company.toLowerCase().replace(/\W/g, '')}/jobs/1`,
});
const post = (base, path, token, body = { source: 'test', jobs: [job()] }) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-collect-token': token } : {}) },
    body: JSON.stringify(body),
  });

test('admin: the right token works, a wrong or missing one is refused', async () => {
  await withServer({ COLLECT_TOKEN: 'correct-horse-battery-staple', VERCEL: undefined }, async (base) => {
    for (const path of ['/admin/ingest', '/admin/collect']) {
      assert.equal((await post(base, path)).status, 401, `${path} without a token`);
      assert.equal((await post(base, path, 'wrong')).status, 401, `${path} with a wrong token`);
      assert.equal((await post(base, path, 'correct-horse-battery-stapl')).status, 401, `${path} with a prefix`);
      assert.equal((await post(base, path, 'correct-horse-battery-staple')).status, 200, `${path} with the token`);
    }
  });
});

test('admin: with no token configured, production refuses everyone', async () => {
  const before = calls.collect;
  await withServer({ COLLECT_TOKEN: undefined, VERCEL: '1' }, async (base) => {
    assert.equal((await post(base, '/admin/ingest')).status, 503);
    assert.equal((await post(base, '/admin/collect')).status, 503);
  });
  await withServer({ COLLECT_TOKEN: undefined, VERCEL: undefined, NODE_ENV: 'production' }, async (base) => {
    assert.equal((await post(base, '/admin/collect')).status, 503);
  });
  assert.equal(calls.collect, before, 'no collect run started');
});

test('admin: with no token configured, a local dev server still takes local requests', async () => {
  await withServer({ COLLECT_TOKEN: undefined, VERCEL: undefined, NODE_ENV: undefined }, async (base) => {
    assert.equal((await post(base, '/admin/ingest')).status, 200);
  });
});

test('admin: a failed ingest says nothing about the database', async () => {
  await withServer({ COLLECT_TOKEN: 'correct-horse-battery-staple' }, async (base) => {
    const res = await post(base, '/admin/ingest', 'correct-horse-battery-staple', { source: 'test', jobs: [job('Explode Inc')] });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.doesNotMatch(text, /jobs_pkey|duplicate key/);
  });
});

test('public: absurd paging and long filters are capped, not passed to the database', async () => {
  await withServer({}, async (base) => {
    calls.queryJobs.length = 0;
    const res = await fetch(`${base}/jobs?page=1e400&limit=99999&search=${'a'.repeat(5000)}&source=${'b'.repeat(5000)}`);
    assert.equal(res.status, 200);
    const q = calls.queryJobs.at(-1);
    assert.ok(Number.isSafeInteger(q.offset) && q.offset <= 200 * 1000, `offset ${q.offset}`);
    assert.ok(q.limit <= 200);
    assert.ok(q.search.length <= 200 && q.source.length <= 200);
    const body = await res.json();
    assert.ok(Number.isSafeInteger(body.pagination.page));
  });
});

test('public: a database error is a 500 without details, and the server keeps serving', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/jobs?search=explode`);
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /secret_table/);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});
