'use strict';

// IBM collector (src/collectors/ibm.js): field mapping and paging against a
// fake www-api.ibm.com/search/api/v2. No network. Hit shapes are trimmed
// copies of real responses from 2026-11-24.

const test = require('node:test');
const assert = require('node:assert');

const ibm = require('../src/collectors/ibm');
const { resetRateLimits } = require('../src/collectors/http');
const { normalizeJob } = require('../src/services/normalize');

function hit(src) {
  return { _index: 'genesis-prod-1', _id: `h${src.field_text_01}`, _score: null, _source: src };
}

const MULTI_CITY = hit({
  url: 'https://careers.ibm.com/careers/JobDetail?jobId=138780',
  dcdate: '2026-11-23',
  title: 'Software Developer',
  field_keyword_05: 'United States',
  field_keyword_08: 'Software Engineering',
  field_keyword_17: 'Hybrid',
  field_keyword_18: 'Professional',
  field_keyword_19: 'Multiple Cities',
  field_keyword_21: ['Raleigh', 'POUGHKEEPSIE', 'RESEARCH TRIANGLE PARK'],
  field_text_01: 138780,
});

const ENTRY = hit({
  url: 'https://careers.ibm.com/careers/JobDetail?jobId=145974',
  dcdate: '2026-11-20',
  title: 'Entry Level Software Developer 2027',
  field_keyword_05: 'United States',
  field_keyword_08: 'Software Engineering',
  field_keyword_17: 'Hybrid',
  field_keyword_18: 'Entry Level',
  field_keyword_19: 'SAN JOSE, US',
  field_text_01: 145974,
});

const NOT_SOFTWARE = hit({
  url: 'https://careers.ibm.com/careers/JobDetail?jobId=144041',
  dcdate: '2026-11-18',
  title: 'Project Manager-Hybrid Cloud Manage',
  field_keyword_05: 'United States',
  field_keyword_08: 'Project Management',
  field_keyword_17: 'Hybrid',
  field_keyword_18: 'Professional',
  field_keyword_19: 'Dallas, US',
  field_text_01: 144041,
});

test('ibm: mapHit reads jobId, date, cities and the entry-level tag', () => {
  const row = ibm.mapHit(MULTI_CITY, 'IBM');
  assert.deepStrictEqual(row, {
    source: 'ibm',
    external_id: '138780',
    company_name: 'IBM',
    job_title: 'Software Developer',
    location: 'Raleigh, Poughkeepsie, Research Triangle Park, United States',
    countries: ['US'],
    apply_url: 'https://careers.ibm.com/careers/JobDetail?jobId=138780',
    description: '',
    date_posted: '2026-11-23',
  });
  assert.strictEqual(row.entry_level_override, undefined, '"Professional" must not force a level');

  const entry = ibm.mapHit(ENTRY, 'IBM');
  assert.strictEqual(entry.entry_level_override, 1);
  // No city list: the single "CITY, US" string stands in.
  assert.strictEqual(entry.location, 'San Jose, United States');
});

test('ibm: location falls back to Remote, and jobId to the url', () => {
  assert.strictEqual(
    ibm.locationOf({ field_keyword_05: 'United States', field_keyword_17: 'Remote', field_keyword_19: 'Multiple Cities' }),
    'Remote, United States',
  );
  assert.strictEqual(
    ibm.locationOf({ field_keyword_05: 'United States', field_keyword_19: 'Multiple Cities' }),
    'United States',
  );
  const row = ibm.mapHit(hit({ ...ENTRY._source, field_text_01: undefined }), 'IBM');
  assert.strictEqual(row.external_id, '145974');
  assert.strictEqual(ibm.mapHit(hit({ field_text_01: 1 }), 'IBM'), null, 'no title, no row');
});

