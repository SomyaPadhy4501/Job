'use strict';

// A re-fetch that comes back without a description must not erase the one already
// stored. Workday and Microsoft rate-limit, and Workday only fetches JDs for the
// first 80 postings per run, so empty re-fetches of rows that already have text
// are routine. Before this guard the UPDATE overwrote description with '' and
// recomputed sponsorship from nothing, so a stored "will not sponsor" went back to
// a USCIS-driven YES (and a stored CLEARANCE / NO_SPONSORSHIP restriction
// vanished) on the next run. Runs the real SQLite upsert on a throwaway file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upsert-description-'));
process.env.DB_PATH = path.join(dir, 'jobs.db');
delete process.env.DATABASE_URL;

const { upsertJob, getDb } = require('../src/db/sqlite');

function job(extra = {}) {
  return {
    dedupe_key: 'paypal|sr software engineer|austin',
    source: 'workday',
    external_id: 'R0138200',
    company_name: 'PayPal',
    job_title: 'Sr Software Engineer',
    location: 'Austin, TX',
    apply_url: 'https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/Austin/R0138200',
    description: '',
    date_posted: new Date().toISOString(),
    sponsorship: 'YES',
    role_type: 'SWE',
    is_entry_level: 0,
    is_mid_level: 1,
    category: '',
    restriction: '',
    yoe_min: -1,
    ...extra,
  };
}

const stored = (key) =>
  getDb()
    .prepare('SELECT description, sponsorship, restriction, yoe_min, is_mid_level FROM jobs WHERE dedupe_key = ?')
    .get(key);

test('an empty re-fetch keeps the stored description and what was derived from it', () => {
  const described = job({
    dedupe_key: 'keep-1',
    apply_url: 'https://example.com/keep-1',
    description: 'Visa Sponsorship through PayPal is not available for this position.',
    sponsorship: 'NO',
    restriction: 'NO_SPONSORSHIP',
    yoe_min: 5,
  });
  upsertJob(described);

  // Next run: detail fetch was rate-limited, so the collector sends no text and
  // the classifier — seeing only a title and "PayPal" — says YES.
  upsertJob({ ...described, description: '', sponsorship: 'YES', restriction: '', yoe_min: -1 });

  const row = stored('keep-1');
  assert.match(row.description, /not available for this position/);
  assert.strictEqual(row.sponsorship, 'NO');
  assert.strictEqual(row.restriction, 'NO_SPONSORSHIP');
  assert.strictEqual(row.yoe_min, 5);
});

test('a new, non-empty description still replaces the stored one', () => {
  const first = job({
    dedupe_key: 'replace-1',
    apply_url: 'https://example.com/replace-1',
    description: 'Old text.',
    sponsorship: 'YES',
  });
  upsertJob(first);
  upsertJob({ ...first, description: 'We will not sponsor visas.', sponsorship: 'NO', restriction: 'NO_SPONSORSHIP' });

  const row = stored('replace-1');
  assert.strictEqual(row.description, 'We will not sponsor visas.');
  assert.strictEqual(row.sponsorship, 'NO');
  assert.strictEqual(row.restriction, 'NO_SPONSORSHIP');
});

test('a row that never had a description still updates freely', () => {
  const bare = job({ dedupe_key: 'bare-1', apply_url: 'https://example.com/bare-1', description: '', sponsorship: 'UNKNOWN' });
  upsertJob(bare);
  // e.g. the USCIS table gained the company, so the rule-based verdict changed.
  upsertJob({ ...bare, sponsorship: 'YES' });

  assert.strictEqual(stored('bare-1').sponsorship, 'YES');
});
