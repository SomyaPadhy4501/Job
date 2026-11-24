'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { CONFIG } = require('../config');
const { queryJobs, queryCompanies, queryNewestJobs, getJobById, statsSummary, upsertJob, bulkUpsert } = require('../db');
const { jobsCache } = require('./cache');
const { collectAll } = require('../services/collect');
const { normalizeJob } = require('../services/normalize');
const { dedupeBatch } = require('../services/dedupe');
const log = require('../logger');

// Free-text filters longer than this are cut: nothing real is this long, and
// an unbounded value makes the LIKE scan and the cache key arbitrarily large.
const MAX_FILTER_CHARS = 200;
// Deepest page served. Past this the OFFSET is only a way to load the database.
const MAX_PAGE = 1000;

const text = (v) => String(v ?? '').trim().slice(0, MAX_FILTER_CHARS);

// Express 4 doesn't catch a rejected promise: the request hangs and Node
// exits on the unhandled rejection. Answer 500 with no details instead.
const safe = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch((err) => {
    log.error('http.error', { path: req.path, error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
  });

// The /admin routes. Deny by default: with COLLECT_TOKEN set, only a request
// carrying it (compared in constant time); without one, only a local
// development server answering a request from this machine.
function adminAllowed(req) {
  const expected = process.env.COLLECT_TOKEN;
  if (expected) {
    const given = String(req.get('x-collect-token') || '');
    const digest = (s) => crypto.createHash('sha256').update(s).digest();
    return crypto.timingSafeEqual(digest(given), digest(expected)) ? 'ok' : 'denied';
  }
  const production = process.env.VERCEL || process.env.NODE_ENV === 'production';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return !production && local ? 'ok' : 'unconfigured';
}

function requireAdmin(req, res, next) {
  const verdict = adminAllowed(req);
  if (verdict === 'ok') return next();
  if (verdict === 'unconfigured') return res.status(503).json({ error: 'Admin routes are off: COLLECT_TOKEN is not set.' });
  return res.status(401).json({ error: 'Unauthorized' });
}

// Filter parsing shared by /jobs and /companies, so the grouped view and the
// flat list always apply the same filters.
function parseFilters(req) {
  const search = text(req.query.search);
  const title = text(req.query.title);
  const sponsorshipRaw = (req.query.sponsorship || '').toString().toUpperCase();
  const company = text(req.query.company);
  const roleRaw = (req.query.role || '').toString().toUpperCase();
  const levelRaw = (req.query.level || '').toString().toLowerCase();

  // Back-compat: old clients pass ?entry=true; map it to level=entry.
  const entryLegacy =
    String(req.query.entry || '').toLowerCase() === 'true' || req.query.entry === '1';

  const VALID_ROLES = ['SWE', 'MLE', 'AI', 'DS', 'DATA_ENG', 'SRE', 'SECURITY', 'MOBILE'];
  const VALID_LEVELS = ['entry', 'mid', 'early'];
  const sponsorship = ['YES', 'NO', 'UNKNOWN'].includes(sponsorshipRaw) ? sponsorshipRaw : '';
  const role = VALID_ROLES.includes(roleRaw) ? roleRaw : '';
  const level = VALID_LEVELS.includes(levelRaw) ? levelRaw : entryLegacy ? 'entry' : '';
  // Source filter — only let through sources we actually have. Pulled live
  // from the DB rather than hardcoded so new collectors become filterable
  // without a second edit.
  const source = text(req.query.source);

  // Restriction filter — fail CLOSED, unlike the sponsorship whitelist above.
  // An unrecognised `sponsorship` value degrading to "no filter" only widens
  // results, which is harmless. Doing the same here would SHOW clearance and
  // citizens-only roles, which is precisely what this filter exists to
  // prevent — so both the default and the fallback are 'hide'.
  const restrictionRaw = (req.query.restriction || '').toString().toLowerCase();
  const restriction = ['hide', 'all', 'only'].includes(restrictionRaw) ? restrictionRaw : 'hide';

  return { search, title, sponsorship, company, role, level, source, restriction };
}

function parsePage(req) {
  const limit = Math.min(
    CONFIG.maxPageSize,
    Math.max(1, Math.floor(Number(req.query.limit)) || CONFIG.defaultPageSize)
  );
  const page = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(req.query.page)) || 1));
  return { limit, page, offset: (page - 1) * limit };
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // 8MB ceiling — a full Playwright scrape of 4 big sites rarely exceeds 2-3MB JSON.
  app.use(express.json({ limit: '8mb' }));

  // Request log.
  app.use((req, _res, next) => {
    log.debug('http', { method: req.method, url: req.url });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.get('/stats', safe(async (_req, res) => {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.json(await statsSummary());
  }));

  app.get('/jobs', safe(async (req, res) => {
    const { search, title, sponsorship, company, role, level, source, restriction } = parseFilters(req);
    const { limit, page, offset } = parsePage(req);

    // `restriction` MUST be in the cache key — without it a hide= request and
    // an all= request collide and serve each other's bodies for the 30s TTL,
    // and the Vercel edge would pin the wrong one publicly.
    const cacheKey = JSON.stringify({ search, title, sponsorship, company, role, level, source, restriction, limit, offset });
    const cached = jobsCache.get(cacheKey);
    if (cached) {
      res.setHeader('x-cache', 'HIT');
      return res.json(cached);
    }

    const { total, rows } = await queryJobs({
      search, title, sponsorship, company, role, level, source, restriction, limit, offset,
    });
    const body = {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: { search, title, sponsorship, company, role, level, source, restriction },
    };

    jobsCache.set(cacheKey, body);
    res.setHeader('x-cache', 'MISS');
    // Vercel edge cache: serve fresh for 30 s, then stale while revalidating.
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.json(body);
  }));

  // Grouped view: one row per company with its matching role count. The UI
  // expands a company by calling /jobs?company=<name> with the same filters.
  app.get('/companies', safe(async (req, res) => {
    const filters = parseFilters(req);
    const { limit, page, offset } = parsePage(req);
    const cacheKey = JSON.stringify({ route: 'companies', ...filters, limit, offset });
    const cached = jobsCache.get(cacheKey);
    if (cached) {
      res.setHeader('x-cache', 'HIT');
      return res.json(cached);
    }
    const { total, rows } = await queryCompanies({ ...filters, limit, offset });
    // Every company row carries its newest matching job: a single-role
    // company shows it as the row, and a group shows it in its header so the
    // newest posting is visible without expanding. One extra query per page.
    const newest = await queryNewestJobs(filters, rows.map((r) => r.company_name));
    const byCompany = new Map(newest.map(({ rn, ...j }) => [j.company_name, j]));
    for (const r of rows) {
      r.newest = byCompany.get(r.company_name) || null;
      if (r.roles === 1) r.job = r.newest; // kept for older clients
    }
    const body = {
      data: rows,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      filters,
    };
    jobsCache.set(cacheKey, body);
    res.setHeader('x-cache', 'MISS');
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.json(body);
  }));

  app.get('/jobs/:id', safe(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await getJobById(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  }));

  // Ingest a batch of jobs from an external collector (e.g. the Playwright
  // scraper microservice). Body shape:
  //   { source: "google" | "meta" | ..., jobs: [ <raw-job-shape> ] }
  // Each job runs through the same normalize/dedupe/upsert pipeline as our
  // in-process collectors. Needs COLLECT_TOKEN (see requireAdmin).
  app.post('/admin/ingest', requireAdmin, async (req, res) => {

    const { source, jobs } = req.body || {};
    if (!source || !Array.isArray(jobs)) {
      return res.status(400).json({ error: 'Body must be { source: string, jobs: [...] }' });
    }
    if (jobs.length > 10_000) {
      return res.status(413).json({ error: 'Too many jobs in one ingest (max 10000)' });
    }

    let inserted = 0, updated = 0, rejected = 0;
    const toUpsert = [];
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
      if (!n) { rejected++; continue; }
      toUpsert.push(n);
    }

    try {
      // The same in-batch dedupe a collect run applies: one copy per posting,
      // and separate openings that share a title and location kept apart.
      // Without it the upsert merged a batch's same-key rows into one.
      const result = await bulkUpsert(dedupeBatch(toUpsert));
      inserted = result.inserted;
      updated = result.updated;
      jobsCache.clear();
      log.info('ingest.ok', { source, received: jobs.length, inserted, updated, rejected });
      res.json({ ok: true, source, received: jobs.length, inserted, updated, rejected });
    } catch (err) {
      log.error('ingest.error', { source, error: err.message });
      res.status(500).json({ ok: false, error: 'Ingest failed. See the server log.' });
    }
  });

  // On-demand trigger. Needs COLLECT_TOKEN (see requireAdmin).
  app.post('/admin/collect', requireAdmin, async (req, res) => {
    try {
      const result = await collectAll();
      jobsCache.clear();
      res.json({ ok: true, result });
    } catch (err) {
      log.error('collect.error', { error: err.message });
      res.status(500).json({ ok: false, error: 'Collect failed. See the server log.' });
    }
  });

  // Serve the React UI built at web/dist/. run-all.sh builds it when web/src
  // is newer than the bundle; for raw `npm start`, run `cd web && npm run build`
  // first.
  const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  app.use(express.static(webDist));

  return app;
}

function startApi() {
  const app = createApp();
  app.listen(CONFIG.port, () => {
    log.info('api.listening', { port: CONFIG.port, url: `http://localhost:${CONFIG.port}` });
  });
  return app;
}

module.exports = { createApp, startApi };
