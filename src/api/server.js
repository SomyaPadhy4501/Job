'use strict';

const path = require('path');
const express = require('express');
const { CONFIG } = require('../config');
const { queryJobs, getJobById, statsSummary } = require('../db');
const { jobsCache } = require('./cache');
const { collectAll } = require('../services/collect');
const log = require('../logger');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

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
    const entryOnly = String(req.query.entry || '').toLowerCase() === 'true' || req.query.entry === '1';

    const VALID_ROLES = ['SWE', 'MLE', 'AI', 'DS', 'DATA_ENG', 'SRE', 'SECURITY', 'MOBILE'];
    const sponsorship = ['YES', 'NO', 'UNKNOWN'].includes(sponsorshipRaw) ? sponsorshipRaw : '';
    const role = VALID_ROLES.includes(roleRaw) ? roleRaw : '';

    const limit = Math.min(
      CONFIG.maxPageSize,
      Math.max(1, Number(req.query.limit) || CONFIG.defaultPageSize)
    );
    const page = Math.max(1, Number(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const cacheKey = JSON.stringify({ search, sponsorship, company, role, entryOnly, limit, offset });
    const cached = jobsCache.get(cacheKey);
    if (cached) {
      res.setHeader('x-cache', 'HIT');
      return res.json(cached);
    }

    const { total, rows } = queryJobs({
      search, sponsorship, company, role, entryOnly, limit, offset,
    });
    const body = {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      filters: { search, sponsorship, company, role, entryOnly },
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

  // Serve the frontend.
  const frontendDir = path.resolve(__dirname, '..', '..', 'frontend');
  app.use(express.static(frontendDir));

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
