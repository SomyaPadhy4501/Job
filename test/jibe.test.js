'use strict';

// Jibe career sites (src/collectors/jibe.js). The network is stubbed: each test
// serves fixture pages for {baseUrl}/api/jobs and records the requests made.

const test = require('node:test');
const assert = require('node:assert');
const jibe = require('../src/collectors/jibe');
const { normalizeJob } = require('../src/services/normalize');

const BASE = 'https://careers.example.com';
const COMPANY = { source: 'jibe', slug: 'example', displayName: 'Example Corp', baseUrl: `${BASE}/` };

// A US posting shaped like careers.amd.com's (2026-11-23).
const posting = (id, extra = {}) => ({
  slug: String(id),
  req_id: String(id),
  title: 'Software Engineer',
  description: '<p>Build developer tools.</p>',
  responsibilities: 'Ship code.',
  qualifications: "Bachelor's degree in Computer Science.",
  city: 'Santa Clara',
  state: 'California',
  country: 'United States',
  country_code: 'US',
  full_location: 'Santa Clara, California',
  multipleLocations: false,
  posted_date: '2026-11-20T13:10:00+0000',
  hiring_organization: 'Example Corporation, Inc',
  apply_url: `https://example.icims.com/jobs/${id}/login`,
  meta_data: { canonical_url: `${BASE}/jobs/${id}?lang=en-us` },
  ...extra,
});

function stubFetch(t, serve) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const body = serve(u);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

const page = (ids, totalCount) => ({ totalCount, count: totalCount, jobs: ids.map((id) => ({ data: posting(id) })) });

test('jibe: maps a posting to a row, linking the employer\'s own job page', () => {
  const row = jibe.mapJob(posting(97910), COMPANY);
  assert.strictEqual(row.source, 'jibe');
  assert.strictEqual(row.external_id, '97910');
  assert.strictEqual(row.company_name, 'Example Corp');
  assert.strictEqual(row.location, 'Santa Clara, California');
  assert.deepStrictEqual(row.countries, ['US']);
  assert.strictEqual(row.apply_url, `${BASE}/jobs/97910?lang=en-us`, 'not the ATS login link');
  assert.match(row.description, /developer tools[\s\S]*Ship code[\s\S]*Computer Science/);
  assert.strictEqual(new Date(row.date_posted).toISOString(), '2026-11-20T13:10:00.000Z');
});

test('jibe: several locations leave the country to the location text; a missing link is built', () => {
  const row = jibe.mapJob(posting(5, { multipleLocations: true, full_location: 'Austin, Texas; Markham, Ontario', meta_data: {} }), COMPANY);
  assert.strictEqual(row.countries, undefined);
  assert.strictEqual(row.location, 'Austin, Texas; Markham, Ontario');
  assert.strictEqual(row.apply_url, `${BASE}/jobs/5`);
});

test('jibe: a small catalogue is listed in full, newest first', async (t) => {
  const ids = Array.from({ length: 150 }, (_, i) => 1000 + i);
  const calls = stubFetch(t, (u) => {
    const p = Number(u.searchParams.get('page'));
    return page(ids.slice((p - 1) * 100, p * 100), ids.length);
  });
  const rows = await jibe.fetchCompany(COMPANY);
  assert.strictEqual(rows.length, 150);
  assert.deepStrictEqual(calls.map((u) => u.searchParams.get('page')), ['1', '2']);
  for (const u of calls) {
    assert.strictEqual(u.origin + u.pathname, `${BASE}/api/jobs`);
    assert.strictEqual(u.searchParams.get('sortBy'), 'posted_date');
    assert.strictEqual(u.searchParams.get('descending'), 'true');
    assert.strictEqual(u.searchParams.get('internal'), 'false');
    assert.strictEqual(u.searchParams.get('keywords'), null);
  }
});

test('jibe: a large catalogue is searched by keyword, one row per posting', async (t) => {
  const calls = stubFetch(t, (u) => {
    const kw = u.searchParams.get('keywords');
    if (!kw) return page([1], jibe.FULL_LIST_MAX + 1);
    // Searches overlap: posting 7 matches both "software" and "developer".
    return page(kw === 'software' ? [7, 8] : kw === 'developer' ? [7, 9] : [], 2);
  });
  const rows = await jibe.fetchCompany({ ...COMPANY, searches: ['software', 'developer', 'data'] });
  assert.deepStrictEqual(rows.map((r) => r.external_id).sort(), ['7', '8', '9']);
  assert.deepStrictEqual(calls.map((u) => u.searchParams.get('keywords')), [null, 'software', 'developer', 'data']);
});

test('jibe: a posting that refuses sponsorship reads NO and is hidden by default', () => {
  // AMD's wording (2026-11-23), against 1,260 USCIS approvals.
  const row = jibe.mapJob(
    posting(92605, { description: '<p>Full-stack role.</p><p>This role is not eligible for visa sponsorship</p>' }),
    { ...COMPANY, displayName: 'AMD' }
  );
  const n = normalizeJob(row, { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'permissive', retentionDays: 3650 });
  assert.ok(n);
  assert.strictEqual(n.sponsorship, 'NO');
  assert.strictEqual(n.restriction, 'NO_SPONSORSHIP');
});
