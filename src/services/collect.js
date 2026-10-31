'use strict';

const { COMPANIES, CONFIG } = require('../config');
const { getCollector } = require('../collectors');
const { normalizeJob, parseDateToIso, stripTracking } = require('./normalize');
const { dedupeBatch } = require('./dedupe');
const { bulkUpsert, startRun, finishRun, pruneStaleJobs, deleteByApplyUrls } = require('../db');
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

  // Each source gets its own pool, all running at once. One shared pool of 4
  // stopped scaling once Workday grew past a few dozen tenants — and tenants
  // live on separate hosts, so they can safely run wider — while sources that
  // rate-limit by IP across every tenant (Getro, Eightfold) must stay narrow
  // however many entries they have.
  const bySource = new Map();
  for (const c of companies) {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push(c);
  }
  const groups = await Promise.all(
    [...bySource.entries()].map(([source, list]) =>
      runWithConcurrency(
        list,
        CONFIG.sourceConcurrency[source] || CONFIG.fetchConcurrency,
        fetchCompanySafe
      )
    )
  );
  const results = groups.flat();

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

  // Normalize + filter. Jobs a source now dates past the retention window are
  // also collected for deletion: normalize skips them, but a row stored
  // earlier under a newer-looking date would otherwise stay on the board.
  // (Greenhouse used to send updated_at, so a role first published in May
  // could read as posted today; once its real date arrived it was skipped
  // and the misleading row lingered.)
  const normalized = [];
  const expiredUrls = [];
  const cutoff = Date.now() - CONFIG.retentionDays * 86_400_000;
  for (const raw of rawJobs) {
    const posted = parseDateToIso(raw.date_posted);
    if (posted && new Date(posted).getTime() < cutoff && raw.apply_url) {
      expiredUrls.push(stripTracking(raw.apply_url));
    }
    const n = normalizeJob(raw, {
      filterUSOnly: CONFIG.filterUSOnly,
      filterSoftwareOnly: CONFIG.filterSoftwareOnly,
      entryLevelMode: CONFIG.entryLevelMode,
      retentionDays: CONFIG.retentionDays,
    });
    if (n) normalized.push(n);
  }

  const deduped = dedupeBatch(normalized);

  // Bulk upsert in a single transaction (works for both SQLite and Postgres).
  const { inserted, updated } = await bulkUpsert(deduped);

  // Retention sweep: delete rows older than the retention window. Hits both
  // dated rows that slipped past normalize (e.g. curated lists that re-publish
  // stale items) and null-dated rows whose last_seen_at has aged out (source
  // stopped listing them — role filled or pulled).
  const expired = expiredUrls.length ? await deleteByApplyUrls(expiredUrls) : 0;
  if (expired > 0) log.info('collection.expired', { runId, expired });
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
