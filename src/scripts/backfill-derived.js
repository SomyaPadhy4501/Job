'use strict';

// One-shot backfill: recompute the fields derived from a posting's text —
// `sponsorship`, `restriction` (clearance / ITAR / citizenship / no-sponsorship
// / defense employer) and `yoe_min` plus the
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
// Idempotent: every field here is a pure function of job_title, description
// and company_name, none of which this script writes. Re-running always converges, so a bad
// pattern set is fixed by correcting it and running again — no restore needed.

const { deriveRestriction, DISQUALIFYING } = require('../services/clearance');
const { classifySponsorship } = require('../services/classifier');
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

// Same list as the boot pass in src/db/sqlite.js: these sources pre-label
// sponsorship and carry no description, so recomputing would discard the label.
const CURATED_SPONSORSHIP_SOURCES = ['ghlistings'];

// Compute every derived field for one row. Level flags are only overwritten
// when the description actually states a number — otherwise the collector's
// value (which may come from a curated source override) is left alone.
function derive(row) {
  const text = textFor(row);
  const years = extractExperience(text);
  const lvl = levelFromYears(years);
  const curated = CURATED_SPONSORSHIP_SOURCES.includes(row.source);
  const sponsorship = curated
    ? row.sponsorship
    : classifySponsorship(text, row.company_name);
  return {
    sponsorship,
    restriction: deriveRestriction({
      job_title: row.job_title,
      description: stripHtml(row.description || ''),
      company_name: row.company_name,
      sponsorship,
      // The curated label isn't stored separately; the stored verdict stands in.
      restriction_override: curated ? row.restriction : undefined,
    }),
    yoe_min: years ? years.min : -1,
    is_entry_level: lvl ? lvl.is_entry_level : row.is_entry_level,
    is_mid_level: lvl ? lvl.is_mid_level : row.is_mid_level,
  };
}

function changed(row, next) {
  return (
    next.sponsorship !== row.sponsorship ||
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
    .filter(([k]) => DISQUALIFYING.has(k.split('->')[1]))
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
        `SELECT id, job_title, description, company_name, source, sponsorship, restriction, yoe_min,
                is_entry_level, is_mid_level
           FROM jobs ORDER BY id LIMIT $1 OFFSET $2`,
        [BATCH, offset],
      );
      if (rows.length === 0) break;
      scanned += rows.length;
      for (const r of rows) {
        const next = derive(r);
        if (!changed(r, next)) continue;
        if (next.sponsorship !== r.sponsorship) {
          const key = `sponsorship ${r.sponsorship}->${next.sponsorship}`;
          transitions.set(key, (transitions.get(key) || 0) + 1);
        }
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
                  is_entry_level = $3, is_mid_level = $4, sponsorship = $5
            WHERE id = $6`,
          [u.next.restriction, u.next.yoe_min, u.next.is_entry_level, u.next.is_mid_level, u.next.sponsorship, u.id],
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
    `SELECT id, job_title, description, company_name, source, sponsorship, restriction, yoe_min,
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
      if (next.sponsorship !== r.sponsorship) {
        const key = `sponsorship ${r.sponsorship}->${next.sponsorship}`;
        transitions.set(key, (transitions.get(key) || 0) + 1);
      }
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
        SET restriction = ?, yoe_min = ?, is_entry_level = ?, is_mid_level = ?, sponsorship = ?
      WHERE id = ?`,
  );
  const tx = db.transaction((list) => {
    for (const u of list) {
      upd.run(u.next.restriction, u.next.yoe_min, u.next.is_entry_level, u.next.is_mid_level, u.next.sponsorship, u.id);
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
