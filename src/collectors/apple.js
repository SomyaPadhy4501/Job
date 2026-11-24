'use strict';

const { runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel, levelRank } = require('../services/normalize');

// Apple Careers (jobs.apple.com) is server-rendered React: every page embeds
// its data as `window.__staticRouterHydrationData = JSON.parse("…")`, so plain
// HTTP is enough — no browser, no API key, no cookies. Verified 2026-10-31.
//
//   Search: /en-us/search?location=united-states-USA&sort=newest&page=N
//     → loaderData.search = { totalRecords, searchResults: [20 × { id,
//       postingTitle, transformedPostingTitle, postDateInGMT, locations,
//       jobSummary, … }] }
//   Detail: /en-us/details/{id}/{transformedPostingTitle}
//     → loaderData.jobDetails = { description, responsibilities,
//       minimumQualifications, preferredQualifications, … }
//
// This replaces the Playwright target scraper/src/targets/apple.js, which listened
// for XHRs Apple stopped firing and has returned 0 rows ever since. The search
// `jobSummary` is only the marketing intro; the qualifications that carry
// experience, clearance and sponsorship wording live on the detail page, so a
// description is fetched for every candidate that survives the title filters.
//
// Paging (changed 2026-11-24). The `search=` keyword is not a filter: it ranks
// fuzzily, and "software engineer" matched 4,234 of Apple's 4,597 US postings,
// "Retail Facilities Manager" included. The old collector ran six such queries
// at five pages each, so with sort=newest every query returned the same ~100
// newest postings site-wide, about one day's worth, and the 14-day board got
// 55 Apple rows. Instead this walks every US posting newest-first (the sort
// is strict) and stops once a whole page is older than the retention window:
// about 38 pages for 15 days, then title gates, then one detail per survivor.
// A team filter (team=<slug>-SFTWR-AF+…) works too, but software titles also
// sit under Hardware, Corporate Functions and Operations, so it missed rows.

const BASE = 'https://jobs.apple.com/en-us';
const PAGE_SIZE = 20; // server-fixed
// Hard stop whatever the dates say: 2,000 rows, ~40 days of US postings.
const MAX_PAGES = 100;

