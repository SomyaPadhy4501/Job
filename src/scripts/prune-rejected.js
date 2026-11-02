'use strict';

// Remove stored rows that today's collect-time filters would reject — the
// role, level and US-location checks in normalizeJob. Rules get tightened
// (e.g. "CNC Programmer" stopped counting as software, 2026-10-31), but rows
// collected under the old rules stay until the retention sweep; this clears
// them now.
//
// Usage (dry run by default — prints counts and the rows per reason):
//   node src/scripts/prune-rejected.js
//   DATABASE_URL=... node src/scripts/prune-rejected.js --apply

const { classifyRole, passesLevel, looksUS, inUS, US_STATES } = require('../services/normalize');
const { CONFIG } = require('../config');

const APPLY = process.argv.includes('--apply');
const USE_PG = !!process.env.DATABASE_URL;
const LIST_MAX = 100; // rows printed per reason

// ISO 3166-1 alpha-2 codes that can't be read as a US state: the full list
// minus the US, its territories and every code shared with a state (IN, IL,
// CA, CO, DE, GA, …). Those shared ones are exactly what can't be settled from
// the string alone.
const ISO2 = (
  'ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ' +
  'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ' +
  'ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ' +
  'ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt ' +
  'mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw ' +
  'sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug ' +
  'um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'
).split(' ');
const US_CODES = new Set([...US_STATES, 'us', 'pr', 'gu', 'vi', 'as', 'mp', 'um']);
const FOREIGN_ONLY_ISO2 = new Set(ISO2.filter((c) => !US_CODES.has(c)));

// Rows keep only the joined location string, not the `countries` a collector
// now passes to normalizeJob (see inUS in normalize.js). For the two sources
// whose string format still carries the answer, read it back here, so rows
// collected before countries existed are judged the way new ones are:
//   microsoft / pcsx — since mid-2026 "City, Region, CC" entries or a bare
//     "CC", joined; a part that is exactly "US" means a US entry. A bare code
//     is a country-wide posting: Microsoft rows stored as "IN" (India) had
//     passed as Indiana. Earlier rows read "Redmond, WA" with no country at
//     all, so a trailing code only counts as foreign when no state shares it;
//     "Mountain View, CA" is left to looksUS.
//   getro — US entries read "City, ST, USA", "State, USA" or "United States".
//     When every US entry is a bare state and the rest is abroad, the state is
//     Getro's geocoder misreading an Indian state code ("Tennessee, USA" for
//     Chennai, TN) — see countriesOf in src/collectors/getro.js.
// undefined means the string doesn't settle it, and looksUS decides.
function storedCountries({ source, location }) {
  const parts = String(location || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (source === 'microsoft' || source === 'pcsx') {
    if (parts.includes('US')) return ['US'];
    const code = (parts[parts.length - 1] || '').toLowerCase();
    if (!/^[A-Z]{2}$/.test(parts[parts.length - 1] || '')) return undefined;
    if (parts.length === 1 && ISO2.includes(code)) return ['abroad'];
    return FOREIGN_ONLY_ISO2.has(code) ? ['abroad'] : undefined;
  }
  if (source === 'getro') {
    const usAt = parts.flatMap((p, i) => (p === 'USA' ? [i] : []));
    if (!usAt.length || parts.some((p) => /^united states/i.test(p))) return undefined;
    // A state code before "USA" is a city entry ("Austin, TX, USA"): a real US place.
    if (usAt.some((i) => /^[A-Z]{2}$/.test(parts[i - 1] || ''))) return undefined;
    const rest = parts.filter((_, i) => !usAt.includes(i) && !usAt.includes(i + 1)).join(', ');
    return rest && !looksUS(rest) ? ['abroad'] : undefined;
  }
  return undefined;
}

function reason(row) {
  if (CONFIG.filterSoftwareOnly && classifyRole(row.job_title) === 'OTHER') return 'not a software role';
  if (!passesLevel(row.job_title, CONFIG.entryLevelMode || 'permissive')) return 'senior / intern / supervisor';
  if (CONFIG.filterUSOnly && !inUS(row.location, storedCountries(row))) return 'not US';
  return null;
}

async function main() {
  let rows;
  let del;
  let close = () => {};
  const SELECT = 'SELECT id, source, company_name, job_title, location FROM jobs';
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
    for (const r of list.slice(0, LIST_MAX)) {
      console.log(`      #${r.id} ${r.source} | ${r.company_name} | ${r.job_title} | ${r.location || ''}`);
    }
    if (list.length > LIST_MAX) console.log(`      … and ${list.length - LIST_MAX} more`);
  }
  if (!APPLY) console.log('Dry run. Re-run with --apply to delete them.');
  else if (doomed.length) {
    await del(doomed);
    console.log(`Deleted ${doomed.length} rows.`);
  }
  await close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('prune-rejected failed:', err.message);
    process.exit(1);
  });
}

module.exports = { reason, storedCountries };
