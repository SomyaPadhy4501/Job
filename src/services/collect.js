'use strict';

const { COMPANIES, CONFIG } = require('../config');
const { getCollector } = require('../collectors');
const { normalizeJob } = require('./normalize');
const { dedupeBatch } = require('./dedupe');
const { upsertJob, startRun, finishRun, getDb, pruneStaleJobs } = require('../db');
const log = require('../logger');

async function runWithConcurrency(items, limit, worker) {
  const out = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

async function fetchCompanySafe(company) {
  const collector = getCollector(company.source);
  if (!collector) {
    return { company, ok: false, jobs: [], error: `Unknown source: ${company.source}` };
  }
  try {
    const jobs = await collector.fetchCompany(company);
    return { company, ok: true, jobs };
  } catch (err) {
    return { company, ok: false, jobs: [], error: err.message || String(err) };
  }
}

async function collectAll({ companies = COMPANIES } = {}) {
  const runId = startRun();
  const started = Date.now();
  log.info('collection.start', { runId, companies: companies.length });

  const results = await runWithConcurrency(
    companies,
    CONFIG.fetchConcurrency,
    fetchCompanySafe
  );

  const errors = [];
  let companiesOk = 0;
  let companiesFail = 0;
  const rawJobs = [];

  for (const r of results) {
    if (r.ok) {
      companiesOk++;
      log.info('collector.ok', {
        source: r.company.source,
        slug: r.company.slug,
        count: r.jobs.length,
      });
      rawJobs.push(...r.jobs);
    } else {
      companiesFail++;
      log.warn('collector.fail', {
        source: r.company.source,
        slug: r.company.slug,
        error: r.error,
      });
      errors.push({ source: r.company.source, slug: r.company.slug, error: r.error });
    }
  }

  // Normalize + filter.
  const normalized = [];
  for (const raw of rawJobs) {
    const n = normalizeJob(raw, {
      filterUSOnly: CONFIG.filterUSOnly,
      filterSoftwareOnly: CONFIG.filterSoftwareOnly,
      entryLevelMode: CONFIG.entryLevelMode,
      retentionDays: CONFIG.retentionDays,
    });
    if (n) normalized.push(n);
  }

  const deduped = dedupeBatch(normalized);

  // Bulk upsert in a single transaction.
  const db = getDb();
  let inserted = 0;
  let updated = 0;
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const r = upsertJob(row);
      inserted += r.inserted;
      updated += r.updated;
    }
  });
  tx(deduped);

  // Retention sweep: delete rows older than the retention window. Hits both
  // dated rows that slipped past normalize (e.g. curated lists that re-publish
  // stale items) and null-dated rows whose last_seen_at has aged out (source
  // stopped listing them — role filled or pulled).
  const pruned = pruneStaleJobs(CONFIG.retentionDays);
  if (pruned > 0) log.info('collection.pruned', { runId, pruned, days: CONFIG.retentionDays });

  finishRun(runId, {
    companies_ok: companiesOk,
    companies_fail: companiesFail,
    jobs_inserted: inserted,
    jobs_updated: updated,
    errors,
  });

  const took = Math.round((Date.now() - started) / 1000);
  log.info('collection.done', {
    runId,
    companiesOk,
    companiesFail,
    fetched: rawJobs.length,
    kept: deduped.length,
    inserted,
    updated,
    seconds: took,
  });

  return { runId, companiesOk, companiesFail, inserted, updated, kept: deduped.length };
}

module.exports = { collectAll };
