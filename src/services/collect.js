'use strict';

const { SCHEDULED_COMPANIES, CONFIG } = require('../config');
const { getCollector } = require('../collectors');
const { normalizeJob, parseDateToIso, stripTracking } = require('./normalize');
const { dedupeBatch } = require('./dedupe');
const { closableScopes, seenUrlsOf, planClosures } = require('./closed');
const {
  bulkUpsert,
  startRun,
  finishRun,
  pruneStaleJobs,
  deleteByApplyUrls,
  jobsForCompanies,
  recordMisses,
  describedApplyUrls,
  storedTags,
} = require('../db');
const aiTagger = require('./ai-tagger');
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

// Closed postings (src/services/closed.js). Runs after the upsert, so this
// run's sightings are already in last_seen_at. Returns the rows deleted.
async function closeMissing(results, since, runId) {
  const seenUrls = seenUrlsOf(results);
  const bySource = new Map();
  for (const s of closableScopes(results, getCollector)) {
    if (!bySource.has(s.source)) bySource.set(s.source, []);
    bySource.get(s.source).push(s.company_name);
  }

  const plan = { reset: [], missed: [], closed: [] };
  try {
    for (const [source, names] of bySource) {
      const byName = new Map(names.map((n) => [n, []]));
      for (const row of await jobsForCompanies(source, names)) byName.get(row.company_name)?.push(row);
      for (const [name, rows] of byName) {
        const p = planClosures(rows, { seenUrls, since });
        if (p.suspicious) {
          log.warn('closed.suspicious', { runId, source, company: name, stored: rows.length });
          continue;
        }
        plan.reset.push(...p.reset);
        plan.missed.push(...p.missed);
        plan.closed.push(...p.closed);
      }
    }
    const closed = await recordMisses(plan, since);
    log.info('collection.closed', { runId, missed: plan.missed.length, closed });
    return closed;
  } catch (err) {
    // The column comes from migrations/006_missed_runs.sql, which the owner
    // applies by hand; until then this step is skipped, not the run failed.
    if (err.code === '42703' || /no such column: missed_runs/.test(err.message)) {
      log.warn('closed.skipped', { runId, reason: 'missed_runs column missing; run migrations/006_missed_runs.sql' });
      return 0;
    }
    throw err;
  }
}

async function collectAll({ companies = SCHEDULED_COMPANIES } = {}) {
  // The Postgres store is async and the SQLite one isn't; await works for both.
  // Without it the run id was a Promise, and prune / finishRun raced the
  // process exit in GitHub Actions.
  const runId = await startRun();
  const started = Date.now();
  // Taken before any fetch: a row updated after this was seen during the run.
  const since = new Date(started).toISOString();
  log.info('collection.start', { runId, companies: companies.length });

  // Each source gets its own pool, all running at once. One shared pool of 4
  // stopped scaling once Workday grew past a few dozen tenants — and tenants
  // live on separate hosts, so they can safely run wider — while sources that
  // rate-limit by IP across every tenant (Getro, Eightfold) must stay narrow
  // however many entries they have.
  // Workday counts every request against one limit per IP, and reading each
  // posting's description costs one. Jobs whose description is already stored
  // are skipped: on 2026-11-24 re-reading them every run helped push 255 of
  // 256 Workday employers into HTTP 429.
  let workdayDescribed = new Set();
  if (companies.some((c) => c.source === 'workday')) {
    try {
      workdayDescribed = await describedApplyUrls('workday');
    } catch (err) {
      log.warn('collection.described_lookup_failed', { runId, error: err.message });
    }
  }

  const bySource = new Map();
  for (const c of companies) {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push(c.source === 'workday' ? { ...c, described: workdayDescribed } : c);
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

  // AI tagging (src/services/ai-tagger.js): the model replaces the rule-based
  // role and sponsorship on new or changed postings before they are saved.
  // Skipped inside Vercel functions (/admin/collect), which can't wait on a
  // model for minutes. Never fails the collect: on any problem the rule tags
  // computed by normalizeJob are saved, as they always were.
  let tags;
  if (aiTagger.enabled() && !process.env.VERCEL) {
    try {
      const options = require('./model-options').modelOptions();
      const limit = Number(process.env.AI_TAG_LIMIT || 150);
      const minutes = Number(process.env.AI_TAG_MINUTES || 15);
      tags = await aiTagger.tagJobs(deduped, {
        lookup: storedTags,
        options,
        limit: Number.isFinite(limit) && limit >= 0 ? limit : 150,
        deadline: Date.now() + (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000,
        onError: (job, err) => log.debug('tags.error', { url: job.apply_url, error: err.message }),
        onTag: (job, rules, tag) => log.debug('tags.verdict', {
          title: job.job_title, company: job.company_name,
          role: `${rules.role_type}->${job.role_type}`, sponsorship: `${rules.sponsorship}->${job.sponsorship}`,
          specialty: tag.specialty, reason: tag.reason, quote: tag.quote,
        }),
      });
      log.info('tags.review', { runId, model: options.model, ...tags });
      if (tags.unavailable) log.warn('tags.unavailable', { runId, note: 'model unreachable; remaining new postings keep their rule tags' });
    } catch (err) {
      log.error('tags.failed', { runId, error: err.message });
    }
  }

  // Bulk upsert in a single transaction (works for both SQLite and Postgres).
  const { inserted, updated, failed = 0 } = await bulkUpsert(deduped);
  if (failed > 0) log.warn('collection.rows_failed', { runId, failed });

  // Retention sweep: delete rows older than the retention window. Hits both
  // dated rows that slipped past normalize (e.g. curated lists that re-publish
  // stale items) and null-dated rows whose last_seen_at has aged out (source
  // stopped listing them — role filled or pulled).
  const expired = expiredUrls.length ? await deleteByApplyUrls(expiredUrls) : 0;
  if (expired > 0) log.info('collection.expired', { runId, expired });
  const pruned = await pruneStaleJobs(CONFIG.retentionDays);
  if (pruned > 0) log.info('collection.pruned', { runId, pruned, days: CONFIG.retentionDays });

  // After the sweep, so only rows still inside retention are judged. Run
  // before it on 2026-11-24, rows already past retention (no board lists
  // them) made 107 companies look like they'd lost most of their roles.
  const closed = await closeMissing(results, since, runId);

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
    rowsFailed: failed,
    closed,
    seconds: took,
  });

  return {
    runId,
    companiesOk,
    companiesFail,
    inserted,
    updated,
    rowsFailed: failed,
    closed,
    kept: deduped.length,
    errors,
    ...(tags && { tags }),
  };
}

module.exports = { collectAll };
