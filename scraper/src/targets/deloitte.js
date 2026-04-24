'use strict';

// Deloitte's public careers portal is a classic SSR page — no JSON API,
// no XHR fan-out. Each results page has up to 10 job cards rendered into
// the initial HTML. Pagination is via `?jobOffset=N`.
//
// We iterate offset pages, extract job cards from the DOM, and skip the
// description — it would require a detail-page fetch per job (~900 of them),
// and the sponsorship classifier on title alone is usually good enough for
// Deloitte's patterns (most postings are US-citizen/clearance roles, not
// sponsorship-eligible).
//
// Card layout observed: an <a href="...JobDetail/{slug}/{id}"> whose closest
// container also holds:
//   `Deloitte US | Deloitte {entity} | {location}`
// where location can be "Multiple Locations" or a real city string.

const { CONFIG } = require('../config');
const log = require('../logger');

const SEARCH_URL =
  'https://apply.deloitte.com/en_US/careers/SearchJobs/?locationTextInput=United+States&3_2=%5B%22USA%22%5D&jobOffset=';
const PAGE_SIZE = 10;
const MAX_PAGES = 30; // 300 rows/run — retention filter discards the rest

function extractIdFromUrl(url) {
  const m = String(url || '').match(/\/JobDetail\/[^/]+\/(\d+)/);
  return m ? m[1] : '';
}

async function collectPage(page, offset) {
  await page.goto(SEARCH_URL + offset, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navTimeoutMs,
  });
  await page.waitForLoadState('networkidle', { timeout: CONFIG.navTimeoutMs }).catch(() => {});

  return page.evaluate(() => {
    const rows = [];
    const anchors = [...document.querySelectorAll('a[href*="/JobDetail/"]')];
    for (const a of anchors) {
      const card = a.closest('li, div, tr, article') || a.parentElement;
      const cardText = (card?.innerText || '').trim();
      const title = (a.innerText || '').trim();
      if (!title) continue;
      // The card text looks like "Title\nDeloitte US | {entity} | {location}"
      // We split on pipe and take the last segment as location.
      let location = '';
      for (const line of cardText.split('\n')) {
        if (line.includes('|')) {
          const parts = line.split('|').map((s) => s.trim());
          location = parts[parts.length - 1] || '';
          break;
        }
      }
      rows.push({ href: a.href, title, location });
    }
    // Dedupe by href — anchors can repeat (same role linked from the title
    // and from a separate "View details" inside the same card).
    const seen = new Set();
    return rows.filter((r) => {
      if (seen.has(r.href)) return false;
      seen.add(r.href);
      return true;
    });
  });
}

async function run(context) {
  const page = await context.newPage();
  try {
    const out = [];
    for (let i = 0; i < MAX_PAGES; i++) {
      const offset = i * PAGE_SIZE;
      let cards;
      try {
        cards = await collectPage(page, offset);
      } catch (err) {
        log.warn('target.deloitte.page-fail', { offset, error: err.message });
        break;
      }
      if (!cards.length) break;
      log.info('target.deloitte.page', { offset, count: cards.length });
      for (const c of cards) {
        const id = extractIdFromUrl(c.href);
        if (!id) continue;
        out.push({
          source: 'deloitte',
          external_id: id,
          company_name: 'Deloitte',
          job_title: c.title,
          location: c.location,
          apply_url: c.href,
          description: '',
          date_posted: null,
        });
      }
      if (cards.length < PAGE_SIZE) break; // short page → end of results
    }
    return out;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { run, source: 'deloitte' };
