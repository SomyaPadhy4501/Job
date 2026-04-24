'use strict';

const { CONFIG } = require('./config');
const { newContext, closeBrowser } = require('./browser');
const { getTarget } = require('./targets');
const { ingest } = require('./ingest');
const log = require('./logger');

// Scrape a single target, ingest its rows. Failure in one target never throws
// out of this function — it's always logged and returned in the result.
async function runOneTarget(slug) {
  const target = getTarget(slug);
  if (!target) return { slug, ok: false, error: 'unknown target' };

  const started = Date.now();
  let context;
  try {
    context = await newContext();
    const rows = await target.run(context);
    log.info('target.scraped', { slug, rows: rows.length, ms: Date.now() - started });

    if (!rows.length) {
      return { slug, ok: true, rows: 0, inserted: 0, updated: 0, rejected: 0, ms: Date.now() - started };
    }
    const result = await ingest(target.source, rows);
    return {
      slug,
      ok: true,
      rows: rows.length,
      inserted: result.inserted,
      updated: result.updated,
      rejected: result.rejected,
      ms: Date.now() - started,
    };
  } catch (err) {
    log.error('target.failed', { slug, error: err.message });
    return { slug, ok: false, error: err.message, ms: Date.now() - started };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// Run all configured targets sequentially — running them in parallel would
// exhaust memory on a laptop (each Chromium context is heavy).
async function runAll({ targets = CONFIG.targets } = {}) {
  const started = Date.now();
  log.info('run.start', { targets });
  const results = [];
  for (const slug of targets) {
    const r = await runOneTarget(slug);
    results.push(r);
  }
  const totalInserted = results.reduce((a, b) => a + (b.inserted || 0), 0);
  const totalUpdated = results.reduce((a, b) => a + (b.updated || 0), 0);
  log.info('run.done', {
    seconds: Math.round((Date.now() - started) / 1000),
    totalInserted,
    totalUpdated,
    targets: results.map((r) => ({ [r.slug]: r.ok ? `${r.rows || 0} rows` : `FAIL: ${r.error}` })),
  });
  return results;
}

module.exports = { runAll, runOneTarget };

// Graceful shutdown hook when imported into a scheduler.
async function shutdown() { await closeBrowser(); }
process.on('SIGINT',  () => shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));
