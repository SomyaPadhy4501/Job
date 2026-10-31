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

// In-memory dedupe for a single collection pass, on two keys: the
// company|title|location key, and the canonical apply link (same posting under
// different URLs or titles — see canonicalUrl). The DB upsert also matches on
// dedupe_key and apply_url as the cross-run dedupe.
function dedupeBatch(rows) {
  const byKey = new Map();
  const byUrl = new Map();
  const keep = new Set();
  for (const row of rows) {
    const key = row.dedupe_key || buildDedupeKey(row.company_name, row.job_title, row.location);
    const url = canonicalUrl(row.apply_url);
    const rival = byKey.get(key) || byUrl.get(url);
    if (rival && quality(rival) >= quality(row)) continue;
    if (rival) keep.delete(rival);
    keep.add(row);
    byKey.set(key, row);
    byUrl.set(url, row);
  }
  return rows.filter((r) => keep.has(r));
}

module.exports = { dedupeBatch, quality };
