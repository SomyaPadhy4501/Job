'use strict';

// One-shot cleanup: give stored Built In rows the employer's own link.
//
// Built In's links need a Built In sign-in before they reach the company site.
// The scraper now swaps them at scrape time (scraper/src/targets/builtin-
// resolve.js); this applies the same lookup to rows stored before that.
//
// For each stored row whose link is on builtin.com, the posting is looked up
// first among the rows already stored from the employer (Workday rows from the
// extension, Greenhouse, Oracle, ...: no network), then on the employer's
// board, unless --stored-only (the step after each scrape). When found:
//   - another row already holds that link (the employer's own collector
//     stored it): this row is a duplicate and is deleted;
//   - otherwise: only apply_url changes. Location, description and dedupe_key
//     stay as they are (dedupe_key is UNIQUE, so rewriting it could collide).
//     The next scrape finds the row by its new link and refreshes the rest.
// Rows it can't find keep their Built In link.
//
// Usage (safe, dry-run by default):
//   node src/scripts/fix-builtin-links.js                    # local SQLite
//   DATABASE_URL=... node src/scripts/fix-builtin-links.js --apply
//   DATABASE_URL=... node src/scripts/fix-builtin-links.js --apply --stored-only

const { canonicalUrl } = require('../services/normalize');
const { resolveOriginalLinks, matchStored } = require('../../scraper/src/targets/builtin-resolve');

const APPLY = process.argv.includes('--apply');
const STORED_ONLY = process.argv.includes('--stored-only');
const USE_PG = !!process.env.DATABASE_URL;

const BUILTIN_LINK = /^https?:\/\/(www\.)?builtin\.com\/job\//i;

// stored:   every row, { id, apply_url } at least.
// resolved: the Built In rows after resolveOriginalLinks, same order as
//           the Built In rows in `stored`, each still carrying its id.
// Returns { updates: [{ id, apply_url }], deletes: [id] }.
function plan(stored, resolved) {
  const owner = new Map(); // canonical link -> id of a row that has it
  for (const r of stored) {
    if (!BUILTIN_LINK.test(r.apply_url)) owner.set(canonicalUrl(r.apply_url), r.id);
  }
  const updates = [];
  const deletes = [];
  for (const r of resolved) {
    if (BUILTIN_LINK.test(r.apply_url)) continue; // not found
    const key = canonicalUrl(r.apply_url);
    if (owner.has(key)) {
      deletes.push(r.id);
    } else {
      updates.push({ id: r.id, apply_url: r.apply_url });
      owner.set(key, r.id); // two Built In rows resolving to one posting: keep one
    }
  }
  return { updates, deletes };
}

const SELECT = 'SELECT id, company_name, job_title, location, apply_url FROM jobs';

async function main() {
  let rows;
  let write;
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
    write = async ({ updates, deletes }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (deletes.length) await client.query('DELETE FROM jobs WHERE id = ANY($1)', [deletes]);
        for (const u of updates) {
          // eslint-disable-next-line no-await-in-loop
          await client.query('UPDATE jobs SET apply_url = $1 WHERE id = $2', [u.apply_url, u.id]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };
    close = () => pool.end();
  } else {
    // eslint-disable-next-line global-require
    const { getDb } = require('../db/sqlite');
    const db = getDb();
    rows = db.prepare(SELECT).all();
    const del = db.prepare('DELETE FROM jobs WHERE id = ?');
    const upd = db.prepare('UPDATE jobs SET apply_url = ? WHERE id = ?');
    write = async ({ updates, deletes }) =>
      db.transaction(() => {
        deletes.forEach((id) => del.run(id));
        updates.forEach((u) => upd.run(u.apply_url, u.id));
      })();
  }

  const builtin = rows.filter((r) => BUILTIN_LINK.test(r.apply_url));
  const fromStored = matchStored(builtin, rows.filter((r) => !BUILTIN_LINK.test(r.apply_url)));
  const viaStored = builtin.map((r) => (fromStored.has(r) ? { ...r, apply_url: fromStored.get(r).apply_url } : r));
  // The network lookup runs alone, so it can take most of the workflow's 20
  // minutes, not the scraper's 4. Rows not reached keep their link; run it
  // again for the rest.
  const left = viaStored.filter((r) => BUILTIN_LINK.test(r.apply_url));
  const looked = STORED_ONLY
    ? left
    : await resolveOriginalLinks(left.map((r) => ({ ...r, description: '' })), { budgetMs: 15 * 60_000 });
  const resolved = [...viaStored.filter((r) => !BUILTIN_LINK.test(r.apply_url)), ...looked];
  const p = plan(rows, resolved);

  console.log(
    `Matched ${fromStored.size} to a row we already store from the employer` +
      (STORED_ONLY ? ' (stored rows only).' : '.')
  );
  console.log(
    `Scanned ${rows.length} rows; ${builtin.length} link to Built In. ` +
      `Found the employer's posting for ${p.updates.length + p.deletes.length}: ` +
      `${p.updates.length} get the employer's link, ${p.deletes.length} duplicate a row that already has it. ` +
      `${builtin.length - p.updates.length - p.deletes.length} keep their Built In link.`
  );
  for (const u of p.updates.slice(0, 20)) console.log(`  update #${u.id} -> ${u.apply_url}`);
  if (!APPLY) {
    console.log('Dry run. Re-run with --apply to write these changes.');
  } else if (p.updates.length || p.deletes.length) {
    await write(p);
    console.log(`Updated ${p.updates.length} links, deleted ${p.deletes.length} duplicate rows.`);
  }
  await close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('fix-builtin-links failed:', err.message);
    process.exit(1);
  });
}

module.exports = { plan };
