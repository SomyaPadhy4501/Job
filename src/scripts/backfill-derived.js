'use strict';

// One-shot backfill: recompute the fields derived from a posting's text —
// `restriction` (clearance / ITAR / citizenship) and `yoe_min` plus the
// is_entry_level / is_mid_level flags it drives — and update rows that changed.
//
// Usage (safe, dry-run by default):
//   node src/scripts/backfill-derived.js                  # local SQLite
//   node src/scripts/backfill-derived.js --apply
//   DATABASE_URL=... node src/scripts/backfill-derived.js # Neon
//   DATABASE_URL=... node src/scripts/backfill-derived.js --apply
//
// Backend routing mirrors src/db/index.js: DATABASE_URL present -> Postgres,
// otherwise SQLite. Unlike reclassify-sponsorship.js this handles both, because
// the dry run is the main safety mechanism and you want to preview against
// local data before pointing it at production.
//
// SQLite also self-heals via the boot pass in src/db/sqlite.js, so this script
// is strictly required only for Postgres, which has no programmatic migration.
//
// Idempotent: every field here is a pure function of job_title + description,
// neither of which this script writes. Re-running always converges, so a bad
// pattern set is fixed by correcting it and running again — no restore needed.

const { classifyRestriction } = require('../services/clearance');
const { extractExperience, levelFromYears } = require('../services/experience');
const { stripHtml } = require('../services/normalize');

const APPLY = process.argv.includes('--apply');
const USE_PG = !!process.env.DATABASE_URL;
const BATCH = 500; // description is the heavy column — don't load it all at once

// Matches the boot pass in src/db/sqlite.js exactly. classifyRestriction
// re-normalizes internally, but feeding it the identical input here means the
// two code paths cannot silently diverge.
function textFor(row) {
  return `${row.job_title || ''}\n${stripHtml(row.description || '')}`;
}

// Compute every derived field for one row. Level flags are only overwritten
// when the description actually states a number — otherwise the collector's
// value (which may come from a curated source override) is left alone.
function derive(row) {
  const text = textFor(row);
  const years = extractExperience(text);
  const lvl = levelFromYears(years);
  return {
    restriction: classifyRestriction(text),
    yoe_min: years ? years.min : -1,
    is_entry_level: lvl ? lvl.is_entry_level : row.is_entry_level,
    is_mid_level: lvl ? lvl.is_mid_level : row.is_mid_level,
  };
}

function changed(row, next) {
  return (
    next.restriction !== (row.restriction || '') ||
    next.yoe_min !== row.yoe_min ||
    next.is_entry_level !== row.is_entry_level ||
    next.is_mid_level !== row.is_mid_level
  );
}

