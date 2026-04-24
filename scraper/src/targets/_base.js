'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

// Generic scrape loop: navigate, observe API responses that match, scroll to
// trigger pagination, and collect anything the extractor returns.
//
// Opts:
//   name:               target slug (for logging)
//   url:                entry URL
//   responseMatcher:    (url, method) => boolean — which XHRs to capture
//   extract:            (jsonData) => Array<rawJob>
//   scrollCount:        how many page-down/scroll iterations to do
//   preNavigate:        optional async (page) => void to run before .goto
//   postNavigate:       optional async (page) => void after first load
async function runTarget(context, opts) {
  const {
    name,
    url,
    responseMatcher,
    extract,
    scrollCount = CONFIG.maxPages,
    preNavigate,
    postNavigate,
  } = opts;

  const page = await context.newPage();
  const captured = [];
  const seen = new Set();

  page.on('response', async (res) => {
    try {
      const u = res.url();
      const m = res.request().method();
      if (!responseMatcher(u, m)) return;
      // Some endpoints return non-JSON (204, HTML error pages). Best-effort parse.
      const data = await res.json().catch(() => null);
      if (!data) return;
      const rows = extract(data);
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        const key = r.external_id || r.apply_url || r.job_title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        captured.push(r);
      }
    } catch (err) {
      log.debug('target.response-parse-fail', { name, error: err.message });
    }
  });

  // Overall target timeout — if something hangs we still return what we have.
  const watchdog = setTimeout(() => {
    log.warn('target.timeout', { name, ms: CONFIG.targetTimeoutMs, captured: captured.length });
    page.close().catch(() => {});
  }, CONFIG.targetTimeoutMs);

  try {
    if (preNavigate) await preNavigate(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
    // networkidle sometimes never fires on spy-heavy sites; don't hard fail on it.
    await page.waitForLoadState('networkidle', { timeout: CONFIG.navTimeoutMs }).catch(() => {});
    if (postNavigate) await postNavigate(page);

    for (let i = 0; i < scrollCount; i++) {
      if (page.isClosed()) break;
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(CONFIG.scrollDelayMs);
    }
  } catch (err) {
    log.warn('target.navigate-error', { name, error: err.message });
  } finally {
    clearTimeout(watchdog);
    if (!page.isClosed()) await page.close().catch(() => {});
  }

  return captured;
}

module.exports = { runTarget };
