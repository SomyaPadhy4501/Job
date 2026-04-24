'use strict';

// Scraper microservice config. All tunable via env so the service can be
// deployed independently of the main API (different host, different cadence).
const CONFIG = {
  // Where to POST scraped jobs.
  ingestUrl: process.env.INGEST_URL || 'http://localhost:4000/admin/ingest',
  ingestToken: process.env.COLLECT_TOKEN || '',

  // Cron cadence — every 6 hours by default (slower than the main 2h cadence
  // because each Playwright pass is heavier and more likely to get rate-limited).
  cron: process.env.SCRAPER_CRON || '30 */6 * * *',
  runOnStart: process.env.RUN_ON_START !== 'false',

  // Playwright
  headless: process.env.HEADLESS !== 'false',
  navTimeoutMs: Number(process.env.NAV_TIMEOUT_MS || 45_000),
  // Max pages / scrolls to try per site.
  maxPages: Number(process.env.MAX_PAGES || 5),
  // Between scrolls — gives the site time to fire more XHRs.
  scrollDelayMs: Number(process.env.SCROLL_DELAY_MS || 2000),
  // Per-target overall timeout. Beyond this we give up on one site and move on.
  targetTimeoutMs: Number(process.env.TARGET_TIMEOUT_MS || 120_000),

  // Comma-separated list of target slugs to run.
  // Microsoft is handled by the main service now (it has a public /api/pcsx/search
  // endpoint that doesn't need a real browser). This scraper is only for the
  // genuinely-gated sites. Set SCRAPER_TARGETS=microsoft to force it here too.
  targets: (process.env.SCRAPER_TARGETS || 'apple,meta,google,deloitte,phenom')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

module.exports = { CONFIG };
