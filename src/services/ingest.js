'use strict';

// One batch of rows from an outside collector through the same normalize,
// dedupe and upsert a collect run applies. Used by /admin/ingest and by the
// scraper, which writes to the database itself when it has DATABASE_URL (the
// GitHub workflow), so its runs don't depend on COLLECT_TOKEN matching Vercel.

const { CONFIG } = require('../config');
const { bulkUpsert } = require('../db');
const { normalizeJob } = require('./normalize');
const { dedupeBatch } = require('./dedupe');

async function ingestRows(source, jobs) {
  let rejected = 0;
  const rows = [];
  for (const raw of jobs) {
    const n = normalizeJob(
      { ...raw, source },
      {
        filterUSOnly: CONFIG.filterUSOnly,
        filterSoftwareOnly: CONFIG.filterSoftwareOnly,
        entryLevelMode: CONFIG.entryLevelMode,
        // As in a collect run: a dated posting past the window isn't stored
        // (the scraper and the extension's Workday rows now carry dates).
        retentionDays: CONFIG.retentionDays,
      }
    );
    if (n) rows.push(n);
    else rejected++;
  }
  // The same in-batch dedupe a collect run applies: one copy per posting,
  // and separate openings that share a title and location kept apart.
  // Without it the upsert merged a batch's same-key rows into one.
  const { inserted, updated } = await bulkUpsert(dedupeBatch(rows));
  return { ok: true, source, received: jobs.length, inserted, updated, rejected };
}

module.exports = { ingestRows };
