'use strict';

// One-shot backfill: re-run the sponsorship classifier against every row
// in Neon and update any whose classification has changed.
//
// Usage (safe, dry-run by default):
//   DATABASE_URL=... node src/scripts/reclassify-sponsorship.js
//   DATABASE_URL=... node src/scripts/reclassify-sponsorship.js --apply
//
// Why this exists: the h1b-sponsors lookup was missing from earlier deploys,
// so existing rows were classified UNKNOWN. Live rows self-heal on the next
// `collect` run via upsert; this script also fixes stale rows whose source
// posting has been removed.

const { Pool } = require('pg');
const { classifySponsorship } = require('../services/classifier');

const APPLY = process.argv.includes('--apply');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 3,
});

(async () => {
  const started = Date.now();
  const { rows } = await pool.query(
    'SELECT id, job_title, description, company_name, sponsorship FROM jobs',
  );
  console.log(`Scanned ${rows.length} rows.`);

  const transitions = new Map(); // "FROM->TO" -> count
  const toUpdate = [];

  for (const r of rows) {
    const text = `${r.job_title || ''}\n${r.description || ''}`;
    const next = classifySponsorship(text, r.company_name);
    if (next !== r.sponsorship) {
      const key = `${r.sponsorship}->${next}`;
      transitions.set(key, (transitions.get(key) || 0) + 1);
      toUpdate.push({ id: r.id, next });
    }
  }

  console.log(`\nProposed transitions (${toUpdate.length} rows):`);
  for (const [k, v] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write changes.');
    await pool.end();
    return;
  }

  if (toUpdate.length === 0) {
    console.log('\nNothing to update.');
    await pool.end();
    return;
  }

  console.log(`\nApplying ${toUpdate.length} updates...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of toUpdate) {
      await client.query('UPDATE jobs SET sponsorship = $1 WHERE id = $2', [
        u.next,
        u.id,
      ]);
    }
    await client.query('COMMIT');
    console.log(`Committed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error('reclassify failed:', err.message);
  process.exit(1);
});
