'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

// Wayfair careers.
//
// Why this lives in the Playwright scraper rather than src/collectors/:
// wayfair.com/careers is a client-rendered SPA whose data comes from an
// internal endpoint. Called from a plain HTTP client that endpoint returns
// HTTP 200 with an EMPTY list rather than an error, so a normal collector
// would silently report "0 jobs" forever. Rendered in a real browser it
// returns the full board. Same reason google/apple/meta live here.
//
// robots.txt note (checked 2026-08-08): wayfair.com/robots.txt places no
// Disallow on /careers/, and its comments point readers at the job board.
// We load one page and issue one same-origin request — lighter on their
// servers than paging through the UI.

const CAREERS_URL = 'https://www.wayfair.com/careers/jobs';
const SEARCH_ENDPOINT = '/a/careers/careers/job_search_data';

// The board carries retail, warehouse and corporate roles alongside
// engineering. Filter before returning so the ingest payload stays small;
// normalizeJob applies the authoritative role classifier downstream.
const SOFTWARE_TITLE =
  /software|engineer|developer|\bswe\b|\bsde\b|full[\s-]?stack|frontend|front[\s-]end|backend|back[\s-]end|platform|infrastructure|site reliability|\bsre\b|machine learning|\bml\b|data scien|data engineer|analytics engineer|android|\bios\b|mobile|security engineer|devops/i;

// Titles that are engineering-adjacent but not entry/mid IC roles.
const SENIOR_TITLE =
  /\b(senior|staff|principal|lead|manager|director|head|vp|chief|architect)\b/i;

function extractMaxYears(text) {
  const matches = [...String(text || '').matchAll(/\b(\d{1,2})\+?\s*(?:-|to|–)?\s*\d{0,2}\s*years?\b/gi)];
  if (!matches.length) return null;
  const nums = matches.map((m) => Number(m[1])).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
}

// location is a structured object: { name, city, state, country }. Keep the
// country only when it isn't the US so foreign rows stay identifiable to
// looksUS() downstream, while US rows read "Boston, Massachusetts".
function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const parts = [loc.city || '', loc.state || ''].filter(Boolean);
  const country = String(loc.country || '');
  if (!parts.length) return loc.name || country;
  if (country && !/^(us|usa|united states)$/i.test(country.trim())) parts.push(country);
  return parts.join(', ');
}

async function fetchBoard(page) {
  await page.goto(CAREERS_URL, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navTimeoutMs,
  });
  // Let the SPA finish its own bootstrap before we reuse the session.
  await page.waitForTimeout(3000);

  // Issue the request from inside the page so it carries the normal
  // same-origin context. An empty body returns the whole board.
  return page.evaluate(async (endpoint) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'include',
        body: '{}',
      });
      const text = await res.text();
      if (text.trim().startsWith('{')) {
        try {
          const json = JSON.parse(text);
          if (Array.isArray(json.jobListData)) return json.jobListData;
        } catch (err) {
          /* fall through to retry */
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return [];
  }, SEARCH_ENDPOINT);
}

async function run(context) {
  const page = await context.newPage();
  try {
    const listings = await fetchBoard(page);
    log.info('target.wayfair.board', { listings: listings.length });

    const jobs = [];
    for (const item of listings) {
      const title = String(item.title || '').trim();
      if (!title || !SOFTWARE_TITLE.test(title)) continue;
      if (SENIOR_TITLE.test(title)) continue;

      const description = String(item.description || item.briefDescription || '');
      const years = extractMaxYears(description);
      const applyUrl =
        item.applyLink ||
        item.structuredDataApplyLink ||
        `${CAREERS_URL}/${item.eid || item.id}`;

      jobs.push({
        external_id: String(item.eid || item.requisitionId || item.id || ''),
        company_name: 'Wayfair',
        job_title: title,
        location: formatLocation(item.location),
        apply_url: applyUrl,
        description,
        date_posted: item.createdDate || item.lastUpdatedDate || null,
        entry_level_override: years != null && years <= 1 ? 1 : undefined,
        mid_level_override: years != null && years >= 2 && years <= 3 ? 1 : undefined,
      });
    }

    log.info('target.wayfair.filtered', { kept: jobs.length });
    return jobs.filter((j) => j.external_id && j.job_title && j.apply_url);
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { run, source: 'wayfair' };
