'use strict';

/**
 * Vercel serverless entry point.
 * Exports the Express app as a single handler so all routes (/jobs, /stats,
 * /health, /admin/*) are served by one function — no need to split.
 *
 * Static frontend (web/dist/) is served by Vercel's CDN directly; the
 * express.static() call in server.js is a no-op in this environment.
 */
const { createApp } = require('../src/api/server');

module.exports = createApp();
