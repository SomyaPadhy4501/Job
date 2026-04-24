'use strict';

// builtin.com is a regional tech-jobs aggregator. Each city has its own
// branded subdomain (builtinboston.com, builtinnyc.com, builtinla.com,
// builtinsf.com), but all of them now redirect into the unified
// builtin.com/jobs?city=X&state=Y backend — same data, same cards.
//
// Earlier HANDOFF.md flagged builtin.com as "Cloudflare-gated"; turns out
// the gating was on browser-fingerprint check that Playwright passes
// cleanly. Cards render server-side into HTML, so this is a
// straightforward DOM scrape (same pattern as Deloitte / Apple targets).
//
// Card layout (observed 2026-04-24):
//   <div class="job-card ...">
//     <a href="/company/{slug}" data-id="company-title"><span>Chewy</span></a>
//     <a href="/job/{slug}/{numeric-id}" data-id="job-card-title">{title}</a>
//     {company}\n{title}\n{posted_text}\n{modality}\n{city, ST, USA}\n[Easy Apply]\n{salary}\n{level}
//
// We scope to four cities the user asked about: Boston, NYC, San Francisco,
// Los Angeles. The role classifier in normalize.js handles non-CS rejection
// downstream, so we don't try to filter at URL-param level (BuiltIn's
// `?categories=Dev+%2B+Engineering` filter is unreliable).

const { CONFIG } = require('../config');
const log = require('../logger');

const CITIES = [
  { label: 'Boston',        city: 'Boston',        state: 'Massachusetts' },
  { label: 'New York',      city: 'New York',      state: 'New York' },
  { label: 'San Francisco', city: 'San Francisco', state: 'California' },
  { label: 'Los Angeles',   city: 'Los Angeles',   state: 'California' },
  { label: 'Austin',        city: 'Austin',        state: 'Texas' },
  { label: 'Seattle',       city: 'Seattle',       state: 'Washington' },
  { label: 'Chicago',       city: 'Chicago',       state: 'Illinois' },
  { label: 'Denver',        city: 'Denver',        state: 'Colorado' },
  { label: 'Atlanta',       city: 'Atlanta',       state: 'Georgia' },
  { label: 'San Diego',     city: 'San Diego',     state: 'California' },
  { label: 'Washington DC', city: 'Washington',    state: 'District of Columbia' },
  { label: 'Pittsburgh',    city: 'Pittsburgh',    state: 'Pennsylvania' },
  { label: 'Charlotte',     city: 'Charlotte',     state: 'North Carolina' },
  { label: 'Miami',         city: 'Miami',         state: 'Florida' },
];
const PAGE_SIZE = 26; // observed
const MAX_PAGES_PER_CITY = 4; // ~100 cards/city × 4 cities = ~400 rows pre-filter

function searchUrl(city, state, page) {
  const params = new URLSearchParams({
    city,
    state,
    country: 'USA',
    searcharea: '25mi',
    categories: 'Dev + Engineering',
    page: String(page),
  });
  return `https://builtin.com/jobs?${params.toString()}`;
}

// "/job/software-development-manager/9159183" → "9159183"
function externalIdFromHref(href) {
  const m = String(href || '').match(/\/job\/[^/]+\/(\d+)/);
  return m ? m[1] : '';
}

// "Reposted 22 Hours Ago" / "9 Minutes Ago" / "5 Days Ago" → ISO timestamp
function parseRelativePosted(text) {
  if (!text) return null;
  const m = /(\d+)\s+(minute|hour|day|week|month)s?\s+ago/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const d = new Date();
  if (unit === 'minute') d.setMinutes(d.getMinutes() - n);
  else if (unit === 'hour') d.setHours(d.getHours() - n);
  else if (unit === 'day') d.setDate(d.getDate() - n);
  else if (unit === 'week') d.setDate(d.getDate() - n * 7);
  else if (unit === 'month') d.setMonth(d.getMonth() - n);
  return d.toISOString();
}

