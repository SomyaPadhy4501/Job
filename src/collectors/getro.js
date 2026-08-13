'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// Generic collector for VC portfolio job boards powered by Getro
// (jobs.craftventures.com, jobs.generalcatalyst.com, jobs.khoslaventures.com, …).
//
// Why this source matters: nearly every VC firm publishes a portfolio job board,
// and Getro hosts a large share of them. One network is hundreds-to-thousands of
// startup roles that never appear in our per-company ATS config, because the
// startups are too small or too new to have been discovered by the YC /
// topstartups probes. This is the highest-volume route to SF/startup coverage.
//
// Two properties make this cheaper than it looks:
//
//   1. The search API returns results **newest-first by default** (verified
//      2026-08-13: page 0 = today, page 30 = ~3 months back, page 55 = 19 months
//      back). No sort param is honoured — `sort`/`sortBy`/`sort_by`/`orderBy` are
//      all silently ignored — but the default order is what we want anyway, so we
//      stop paging as soon as a page falls entirely outside the retention window.
//      Volume is therefore bounded by RETENTION_DAYS, not by network size.
//   2. `searchable_locations: ['United States']` filters server-side (1,658 → 1,196
//      for Craft Ventures), so we don't download the rest of the world.
//
// Config shape:
//   { source: 'getro', slug, displayName, networkId, boardHost, maxPages, maxDetail }
//
// `networkId` is the Getro collection id and is not guessable — run
// scripts/probe-getro.js to resolve it from a board hostname. A wrong id returns
// an Elasticsearch "index_not_found_exception" rather than an empty list, so a
// typo fails loudly in the collector logs instead of going quiet forever.

const API_BASE = 'https://api.getro.com/api/v2/collections';

// The API caps page size at 20 regardless of what we ask for (100 and 200 both
// come back as 20), so this is a fact about the server, not a tunable.
const PAGE_SIZE = 20;

// Safety stop only — the retention early-exit below is the intended way out of
// the paging loop. Sized so the 30-day window is actually reachable on the
// busiest networks: General Catalyst posts ~120 US roles/day, which puts the
// 30-day boundary near page 205 (verified 2026-08-13 — page 100 was Aug 1,
// page 200 was Jul 17). An earlier value of 80 silently truncated those
// networks to ~5 days of history, which is exactly the kind of quiet
// under-collection that looks like "the source has nothing new".
const DEFAULT_MAX_PAGES = 250;

// Cap on description fetches per network per run. Descriptions come from the
// board's own job page (one request each), so this is the expensive half of the
// collector — see enrichDescription below for why we pay it at all. The title
// pre-filter runs first, which keeps the real number well under this on most
// networks: ~1,200 US rows for Craft Ventures reduce to ~11 software +
// non-senior roles.
//
// When the cap does bite, it truncates the OLDEST candidates: results arrive
// newest-first and that order is preserved through filtering. Those are the
// rows most likely to already be in the DB with a description from an earlier
// run, so the truncation costs the least it can.
const DEFAULT_MAX_DETAIL = 200;
const DETAIL_CONCURRENCY = 4; // deliberately gentle

const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';

// Getro labels every posting with an inferred seniority. It is a better signal
// than our title regex where the two disagree, but only at the ends of the
// range — 'senior' and null are left to normalize's title heuristics because
// Getro applies 'senior' to plenty of postings whose titles read plainly
// "Software Engineer".
const SENIORITY_REJECT = new Set(['director', 'vice_president', 'executive']);
const SENIORITY_ENTRY = new Set(['entry_level', 'associate', 'internship']);
const SENIORITY_MID = new Set(['mid_senior']);

async function fetchPage(networkId, page) {
  return fetchJson(`${API_BASE}/${networkId}/search/jobs`, {
    method: 'POST',
    retries: 1,
    headers: { accept: 'application/json' },
    body: {
      hitsPerPage: PAGE_SIZE,
      page,
      filters: { searchable_locations: ['United States'] },
    },
  });
}