function report(rows, toUpdate, transitions, started) {
  console.log(`Scanned ${rows} rows.`);
  console.log(`\nProposed transitions (${toUpdate} rows):`);
  if (transitions.size === 0) {
    console.log('  (none)');
    return;
  }
  for (const [k, v] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(34)} ${v}`);
  }
  const blocking = [...transitions.entries()]
    .filter(([k]) => /->(CLEARANCE|EXPORT_CONTROL|CITIZENSHIP)$/.test(k))
    .reduce((n, [, v]) => n + v, 0);
  console.log(`\n  will be hidden by default: ${blocking}`);
  console.log(`  elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function runPg() {
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 3,
  });

  const started = Date.now();
  const transitions = new Map();
  const toUpdate = [];
  let scanned = 0;

  try {
    for (let offset = 0; ; offset += BATCH) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        `SELECT id, job_title, description, restriction, yoe_min,
                is_entry_level, is_mid_level
           FROM jobs ORDER BY id LIMIT $1 OFFSET $2`,
        [BATCH, offset],
      );
      if (rows.length === 0) break;
      scanned += rows.length;
      for (const r of rows) {
        const next = derive(r);
        if (!changed(r, next)) continue;
        const cur = r.restriction || '';
        if (next.restriction !== cur) {
          const key = `${cur || "''"}->${next.restriction || "''"}`;
          transitions.set(key, (transitions.get(key) || 0) + 1);
        }
        if (next.yoe_min !== r.yoe_min) {
          const key = `yoe ${r.yoe_min < 0 ? 'none' : r.yoe_min}->${next.yoe_min < 0 ? 'none' : next.yoe_min}`;
          transitions.set(key, (transitions.get(key) || 0) + 1);
        }
        toUpdate.push({ id: r.id, next });
      }
    }

    report(scanned, toUpdate.length, transitions, started);

    if (!APPLY) {
      console.log('\nDry run. Re-run with --apply to write changes.');
      return;
    }
    if (toUpdate.length === 0) {
      console.log('\nNothing to update.');
      return;
    }

    console.log(`\nApplying ${toUpdate.length} updates...`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of toUpdate) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `UPDATE jobs
              SET restriction = $1, yoe_min = $2,
                  is_entry_level = $3, is_mid_level = $4
            WHERE id = $5`,
          [u.next.restriction, u.next.yoe_min, u.next.is_entry_level, u.next.is_mid_level, u.id],
        );
      }
      await client.query('COMMIT');
      console.log(`Committed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function runSqlite() {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  // eslint-disable-next-line global-require
  const path = require('path');
  // eslint-disable-next-line global-require
  const { CONFIG } = require('../config');

  const dbPath = path.resolve(CONFIG.dbPath);
  const db = new Database(dbPath, { readonly: !APPLY });

  const cols = db.prepare('PRAGMA table_info(jobs)').all().map((r) => r.name);
  if (!cols.includes('restriction')) {
    console.error(
      'Column `restriction` does not exist yet.\n' +
        'Start the app once (npm start) — src/db/sqlite.js adds it at boot.',
    );
    process.exit(1);
  }

  const started = Date.now();
  const transitions = new Map();
  const toUpdate = [];
  let scanned = 0;

  const select = db.prepare(
    `SELECT id, job_title, description, restriction, yoe_min,
            is_entry_level, is_mid_level
       FROM jobs ORDER BY id LIMIT ? OFFSET ?`,
  );
  for (let offset = 0; ; offset += BATCH) {
    const rows = select.all(BATCH, offset);
    if (rows.length === 0) break;
    scanned += rows.length;
    for (const r of rows) {
      const next = derive(r);
      if (!changed(r, next)) continue;
      const cur = r.restriction || '';
      if (next.restriction !== cur) {
        const key = `${cur || "''"}->${next.restriction || "''"}`;
        transitions.set(key, (transitions.get(key) || 0) + 1);
      }
      if (next.yoe_min !== r.yoe_min) {
        const key = `yoe ${r.yoe_min < 0 ? 'none' : r.yoe_min}->${next.yoe_min < 0 ? 'none' : next.yoe_min}`;
        transitions.set(key, (transitions.get(key) || 0) + 1);
      }
      toUpdate.push({ id: r.id, next });
    }
  }

  report(scanned, toUpdate.length, transitions, started);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write changes.');
    db.close();
    return;
  }
  if (toUpdate.length === 0) {
    console.log('\nNothing to update.');
    db.close();
    return;
  }

  console.log(`\nApplying ${toUpdate.length} updates...`);
  const upd = db.prepare(
    `UPDATE jobs
        SET restriction = ?, yoe_min = ?, is_entry_level = ?, is_mid_level = ?
      WHERE id = ?`,
  );
  const tx = db.transaction((list) => {
    for (const u of list) {
      upd.run(u.next.restriction, u.next.yoe_min, u.next.is_entry_level, u.next.is_mid_level, u.id);
    }
  });
  tx(toUpdate);
  console.log(`Committed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  db.close();
}

(async () => {
  console.log(`Backend: ${USE_PG ? 'postgres' : 'sqlite'}${APPLY ? '' : '  (dry run)'}`);
  if (USE_PG) await runPg();
  else runSqlite();
})().catch((err) => {
  console.error('backfill-restriction failed:', err.message);
  process.exit(1);
});
