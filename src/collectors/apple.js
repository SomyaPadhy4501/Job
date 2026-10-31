'use strict';

const { runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// Apple Careers (jobs.apple.com) is server-rendered React: every page embeds
// its data as `window.__staticRouterHydrationData = JSON.parse("…")`, so plain
// HTTP is enough — no browser, no API key, no cookies. Verified 2026-10-31.
//
//   Search: /en-us/search?search=Q&location=united-states-USA&sort=newest&page=N
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

const BASE = 'https://jobs.apple.com/en-us';
const QUERIES = [
  'software engineer',
  'machine learning',
  'data scientist',
  'data engineer',
  'security engineer',
  'site reliability',
];
const PAGE_SIZE = 20; // server-fixed
const MAX_PAGES_PER_QUERY = 5; // 100 newest rows per query

// Keep the footprint small and polite: one host, no auth, rate limits unknown.
// If Apple starts answering 403/429 from CI, lower DETAIL_MAX first (it is the
// bulk of the requests), then raise PAGE_DELAY_MS.
const PAGE_DELAY_MS = 400;
const DETAIL_MAX = 60;
const DETAIL_CONCURRENCY = 2;

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

function searchUrl(query, page) {
  const params = new URLSearchParams({
    search: query,
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

async function fetchCompany() {
  const byId = new Map();

  for (const query of QUERIES) {
    for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
      if (byId.size || page > 1) await sleep(PAGE_DELAY_MS);

      let results;
      try {
        const data = extractHydration(await fetchHtml(searchUrl(query, page)));
        results = data?.loaderData?.search?.searchResults;
        // Nothing on the very first page means the site changed shape or is
        // refusing us. Say so loudly instead of returning an empty list that
        // reads as "Apple has no jobs".
        if (!Array.isArray(results) && byId.size === 0 && page === 1) {
          throw new Error('search page carried no embedded job data (layout change or blocked)');
        }
      } catch (err) {
        if (byId.size === 0) throw err;
        console.warn(`[apple] "${query}" page ${page} failed (${byId.size} rows kept) — ${err.message}`);
        break;
      }

      if (!Array.isArray(results) || !results.length) break;
      for (const r of results) {
        if (r?.id && r.postingTitle && !byId.has(r.id)) byId.set(r.id, r);
      }
      if (results.length < PAGE_SIZE) break;
    }
  }

  // Same two gates normalize applies, moved ahead of the per-job requests.
  const candidates = [...byId.values()]
    .filter((r) => !CONFIG.filterSoftwareOnly || looksSoftware(r.postingTitle))
    .filter((r) => passesLevel(r.postingTitle, CONFIG.entryLevelMode || 'permissive'))
    .sort((a, b) => String(b.postDateInGMT || '').localeCompare(String(a.postDateInGMT || '')));

  // Newest first, so when DETAIL_MAX bites it is the oldest rows that keep only
  // the short summary.
  const toEnrich = candidates.slice(0, DETAIL_MAX);
  const details = await runWithConcurrency(toEnrich, DETAIL_CONCURRENCY, async (r) => {
    await sleep(PAGE_DELAY_MS);
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
  source: 'apple',
};
