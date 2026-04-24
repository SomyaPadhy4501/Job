'use strict';

const path = require('path');
const express = require('express');
const { CONFIG } = require('../config');
const { queryJobs, getJobById, statsSummary, upsertJob, getDb } = require('../db');
const { jobsCache } = require('./cache');
const { collectAll } = require('../services/collect');
const { normalizeJob } = require('../services/normalize');
const log = require('../logger');

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

  app.get('/stats', (_req, res) => {
    res.json(statsSummary());
  });

  app.get('/jobs', (req, res) => {
    const search = (req.query.search || '').toString().trim();
    const sponsorshipRaw = (req.query.sponsorship || '').toString().toUpperCase();
    const company = (req.query.company || '').toString().trim();
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

    const limit = Math.min(
      CONFIG.maxPageSize,
      Math.max(1, Number(req.query.limit) || CONFIG.defaultPageSize)
    );
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const cacheKey = JSON.stringify({ search, sponsorship, company, role, level, limit, offset });
    const cached = jobsCache.get(cacheKey);
    if (cached) {
      res.setHeader('x-cache', 'HIT');
      return res.json(cached);
    }

    const { total, rows } = queryJobs({
      search, sponsorship, company, role, level, limit, offset,
    });
    const body = {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: { search, sponsorship, company, role, level },
    };

    jobsCache.set(cacheKey, body);
    res.setHeader('x-cache', 'MISS');
    res.json(body);
  });

  app.get('/jobs/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = getJobById(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });

  // Ingest a batch of jobs from an external collector (e.g. the Playwright
  // scraper microservice). Body shape:
  //   { source: "google" | "meta" | ..., jobs: [ <raw-job-shape> ] }
  // Each job runs through the same normalize/dedupe/upsert pipeline as our
  // in-process collectors. Token-protected via COLLECT_TOKEN if set.
  app.post('/admin/ingest', (req, res) => {
    const expected = process.env.COLLECT_TOKEN;
    if (expected) {
      const given = req.get('x-collect-token');
      if (given !== expected) return res.status(401).json({ error: 'Unauthorized' });
    }

    const { source, jobs } = req.body || {};
    if (!source || !Array.isArray(jobs)) {
      return res.status(400).json({ error: 'Body must be { source: string, jobs: [...] }' });
    }
    if (jobs.length > 10_000) {
      return res.status(413).json({ error: 'Too many jobs in one ingest (max 10000)' });
    }

    let inserted = 0, updated = 0, rejected = 0;
    const db = getDb();
    const tx = db.transaction((rows) => {
      for (const raw of rows) {
        const n = normalizeJob(
          { ...raw, source },
          {
            filterUSOnly: CONFIG.filterUSOnly,
            filterSoftwareOnly: CONFIG.filterSoftwareOnly,
            entryLevelMode: CONFIG.entryLevelMode,
          }
        );
        if (!n) { rejected++; continue; }
        const r = upsertJob(n);
        inserted += r.inserted;
        updated += r.updated;
      }
    });

    try {
      tx(jobs);
      jobsCache.clear();
      log.info('ingest.ok', { source, received: jobs.length, inserted, updated, rejected });
      res.json({ ok: true, source, received: jobs.length, inserted, updated, rejected });
    } catch (err) {
      log.error('ingest.error', { source, error: err.message });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // On-demand trigger (protected by a shared token if COLLECT_TOKEN is set).
  app.post('/admin/collect', async (req, res) => {
    const expected = process.env.COLLECT_TOKEN;
    if (expected) {
      const given = req.get('x-collect-token');
      if (given !== expected) return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await collectAll();
      jobsCache.clear();
      res.json({ ok: true, result });
    } catch (err) {
      log.error('collect.error', { error: err.message });
      res.status(500).json({ ok: false, error: err.message });
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