// Keep the footprint small and polite: one host, no auth, rate limits unknown.
// If Apple starts answering 403/429 from CI, lower detailMax first (it is the
// bulk of the requests), then raise pageDelayMs. Each can be set on the config
// entry; these are the defaults.
const DEFAULTS = { pageDelayMs: 400, detailMax: 250, detailConcurrency: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url, { retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          // A bare script UA is more likely to be challenged than a browser one.
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return await res.text();
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

// The blob is a JSON string literal holding JSON, so it is parsed twice.
// Returns null (not a throw) when the marker is absent so callers can tell
// "layout changed or blocked" apart from "network error".
function extractHydration(html) {
  const m = /__staticRouterHydrationData\s*=\s*JSON\.parse\((".*?")\);?\s*<\/script>/s.exec(html || '');
  if (!m) return null;
  try {
    return JSON.parse(JSON.parse(m[1]));
  } catch {
    return null;
  }
}

function searchUrl(page) {
  const params = new URLSearchParams({
    location: 'united-states-USA',
    sort: 'newest',
    page: String(page),
  });
  return `${BASE}/search?${params}`;
}

function detailUrl(r) {
  return `${BASE}/details/${r.id}/${r.transformedPostingTitle || ''}`;
}

// "Cupertino" + "United States of America" → "Cupertino, United States".
// Multi-location postings list every site.
function locationText(locations) {
  const parts = (Array.isArray(locations) ? locations : [])
    .map((l) =>
      [
        l.city || l.name,
        l.stateProvince,
        /^united states/i.test(l.countryName || '') ? 'United States' : l.countryName,
      ]
        .filter(Boolean)
        .join(', ')
    )
    .filter(Boolean);
  return [...new Set(parts)].join('; ');
}

// Sections in the order a reader meets them; headings let the experience
// extractor and the sponsorship classifier see "Minimum Qualifications" as such.
function buildDescription(detail, fallbackSummary) {
  if (!detail) return fallbackSummary || '';
  const sections = [
    [null, detail.jobSummary || fallbackSummary],
    ['Description', detail.description],
    ['Responsibilities', detail.responsibilities],
    ['Minimum Qualifications', detail.minimumQualifications],
    ['Preferred Qualifications', detail.preferredQualifications],
  ];
  return sections
    .filter(([, body]) => body && String(body).trim())
    .map(([head, body]) => (head ? `${head}\n${String(body).trim()}` : String(body).trim()))
    .join('\n\n');
}

// Pure field mapping, split out so it can be regression-tested without network.
function mapPosting(r, detail) {
  return {
    source: 'apple',
    external_id: String(r.id),
    company_name: 'Apple',
    job_title: r.postingTitle || '',
    location: locationText(r.locations),
    apply_url: detailUrl(r),
    description: buildDescription(detail, r.jobSummary),
    // postDateInGMT is a real ISO timestamp; `postingDate` is only a day.
    date_posted: r.postDateInGMT || null,
  };
}

// The fields sit one level down, in loaderData.jobDetails.jobsData. Reading
// jobDetails itself finds none of them, buildDescription() quietly falls back to
// the marketing summary, and every row loses the qualifications where
// experience, clearance and sponsorship wording live — with no error raised.
function jobsDataFrom(hydration) {
  return hydration?.loaderData?.jobDetails?.jobsData || null;
}

async function fetchDetail(r) {
  return jobsDataFrom(extractHydration(await fetchHtml(detailUrl(r))));
}

// Oldest posting time worth fetching: the retention window plus a day of
// slack, so a row on the boundary is left for normalize to judge. null = no
// window configured, page to MAX_PAGES.
function cutoffMs(now = Date.now()) {
  const days = Number(CONFIG.retentionDays);
  return days > 0 ? now - (days + 1) * 24 * 60 * 60 * 1000 : null;
}

function postedMs(r) {
  const t = new Date(r?.postDateInGMT || '').getTime();
  return Number.isNaN(t) ? null : t;
}

// True when the walk can stop after this page: short page, every posting on it
// older than the cutoff (undated rows don't count as old), or past the total.
function isLastPage(results, { page, totalRecords, cutoff }) {
  if (!Array.isArray(results) || results.length < PAGE_SIZE) return true;
  if (totalRecords && page * PAGE_SIZE >= totalRecords) return true;
  if (cutoff != null && results.every((r) => postedMs(r) != null && postedMs(r) < cutoff)) return true;
  return false;
}

async function fetchSearch({ pageDelayMs }) {
  const byId = new Map();
  const cutoff = cutoffMs();

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await sleep(pageDelayMs);

    let search;
    try {
      search = extractHydration(await fetchHtml(searchUrl(page)))?.loaderData?.search;
      // Nothing on the very first page means the site changed shape or is
      // refusing us. Say so loudly instead of returning an empty list that
      // reads as "Apple has no jobs".
      if (page === 1 && !(Array.isArray(search?.searchResults) && search.searchResults.length)) {
        throw new Error('search page carried no embedded job data (layout change or blocked)');
      }
    } catch (err) {
      if (page === 1) throw err;
      console.warn(`[apple] search page ${page} failed (${byId.size} rows kept) — ${err.message}`);
      break;
    }

    const results = search?.searchResults;
    for (const r of Array.isArray(results) ? results : []) {
      if (r?.id && r.postingTitle && !byId.has(r.id)) byId.set(r.id, r);
    }
    if (isLastPage(results, { page, totalRecords: Number(search?.totalRecords) || 0, cutoff })) break;
  }

  return [...byId.values()].filter((r) => cutoff == null || postedMs(r) == null || postedMs(r) >= cutoff);
}

async function fetchCompany(company = {}) {
  const opts = {
    pageDelayMs: company.pageDelayMs ?? DEFAULTS.pageDelayMs,
    detailMax: company.detailMax ?? DEFAULTS.detailMax,
    detailConcurrency: company.detailConcurrency ?? DEFAULTS.detailConcurrency,
  };
  const rows = await fetchSearch(opts);

  // Same two gates normalize applies, moved ahead of the per-job requests.
  const candidates = rows
    .filter((r) => !CONFIG.filterSoftwareOnly || looksSoftware(r.postingTitle))
    .filter((r) => passesLevel(r.postingTitle, CONFIG.entryLevelMode || 'permissive'))
    .sort((a, b) => levelRank(a.postingTitle) - levelRank(b.postingTitle) || String(b.postDateInGMT || '').localeCompare(String(a.postDateInGMT || '')));

  // Likely-in-range titles first (levelRank), then newest, so when detailMax
  // bites it is senior-worded and older rows that keep only the short summary.
  const toEnrich = candidates.slice(0, opts.detailMax);
  const details = await runWithConcurrency(toEnrich, opts.detailConcurrency, async (r) => {
    await sleep(opts.pageDelayMs);
    return fetchDetail(r);
  });

  return candidates.map((r, i) => {
    const d = i < details.length && details[i] && !details[i].__error ? details[i] : null;
    return mapPosting(r, d);
  });
}

module.exports = {
  fetchCompany,
  mapPosting,
  buildDescription,
  locationText,
  extractHydration,
  jobsDataFrom,
  searchUrl,
  isLastPage,
  cutoffMs,
  source: 'apple',
};
