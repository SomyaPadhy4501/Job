'use strict';

// jobs.apple.com is now an SSR page — no XHR fan-out, all results render
// into HTML on the initial response. The previous version of this target
// listened for `/api/...` responses and got nothing because Apple stopped
// firing them client-side.
//
// The new approach mirrors the Deloitte target: drive `?page=N` pagination,
// extract job cards from the DOM. We fan out across a handful of role
// queries to broaden coverage beyond bare "software engineer" results.
//
// Card layout (observed 2026-04-24):
//   <a href="/en-us/details/{positionId}/{slug}?team=...">
//     <h3>{job_title}</h3>
//   </a>
//   The grandparent container also carries:
//     {team_label}\n{date_posted}\nLocation\n{city}\nActions

const { CONFIG } = require('../config');
const log = require('../logger');

const SEARCH_QUERIES = [
  'software engineer',
  'machine learning',
  'data scientist',
  'data engineer',
  'security engineer',
  'site reliability',
];
const PAGE_SIZE = 20; // observed
const MAX_PAGES_PER_QUERY = 5; // 100 rows per query, ~600 total before dedupe

const DATE_RE = /([A-Z][a-z]{2})\s+(\d{1,2}),\s+(20\d\d)/;
const MONTH = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function searchUrl(query, page) {
  const params = new URLSearchParams({
    search: query,
    location: 'united-states-USA',
    sort: 'newest',
    page: String(page),
  });
  return `https://jobs.apple.com/en-us/search?${params.toString()}`;
}

// "200659561-3543" out of "/en-us/details/200659561-3543/wireless-systems..."
function externalIdFromHref(href) {
  const m = String(href || '').match(/\/details\/(\d+-\d+)\//);
  return m ? m[1] : '';
}

function parseAppleDate(text) {
  const m = DATE_RE.exec(String(text || ''));
  if (!m) return null;
  const month = MONTH[m[1]];
  if (month == null) return null;
  const d = new Date(Date.UTC(Number(m[3]), month, Number(m[2])));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function collectPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
  await page.waitForLoadState('networkidle', { timeout: CONFIG.navTimeoutMs }).catch(() => {});

  return page.evaluate(() => {
    // Anchors with an H3 child or H3 parent — those are the per-job titles.
    const anchors = [...document.querySelectorAll('a[href*="/details/"]')].filter(
      (a) => a.querySelector('h3') || a.parentElement?.tagName === 'H3'
    );
    const seen = new Set();
    const rows = [];
    for (const a of anchors) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);

      // Walk up to find the row container that holds title + team + date + location.
      let card = a;
      for (let i = 0; i < 6 && card.parentElement; i++) {
        card = card.parentElement;
        const txt = (card.innerText || '').trim();
        if (/\d{1,2},\s*20\d\d/.test(txt) && txt.length > 80) break;
      }
      const lines = (card.innerText || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      // Layout is roughly: [title, team, date, "Location", city, "Actions"]
      const title = lines[0] || (a.innerText || '').trim();
      const team = lines[1] || '';
      const dateLine = lines.find((l) => /\d{1,2},\s*20\d\d/.test(l)) || '';
      const locIdx = lines.indexOf('Location');
      const city = locIdx >= 0 ? lines[locIdx + 1] : '';

      rows.push({ href: a.href, title, team, dateLine, city });
    }
    return rows;
  });
}

async function run(context) {
  const page = await context.newPage();
  try {
    const byId = new Map();
    for (const query of SEARCH_QUERIES) {
      for (let p = 1; p <= MAX_PAGES_PER_QUERY; p++) {
        let cards;
        try {
          cards = await collectPage(page, searchUrl(query, p));
        } catch (err) {
          log.warn('target.apple.page-fail', { query, page: p, error: err.message });
          break;
        }
        if (!cards.length) break;
        for (const c of cards) {
          const id = externalIdFromHref(c.href);
          if (!id || byId.has(id)) continue;
          byId.set(id, {
            source: 'apple',
            external_id: id,
            company_name: 'Apple',
            job_title: c.title,
            location: c.city ? `${c.city}, United States` : 'United States',
            apply_url: c.href,
            description: '',
            date_posted: parseAppleDate(c.dateLine),
          });
        }
        log.info('target.apple.page', { query, page: p, cards: cards.length, total: byId.size });
        if (cards.length < PAGE_SIZE) break; // last page
      }
    }
    return [...byId.values()];
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { run, source: 'apple' };
