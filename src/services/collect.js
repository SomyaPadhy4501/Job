'use strict';

const { SCHEDULED_COMPANIES, CONFIG } = require('../config');
const { getCollector } = require('../collectors');
const { normalizeJob } = require('./normalize');
const { dedupeBatch } = require('./dedupe');
const { MAX_YOE } = require('./experience');
const { refreshedSources } = require('./freshness');
const {
  bulkUpsert, startRun, finishRun, pruneStaleJobs, pruneUnseenJobs, pruneOverExperienced,
  pruneIneligible,
} = require('../db');
const { DISQUALIFYING } = require('./clearance');
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

// The default leaves out `cadence: 'daily'` entries (metered free plans — see
// SCHEDULED_COMPANIES in config.js). Pass `companies` to run those.
async function collectAll({ companies = SCHEDULED_COMPANIES } = {}) {
  // Awaited because the Postgres backend is async: unawaited, runId was a
  // Promise (logged as `"runId":{}`) and finishRun never matched a row.
  const runId = await startRun();
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

  // Bulk upsert in a single transaction (works for both SQLite and Postgres).
  const { inserted, updated } = await bulkUpsert(deduped);

  // Retention sweep: delete rows older than the retention window. Hits both
  // dated rows that slipped past normalize (e.g. curated lists that re-publish
  // stale items) and null-dated rows whose last_seen_at has aged out (source
  // stopped listing them — role filled or pulled). Awaited for the same reason
  // as startRun: collect-once exits as soon as this function returns, which cut
  // an unawaited Postgres DELETE short.
  const pruned = await pruneStaleJobs(CONFIG.retentionDays);
  if (pruned > 0) log.info('collection.pruned', { runId, pruned, days: CONFIG.retentionDays });

  // Delisting sweep: rows a source refreshed in this run no longer returns.
  // Runs after bulkUpsert, so everything this run saw already has a fresh
  // last_seen_at. Sources that failed or came back empty are left alone;
  // retired sources are swept like a source that stopped listing everything.
  const fresh = [...refreshedSources(results), ...CONFIG.retiredSources];
  const unseen = await pruneUnseenJobs(fresh, CONFIG.staleAfterDays);
  if (unseen > 0) {
    log.info('collection.pruned-unseen', {
      runId, pruned: unseen, days: CONFIG.staleAfterDays, sources: fresh.length,
    });
  }

  // Experience-ceiling sweep: rows stored before the 0-2 year ceiling existed.
  const overYoe = await pruneOverExperienced(MAX_YOE);
  if (overYoe > 0) log.info('collection.pruned-yoe', { runId, pruned: overYoe, maxYoe: MAX_YOE });

  // Eligibility sweep: rows stored before normalize dropped postings that rule
  // out an OPT / H-1B candidate.
  const ineligible = await pruneIneligible([...DISQUALIFYING]);
  if (ineligible > 0) log.info('collection.pruned-ineligible', { runId, pruned: ineligible });

  await finishRun(runId, {
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
