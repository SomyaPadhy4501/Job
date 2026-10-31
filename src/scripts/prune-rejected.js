'use strict';

// Remove stored rows that today's collect-time filters would reject — the
// role, level and US-location checks in normalizeJob. Rules get tightened
// (e.g. "CNC Programmer" stopped counting as software, 2026-10-31), but rows
// collected under the old rules stay until the retention sweep; this clears
// them now.
//
// Usage (dry run by default — prints counts and sample titles per reason):
//   node src/scripts/prune-rejected.js
//   DATABASE_URL=... node src/scripts/prune-rejected.js --apply

const { classifyRole, passesLevel, looksUS } = require('../services/normalize');
const { CONFIG } = require('../config');

const APPLY = process.argv.includes('--apply');
const USE_PG = !!process.env.DATABASE_URL;

function reason(row) {
  if (CONFIG.filterSoftwareOnly && classifyRole(row.job_title) === 'OTHER') return 'not a software role';
  if (!passesLevel(row.job_title, CONFIG.entryLevelMode || 'permissive')) return 'senior / intern / supervisor';
  if (CONFIG.filterUSOnly && !looksUS(row.location)) return 'not US';
  return null;
}

async function main() {
  let rows;
  let del;
  let close = () => {};
  const SELECT = 'SELECT id, job_title, location FROM jobs';
  if (USE_PG) {
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 2,
    });
    rows = (await pool.query(SELECT)).rows;
    del = (ids) => pool.query('DELETE FROM jobs WHERE id = ANY($1)', [ids]);
    close = () => pool.end();
  } else {
    // eslint-disable-next-line global-require
    const { getDb } = require('../db/sqlite');
    const db = getDb();
    rows = db.prepare(SELECT).all();
    const stmt = db.prepare('DELETE FROM jobs WHERE id = ?');
    del = (ids) => db.transaction((list) => list.forEach((id) => stmt.run(id)))(ids);
  }

  const byReason = new Map();
  for (const r of rows) {
    const why = reason(r);
    if (!why) continue;
    if (!byReason.has(why)) byReason.set(why, []);
    byReason.get(why).push(r);
  }
  const doomed = [...byReason.values()].flat().map((r) => r.id);
  console.log(`Scanned ${rows.length} rows; ${doomed.length} fail today's collect filters.`);
  for (const [why, list] of byReason) {
    console.log(`  ${why}: ${list.length}`);
    for (const r of list.slice(0, 6)) console.log(`      ${r.job_title} | ${r.location || ''}`);
  }
  if (!APPLY) console.log('Dry run. Re-run with --apply to delete them.');
  else if (doomed.length) {
    await del(doomed);
    console.log(`Deleted ${doomed.length} rows.`);
  }
  await close();
}

main().catch((err) => {
  console.error('prune-rejected failed:', err.message);
  process.exit(1);
});
