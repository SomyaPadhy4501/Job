'use strict';

// JSearch collector (src/collectors/jsearch.js). From the fix/ci-and-strict-yoe
// branch; 429 stub is a real Response, since fetchJson reads its headers.

const test = require('node:test');
const assert = require('node:assert');
const { normalizeJob } = require('../src/services/normalize');

const jsearch = require('../src/collectors/jsearch');
const { COMPANIES, SCHEDULED_COMPANIES } = require('../src/config');

// Unlike the fixtures above, this is NOT a trimmed real response: no API key
// existed when the collector was written (2026-10-21). It follows the documented
// search-v2 job schema. Replace it with a trimmed real response once one exists.
const JS_TESLA = {
  job_id: 'abc123==',
  employer_name: 'Tesla',
  job_publisher: 'LinkedIn',
  job_title: 'Software Engineer, Inference Infrastructure',
  job_apply_link: 'https://www.linkedin.com/jobs/view/4000000000',
  job_apply_is_direct: false,
  apply_options: [
    { publisher: 'LinkedIn', apply_link: 'https://www.linkedin.com/jobs/view/4000000000', is_direct: false },
    {
      publisher: 'Tesla',
      apply_link:
        'https://www.tesla.com/careers/search/job/software-engineer-inference-infrastructure-222387' +
        '?utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic',
      is_direct: true,
    },
  ],
  job_description: 'Own the systems that power model development. 2+ years of experience with Python.',
  job_posted_at_datetime_utc: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  job_city: 'Palo Alto',
  job_state: 'CA',
  job_country: 'US',
};
const JS_OPTS = { slug: 'tesla', displayName: 'Tesla', employer: 'Tesla', applyHost: 'tesla.com' };

test('jsearch: keeps the employer apply link from apply_options, minus utm tracking', () => {
  // Google lists the LinkedIn repost as the primary link here. Taking
  // job_apply_link blindly would put LinkedIn on the board.
  const row = jsearch.mapJob(JS_TESLA, JS_OPTS);
  assert.strictEqual(
    row.apply_url,
    'https://www.tesla.com/careers/search/job/software-engineer-inference-infrastructure-222387'
  );
  assert.strictEqual(row.location, 'Palo Alto, CA, US');
  assert.strictEqual(row.company_name, 'Tesla');

  const n = normalizeJob(row, { filterUSOnly: true, filterSoftwareOnly: true, retentionDays: 30 });
  assert.ok(n, 'a fresh US software posting must survive normalize');
  assert.strictEqual(n.yoe_min, 2);
});

test('jsearch: drops reposts with no employer link, agency listings and lookalike hosts', () => {
  const repostOnly = { ...JS_TESLA, apply_options: [JS_TESLA.apply_options[0]] };
  assert.strictEqual(jsearch.mapJob(repostOnly, JS_OPTS), null);

  // An agency deep-linking into tesla.com is still not Tesla's listing.
  assert.strictEqual(jsearch.mapJob({ ...JS_TESLA, employer_name: 'Acme Staffing' }, JS_OPTS), null);

  for (const host of ['https://notesla.com/job/1', 'https://tesla.com.example.net/job/1']) {
    const lookalike = { ...JS_TESLA, job_apply_link: host, apply_options: [] };
    assert.strictEqual(jsearch.mapJob(lookalike, JS_OPTS), null, host);
  }
});

test('jsearch: reads both the search-v2 and the older response shapes', () => {
  assert.strictEqual(jsearch.jobsFrom({ data: { jobs: [JS_TESLA], cursor: null } }).length, 1);
  assert.strictEqual(jsearch.jobsFrom({ data: [JS_TESLA] }).length, 1);
  assert.deepStrictEqual(jsearch.jobsFrom({ status: 'ERROR' }), []);
});

// Stubs global fetch and records every call, so the request budget is pinned:
// the free plan is 200 requests/month and every page is billed.
async function withFetch(respond, fn) {
  const realFetch = global.fetch;
  const realKey = process.env.JSEARCH_API_KEY;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: new URL(url), headers: init.headers });
    return respond(calls.length);
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.JSEARCH_API_KEY;
    else process.env.JSEARCH_API_KEY = realKey;
  }
}
const ok = (payload) => ({ status: 200, ok: true, json: async () => payload });

test('jsearch: one page per query, at most MAX_QUERIES queries, last 3 days only', async () => {
  await withFetch(() => ok({ data: { jobs: [JS_TESLA] } }), async (calls) => {
    process.env.JSEARCH_API_KEY = 'test-key';
    const queries = ['a', 'b', 'c', 'd', 'e', 'f'];
    const rows = await jsearch.fetchCompany({ ...JS_OPTS, queries });

    assert.strictEqual(calls.length, jsearch.MAX_QUERIES);
    assert.ok(jsearch.MAX_QUERIES * 31 <= 200, 'a month of daily runs must fit the free plan');
    for (const c of calls) {
      assert.strictEqual(c.url.hostname, 'jsearch.p.rapidapi.com');
      assert.strictEqual(c.url.pathname, '/search-v2');
      assert.strictEqual(c.url.searchParams.get('num_pages'), '1');
      assert.strictEqual(c.url.searchParams.get('date_posted'), '3days');
      assert.strictEqual(c.url.searchParams.get('country'), 'us');
      assert.strictEqual(c.headers['x-rapidapi-key'], 'test-key');
    }
    // The same posting from four queries is one row.
    assert.strictEqual(rows.length, 1);
  });
});

test('jsearch: no key means no requests, and a failed first query is not retried', async () => {
  await withFetch(() => ok({ data: { jobs: [] } }), async (calls) => {
    delete process.env.JSEARCH_API_KEY;
    assert.deepStrictEqual(await jsearch.fetchCompany(JS_OPTS), []);
    assert.strictEqual(calls.length, 0);
  });

  await withFetch(() => new Response('quota', { status: 429 }), async (calls) => {
    process.env.JSEARCH_API_KEY = 'test-key';
    await assert.rejects(jsearch.fetchCompany(JS_OPTS), /HTTP 429/);
    assert.strictEqual(calls.length, 1, 'a retry is another billed request');
  });
});

test('jsearch: the 2-hourly collect never runs daily-cadence entries', () => {
  const tesla = COMPANIES.find((c) => c.source === 'jsearch' && c.slug === 'tesla');
  assert.ok(tesla && tesla.applyHost === 'tesla.com' && tesla.cadence === 'daily');
  assert.ok(!SCHEDULED_COMPANIES.some((c) => c.cadence === 'daily'));
  assert.ok(!SCHEDULED_COMPANIES.some((c) => c.source === 'jsearch'));
});

// ─── Adzuna ───────────────────────────────────────────────────────────────────
