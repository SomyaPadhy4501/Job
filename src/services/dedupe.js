'use strict';

const { buildDedupeKey, canonicalUrl } = require('./normalize');

// Sources that relay other sites' postings. When the same job arrives from one
// of these and from the employer's own ATS, the direct copy wins: its link is
// the real one and it usually carries a description.
const AGGREGATORS = new Set(['ghlistings', 'mdtable', 'getro', 'builtin', 'adzuna', 'hn_hiring', 'extension']);

// Higher is better: a description to classify beats none, direct beats relayed.
function quality(row) {
  return (row.description ? 2 : 0) + (AGGREGATORS.has(row.source) ? 0 : 1);
}

function keyOf(row) {
  return row.dedupe_key || buildDedupeKey(row.company_name, row.job_title, row.location);
}

// ─── Separate openings under one key ─────────────────────────────────────────
//
// The company|title|location key exists to merge one job seen twice: relayed by
// an aggregator, or posted under a cosmetically different title. It also merged
// jobs that only look alike. Palo Alto Networks lists 20 separate "Software
// Engineer" openings at its headquarters (2026-11-23), each with its own req
// and link, and the board kept one. The owner's call (2026-11-23): show each.
//
// So when one direct source lists several openings under a key, each keeps its
// own row, keyed `<key>#<opening>`. Two rows are one opening when they share
// the source's posting id or the link: an employer with two Workday sites
// (Cadence's main and university boards) lists a req under two links but one
// id. Aggregators are left out. Getro tags the same job with a different id in
// every VC network it appears in, so their copies keep collapsing as before.

function openingId(row) {
  return row.external_id ? String(row.external_id) : canonicalUrl(row.apply_url);
}

// One source's rows under one key, grouped into openings.
function openingsOf(rows) {
  const byId = new Map();
  const byUrl = new Map();
  const openings = [];
  for (const row of rows) {
    const id = openingId(row);
    const url = canonicalUrl(row.apply_url);
    let o = byId.get(id) || byUrl.get(url);
    if (!o) {
      o = { id, rows: [] };
      openings.push(o);
    }
    o.rows.push(row);
    byId.set(id, o);
    byUrl.set(url, o);
  }
  return openings;
}

// For each key where one direct source lists several openings: the new key for
// each of its rows, and the other sources' rows to drop. Another source's copy
// whose link matches one of the openings takes that opening's key, so the
// better copy of it still wins below. The others are relays of openings already
// listed, and go. If two direct sources each list several, the one listing more
// wins (then the one with descriptions, then the first seen).
function separateOpenings(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const rekey = new Map();
  const drop = new Set();
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const bySource = new Map();
    for (const row of members) {
      if (AGGREGATORS.has(row.source)) continue;
      if (!bySource.has(row.source)) bySource.set(row.source, []);
      bySource.get(row.source).push(row);
    }
    let best = null;
    for (const list of bySource.values()) {
      const openings = openingsOf(list);
      if (openings.length < 2) continue;
      const q = Math.max(...list.map(quality));
      if (!best || openings.length > best.openings.length || (openings.length === best.openings.length && q > best.q)) {
        best = { openings, q };
      }
    }
    if (!best) continue;

    const byUrl = new Map();
    for (const o of best.openings) {
      for (const row of o.rows) {
        rekey.set(row, `${key}#${o.id}`);
        byUrl.set(canonicalUrl(row.apply_url), o);
      }
    }
    for (const row of members) {
      if (rekey.has(row)) continue;
      const o = byUrl.get(canonicalUrl(row.apply_url));
      if (o) rekey.set(row, `${key}#${o.id}`);
      else drop.add(row);
    }
  }
  return { rekey, drop };
}

// In-memory dedupe for a single collection pass, on two keys: the
// company|title|location key (split per opening, above), and the canonical
// apply link (same posting under different URLs or titles — see canonicalUrl).
// The DB upsert matches on apply_url, then dedupe_key, as the cross-run dedupe.
function dedupeBatch(rows) {
  const { rekey, drop } = separateOpenings(rows);
  const byKey = new Map();
  const byUrl = new Map();
  const keep = new Set();
  for (const row of rows) {
    if (drop.has(row)) continue;
    const key = rekey.get(row) || keyOf(row);
    const url = canonicalUrl(row.apply_url);
    const rival = byKey.get(key) || byUrl.get(url);
    if (rival && quality(rival) >= quality(row)) continue;
    if (rival) keep.delete(rival);
    keep.add(row);
    byKey.set(key, row);
    byUrl.set(url, row);
  }
  return rows
    .filter((r) => keep.has(r))
    .map((r) => (rekey.has(r) ? { ...r, dedupe_key: rekey.get(r) } : r));
}

module.exports = { dedupeBatch, quality };