// Description text is not in the search response — records carry
// `has_description: true` but no body — and there is no public per-job API
// endpoint (`/v2/jobs/{id}` 404s, `/v2/collections/{id}/jobs/{id}` 401s). The
// board's own job page server-side-renders it into __NEXT_DATA__, so that is
// where we read it from.
//
// We pay for this because two columns depend on description text and both
// matter more here than elsewhere: `restriction` (clearance / ITAR / citizenship)
// is classified from the description only, and these portfolios are full of
// defense-adjacent startups where that flag is the difference between a real
// lead and a wasted application. Sponsorship would survive without it — the
// USCIS company lookup carries that — but restriction would not.
async function enrichDescription(boardHost, job) {
  const orgSlug = job.organization?.slug;
  if (!orgSlug || !job.slug) return null;

  const url = `https://${boardHost}/companies/${orgSlug}/jobs/${job.slug}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();

  const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;

  let current;
  try {
    current = JSON.parse(m[1])?.props?.pageProps?.initialState?.jobs?.currentJob;
  } catch {
    return null; // a single unparseable page shouldn't fail the network
  }
  if (!current) return null;

  return {
    description: current.description || '',
    // postedAt is an ISO timestamp and is the same event as created_at, just
    // at full precision. Prefer it when present.
    postedAt: current.postedAt || null,
  };
}

async function fetchCompany({ networkId, boardHost, slug, displayName, maxPages, maxDetail }) {
  if (!networkId) throw new Error(`getro entry "${slug}" missing networkId`);

  const pageCap = maxPages || DEFAULT_MAX_PAGES;
  const detailCap = maxDetail || DEFAULT_MAX_DETAIL;

  // Retention cutoff, with a day of slack so a row posted right at the boundary
  // isn't dropped by clock skew between us and Getro.
  const retentionDays = CONFIG.retentionDays || 30;
  const cutoffMs = Date.now() - (retentionDays + 1) * 24 * 60 * 60 * 1000;

  // Collect candidates newest-first, stopping at the retention boundary.
  const byId = new Map();
  for (let page = 0; page < pageCap; page++) {
    let data;
    try {
      data = await fetchPage(networkId, page);
    } catch (err) {
      // A failure on the very first page means we collected nothing, and
      // returning [] there would report success with zero rows — the network
      // would look permanently empty instead of broken. Fail loudly so
      // collect.js records it as collector.fail. On any later page we already
      // have the newest rows, so partial results beat none — but say so, because
      // otherwise a transient error mid-pagination silently truncates the
      // network's history and looks identical to "nothing older exists".
      if (page === 0) throw err;
      console.warn(
        `[getro] ${slug}: pagination stopped early at page ${page} ` +
          `(${byId.size} rows kept) — ${err.message}`
      );
      break;
    }

    const jobs = data?.results?.jobs;
    if (!Array.isArray(jobs) || jobs.length === 0) break;

    let anyFresh = false;
    for (const j of jobs) {
      const postedMs = j.created_at ? j.created_at * 1000 : null;
      // Undated rows are kept: normalize's retention check ignores nulls, and
      // dropping them here would silently lose postings whose date Getro never
      // captured.
      if (postedMs == null || postedMs >= cutoffMs) {
        anyFresh = true;
        if (!byId.has(j.id)) byId.set(j.id, j);
      }
    }

    // Every row on this page is older than the window. Because results are
    // newest-first, nothing after it can be fresher.
    if (!anyFresh) break;

    const total = data?.results?.count;
    if (typeof total === 'number' && (page + 1) * PAGE_SIZE >= total) break;
  }

  // Title pre-filter before spending a request per description. These are the
  // same two gates normalize applies, so nothing that would have survived the
  // pipeline is discarded here — it just moves the rejection earlier, before
  // the expensive part.
  const candidates = [];
  for (const j of byId.values()) {
    if (SENIORITY_REJECT.has(j.seniority)) continue;
    const title = j.title || '';
    if (!title || !j.url) continue;
    if (CONFIG.filterSoftwareOnly && !looksSoftware(title)) continue;
    if (!passesLevel(title, CONFIG.entryLevelMode || 'permissive')) continue;
    candidates.push(j);
  }

  const toEnrich = candidates.slice(0, detailCap);
  const enriched = await runWithConcurrency(toEnrich, DETAIL_CONCURRENCY, (j) =>
    enrichDescription(boardHost, j)
  );

  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const extra = i < toEnrich.length && !enriched[i]?.__error ? enriched[i] : null;
    out.push(mapJob(candidates[i], slug, extra));
  }

  return out;
}

// Multi-tenant ATS hosts, where the employer is identified by the path slug
// rather than the hostname. For these, Getro's own company name is the better
// signal and the host tells us nothing.
const ATS_HOSTS = [
  'greenhouse.io', 'ashbyhq.com', 'lever.co', 'smartrecruiters.com', 'workable.com',
  'bamboohr.com', 'jobvite.com', 'rippling.com', 'breezy.hr', 'recruitee.com',
  'teamtailor.com', 'personio.de', 'pinpointhq.com', 'dover.com', 'getro.com',
  'linkedin.com', 'indeed.com', 'paylocity.com', 'jazz.co', 'applytojob.com',
  'trakstar.com', 'workforcenow.adp.com', 'gem.com', 'polymer.co',
];

// ATS hosts where the tenant is the FIRST label — 'adobe' in
// adobe.wd5.myworkdayjobs.com, 'paypal' in paypal.eightfold.ai.
const TENANT_PREFIXED_HOSTS = [
  'myworkdayjobs.com', 'myworkdaysite.com', 'eightfold.ai', 'icims.com',
  'avature.net', 'successfactors.com', 'taleo.net', 'oraclecloud.com',
];

// Derive the real employer from an apply_url, for the USCIS sponsorship lookup
// only. Getro's organization records keep pre-acquisition names, but the URL
// points at whoever actually owns the ATS today — so a "Frame.io" posting on
// adobe.wd5.myworkdayjobs.com is really an Adobe role, and a "Airkit" posting on
// www.salesforce.com is really Salesforce.
//
// Deliberately generic rather than a hand-maintained acquisition map: the same
// rule resolves Frame.io→adobe, Instana→ibm, Yammer→microsoft, OPOWER→oracle,
// Tessian→proofpoint and Neon→databricks without naming any of them.
//
// Returns null when the host is a multi-tenant ATS (nothing to learn) or
// unparseable. The known imprecision is that a posting hosted on a staffing
// agency's domain would inherit that agency's sponsorship record; it only ever
// pushes a row toward YES, which is the safer direction here, and the row still
// carries its real company_name for the user to check.
function employerFromApplyUrl(url) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }

  if (ATS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;

  const labels = host.split('.').filter(Boolean);
  for (const suffix of TENANT_PREFIXED_HOSTS) {
    if (host.endsWith(suffix) && labels.length > suffix.split('.').length) {
      return labels[0];
    }
  }

  // Otherwise the second-to-last label is the organization:
  // careers.ibm.com → ibm, www.salesforce.com → salesforce,
  // apply.careers.microsoft.com → microsoft.
  return labels.length >= 2 ? labels[labels.length - 2] : null;
}

// Pure field mapping, split out so it can be regression-tested without network
// access. Note the API uses snake_case (`created_at`, `location_details`) while
// the board's server-rendered __NEXT_DATA__ uses camelCase (`createdAt`,
// `postedAt`) — this reads the snake_case API shape, plus `postedAt` from the
// enrichment blob.
function mapJob(j, slug, extra) {
  const location =
    Array.isArray(j.locations) && j.locations.length
      ? j.locations.join(', ')
      : (j.location_details || []).map((d) => d.name).join(', ');

  return {
    source: 'getro',
    // Getro job ids are unique per network but the same posting can appear in
    // several VC portfolios. Namespacing by network keeps external_id honest;
    // cross-network duplicates collapse later on dedupe_key
    // (company|title|location), which is what we actually want.
    external_id: `${slug}:${j.id}`,
    // The employer is the portfolio company, not the VC firm whose board
    // surfaced it. displayName is only used for logging.
    company_name: (j.organization?.name || '').trim(),
    job_title: (j.title || '').trim(),
    location,
    // Direct ATS apply link (boards.greenhouse.io/…, jobs.ashbyhq.com/…),
    // not a Getro redirect — so the user lands where they'd have landed
    // anyway had we discovered the company's board directly.
    apply_url: j.url,
    description: extra?.description || '',
    date_posted: extra?.postedAt || j.created_at || null,
    // Second key for the USCIS sponsorship lookup — see employerFromApplyUrl.
    // company_name above is left as Getro reported it.
    sponsor_company_fallbacks: [employerFromApplyUrl(j.url)].filter(Boolean),
    entry_level_override: SENIORITY_ENTRY.has(j.seniority) ? 1 : undefined,
    mid_level_override: SENIORITY_MID.has(j.seniority) ? 1 : undefined,
  };
}

module.exports = { fetchCompany, mapJob, employerFromApplyUrl, source: 'getro' };
