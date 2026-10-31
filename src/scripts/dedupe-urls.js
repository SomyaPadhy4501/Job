'use strict';

// One-shot cleanup: remove rows that are the same posting under a different
// apply link (tracking parameters, "www.", trailing slash) or that arrived
// from two sources. Collect-time dedupe (src/services/dedupe.js) now prevents
// new ones; this clears the ones already stored.
//
// Usage (safe, dry-run by default):
//   node src/scripts/dedupe-urls.js                    # local SQLite
//   DATABASE_URL=... node src/scripts/dedupe-urls.js --apply
//
// Within each group of rows sharing a canonical link, the survivor is the
// highest-quality row (has a description, comes from the employer's own ATS —
// see quality() in dedupe.js), oldest first_seen_at breaking ties so a job
// keeps its original "first seen" date.

const { canonicalUrl } = require('../services/normalize');
const { quality } = require('../services/dedupe');

const APPLY = process.argv.includes('--apply');
const USE_PG = !!process.env.DATABASE_URL;

function plan(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = canonicalUrl(r.apply_url);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const doomed = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) =>
        quality({ ...b, description: b.has_desc }) - quality({ ...a, description: a.has_desc }) ||
        String(a.first_seen_at).localeCompare(String(b.first_seen_at))
    );
    doomed.push(...list.slice(1).map((r) => r.id));
  }
  return doomed;
}

const SELECT = `SELECT id, apply_url, source, first_seen_at,
                       (description IS NOT NULL AND description <> '') AS has_desc
                  FROM jobs`;

async function main() {
  let rows;
  let del;
  let close = () => {};
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
    rows = db.prepare(SELECT).all().map((r) => ({ ...r, has_desc: !!r.has_desc }));
    const stmt = db.prepare('DELETE FROM jobs WHERE id = ?');
    del = (ids) => db.transaction((list) => list.forEach((id) => stmt.run(id)))(ids);
  }

  const doomed = plan(rows);
  console.log(`Scanned ${rows.length} rows; ${doomed.length} are duplicates of another row's apply link.`);
  if (!APPLY) {
    console.log('Dry run. Re-run with --apply to delete them.');
  } else if (doomed.length) {
    await del(doomed);
    console.log(`Deleted ${doomed.length} duplicate rows.`);
  }
  await close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('dedupe-urls failed:', err.message);
    process.exit(1);
  });
}

module.exports = { plan };