// "Senior level" → reject (the senior filter in normalize would catch it
// anyway, but tagging the level here lets us suppress mis-bucketed entries
// before they hit the upsert).
function levelOverride(text) {
  if (!text) return {};
  if (/\bentry[-\s]?level\b/i.test(text)) return { entry_level_override: 1 };
  if (/\bmid[-\s]?level\b/i.test(text)) return { mid_level_override: 1 };
  return {};
}

async function collectPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
  await page.waitForLoadState('networkidle', { timeout: CONFIG.navTimeoutMs }).catch(() => {});
  // BuiltIn's job cards lazy-render *after* networkidle fires. Without this
  // pause we capture ~2 stub cards per page; with it we get the full ~26.
  await page
    .waitForSelector('a[data-id="job-card-title"]', { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  return page.evaluate(() => {
    // Each job card has id="job-card-{id}". The previous `[class*="job-card"]`
    // selector was too loose — it matched the outer flex wrapper too, giving
    // 2 huge containers instead of N per-job elements.
    const cards = [...document.querySelectorAll('[id^="job-card-"]')];
    const rows = [];
    for (const card of cards) {
      // Each card has two `/company/` anchors — the logo (empty text, comes
      // first in DOM) and the named link. Combining selectors with comma
      // breaks because querySelector picks document-first across the union,
      // so we explicitly prefer the named one and fall back if absent.
      const titleAnchor =
        card.querySelector('a[data-id="job-card-title"]') ||
        card.querySelector('a[href*="/job/"]');
      const companyAnchor =
        card.querySelector('a[data-id="company-title"]') ||
        card.querySelector('a[href*="/company/"]');
      if (!titleAnchor || !companyAnchor) continue;
      const title = (titleAnchor.textContent || '').replace(/\s+/g, ' ').trim();
      const company = (companyAnchor.textContent || '').replace(/\s+/g, ' ').trim();
      const text = (card.innerText || card.textContent || '').trim();
      if (!title || !company) continue;
      rows.push({ href: titleAnchor.href, title, company, text });
    }
    return rows;
  });
}

// Extract the city/state line out of the card text — usually "Boston, MA, USA".
function extractLocation(text, fallback) {
  if (!text) return fallback;
  const m = /\b([A-Z][A-Za-z. ]+,\s+[A-Z]{2}(?:,\s+USA)?)\b/.exec(text);
  return m ? m[1] : fallback;
}

async function scrapeCity(page, entry) {
  const out = [];
  for (let p = 1; p <= MAX_PAGES_PER_CITY; p++) {
    let cards;
    try {
      cards = await collectPage(page, searchUrl(entry.city, entry.state, p));
    } catch (err) {
      log.warn('target.builtin.page-fail', { city: entry.label, page: p, error: err.message });
      break;
    }
    if (!cards.length) break;
    for (const c of cards) {
      const id = externalIdFromHref(c.href);
      if (!id) continue;
      out.push({
        source: 'builtin',
        external_id: id,
        company_name: c.company,
        job_title: c.title,
        location: extractLocation(c.text, `${entry.label}, USA`),
        apply_url: c.href,
        description: '',
        date_posted: parseRelativePosted(c.text),
        ...levelOverride(c.text),
      });
    }
    log.info('target.builtin.page', { city: entry.label, page: p, cards: cards.length });
    if (cards.length < PAGE_SIZE) break;
  }
  return out;
}

async function run(context) {
  const page = await context.newPage();
  try {
    const byId = new Map();
    for (const entry of CITIES) {
      const rows = await scrapeCity(page, entry);
      // Dedupe by external_id — same job often appears under multiple
      // hub-city searches when it sits within 25 mi of two metros (e.g.
      // San Jose role surfaces under both SF and "South Bay").
      for (const r of rows) {
        if (!byId.has(r.external_id)) byId.set(r.external_id, r);
      }
    }
    return [...byId.values()];
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { run, source: 'builtin' };
