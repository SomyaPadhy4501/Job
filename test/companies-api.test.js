'use strict';

// /companies — the grouped-by-company view. Runs the real Express app on a
// throwaway SQLite file so the SQL (GROUP BY, the shared WHERE builder, the
// single-role inline job) is exercised end to end.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companies-api-'));
process.env.DB_PATH = path.join(dir, 'jobs.db');
delete process.env.DATABASE_URL;

const { bulkUpsert } = require('../src/db');
const { createApp } = require('../src/api/server');

const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
function job(company, title, n, extra = {}) {
  return {
    dedupe_key: `${company}|${title}|`.toLowerCase(),
    source: 'test',
    external_id: `${company}-${title}`,
    company_name: company,
    job_title: title,
    location: 'Austin, TX',
    apply_url: `https://example.com/${encodeURIComponent(company)}/${encodeURIComponent(title)}`,
    description: '',
    date_posted: day(n),
    sponsorship: 'YES',
    role_type: 'SWE',
    is_entry_level: 1,
    is_mid_level: 0,
    category: '',
    restriction: '',
    yoe_min: -1,
    ...extra,
  };
}

test('groups by company, newest first, with the single role inlined', async (t) => {
  await bulkUpsert([
    job('Acme', 'Software Engineer', 1),
    job('Acme', 'Data Engineer', 5),
    job('Acme', 'ML Engineer', 3),
    job('Solo', 'Backend Engineer', 2),
    job('Hidden Co', 'Software Engineer', 0, { restriction: 'DEFENSE_EMPLOYER' }),
    job('Maybe Co', 'Software Engineer', 0, { sponsorship: 'UNKNOWN' }),
  ]);

  const server = createApp().listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const body = await (await fetch(`${base}/companies?sponsorship=YES`)).json();
  // Hidden Co: restricted (hidden by default). Maybe Co: filtered by YES.
  assert.deepStrictEqual(body.data.map((r) => [r.company_name, r.roles]), [['Acme', 3], ['Solo', 1]]);
  assert.strictEqual(body.pagination.total, 2);
  assert.strictEqual(body.data[0].sponsors, true);
  assert.strictEqual(body.data[0].job, undefined);
  assert.strictEqual(body.data[1].job.job_title, 'Backend Engineer');

  // Expanding a group reuses /jobs?company= with the same filters.
  const acme = await (await fetch(`${base}/jobs?company=Acme&sponsorship=YES`)).json();
  assert.deepStrictEqual(acme.data.map((r) => r.job_title), ['Software Engineer', 'ML Engineer', 'Data Engineer']);

  const any = await (await fetch(`${base}/companies`)).json();
  assert.ok(any.data.some((r) => r.company_name === 'Maybe Co'));
  assert.ok(!any.data.some((r) => r.company_name === 'Hidden Co'));
});