test('ibm: the listing filters to the US and drops internships server-side', () => {
  const body = ibm.listBody(2);
  assert.strictEqual(body.appId, 'careers');
  assert.deepStrictEqual(body.scopes, ['careers2']);
  assert.strictEqual(body.size, 100, 'the API rejects size > 100');
  assert.strictEqual(body.from, 200);
  assert.deepStrictEqual(body.query.bool.filter[0], { terms: { field_keyword_05: ['United States'] } });
  assert.deepStrictEqual(body.query.bool.must_not, [{ terms: { field_keyword_18: ['Internship'] } }]);
  assert.deepStrictEqual(body.sort, [{ dcdate: 'desc' }]);
  // `_source` is whitelisted server-side; one unknown name 400s the request.
  assert.ok(body._source.includes('field_keyword_21') && !body._source.includes('body'));

  assert.deepStrictEqual(ibm.bodyLookup(['138780', '145974']).query.bool.filter, [
    { terms: { field_text_01: [138780, 145974] } },
  ]);
});

function fakeApi({ pages, bodies, failBodies = false, failFirstPage = false }) {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.strictEqual(url, 'https://www-api.ibm.com/search/api/v2');
    assert.strictEqual(init.method, 'POST');
    const req = JSON.parse(init.body);
    const ids = req.query.bool.filter.find((f) => f.terms?.field_text_01)?.terms.field_text_01;
    if (ids) {
      calls.push({ kind: 'body', ids });
      if (failBodies) return new Response('', { status: 404 });
      const hits = ids.filter((id) => bodies[id]).map((id) => hit({ field_text_01: id, body: bodies[id] }));
      return Response.json({ hits: { total: { value: hits.length }, hits } });
    }
    calls.push({ kind: 'list', from: req.from });
    if (failFirstPage) return new Response('', { status: 404 });
    const total = pages.reduce((n, p) => n + p.length, 0);
    const page = pages[req.from / req.size] || [];
    return Response.json({ hits: { total: { value: total, relation: 'eq' }, hits: page } });
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test('ibm: fetchCompany pages, dedupes, keeps software titles and adds bodies', async () => {
  resetRateLimits();
  // A full first page forces a second; the job repeated across pages (an index
  // refresh mid-run) must come out once.
  const filler = Array.from({ length: 98 }, (_, i) =>
    hit({ ...NOT_SOFTWARE._source, field_text_01: 200000 + i, url: `https://careers.ibm.com/careers/JobDetail?jobId=${200000 + i}` }));
  const pages = [[MULTI_CITY, ENTRY, ...filler], [ENTRY, NOT_SOFTWARE]];
  const api = fakeApi({
    pages,
    bodies: { 138780: 'Build cloud automation in Go and Python. '.repeat(20), 145974: 'Join as a new graduate.' },
  });
  let rows;
  try {
    rows = await ibm.fetchCompany({ displayName: 'IBM' });
  } finally {
    api.restore();
  }

  assert.deepStrictEqual(api.calls.filter((c) => c.kind === 'list').map((c) => c.from), [0, 100]);
  assert.deepStrictEqual(rows.map((r) => r.external_id).sort(), ['138780', '145974']);
  // Only titles that pass the software check get a body request.
  assert.deepStrictEqual(api.calls.filter((c) => c.kind === 'body'), [{ kind: 'body', ids: [138780, 145974] }]);
  const dev = rows.find((r) => r.external_id === '138780');
  assert.match(dev.description, /^Build cloud automation/);

  const n = normalizeJob(dev, { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'off' });
  assert.ok(n, 'a mapped row passes the US + software filters');
  assert.strictEqual(n.location, dev.location);
});

test('ibm: a failed first page fails the company; a failed body batch does not', async () => {
  resetRateLimits();
  let api = fakeApi({ pages: [], bodies: {}, failFirstPage: true });
  try {
    await assert.rejects(ibm.fetchCompany({ displayName: 'IBM' }), /Not found/);
  } finally {
    api.restore();
  }

  resetRateLimits();
  api = fakeApi({ pages: [[MULTI_CITY]], bodies: {}, failBodies: true });
  let rows;
  try {
    rows = await ibm.fetchCompany({ displayName: 'IBM' });
  } finally {
    api.restore();
  }
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].description, '');
});
