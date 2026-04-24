'use strict';

const { buildDedupeKey } = require('./normalize');

// In-memory dedupe for a single collection pass. The DB upsert also relies on
// the UNIQUE constraint on dedupe_key as the authoritative cross-run dedupe.
function dedupeBatch(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.dedupe_key || buildDedupeKey(row.company_name, row.job_title, row.location);
    if (!seen.has(key)) seen.set(key, row);
  }
  return Array.from(seen.values());
}

module.exports = { dedupeBatch };
