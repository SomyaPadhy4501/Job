'use strict';

const { fetchJson } = require('./http');

// Adzuna job-search API — a licensed aggregator, used for employers whose own
// careers sites are unreachable programmatically.
//
// Why this exists: several large H-1B sponsors have no usable public board.
// Tesla actively challenges automated clients (HTTP 429 + a challenge token,
// and a Playwright render returns zero job links); Cisco and eBay sit behind
// Phenom; Qualcomm behind Eightfold; IBM is in-house. Rather than write and
// maintain a bespoke scraper per wall, we buy discovery from one aggregator.
//
// IMPORTANT — description is a SNIPPET.
// Adzuna's docs state plainly that `description` is abbreviated. That is not
// enough text for classifyRestriction() or the sponsorship description rules,
// which look for clauses that usually sit deep in a posting. So this collector
// treats Adzuna as a DISCOVERY source only and leaves `description` empty
// rather than passing a snippet through — a snippet would read as "no
// clearance language present" and produce false negatives on exactly the roles
// the restriction filter exists to hide.
//
// Full descriptions are recovered separately: `redirect_url` points at the
// employer's own posting, and for most of these employers that detail page
// renders fine even when their search does not. That enrichment belongs in the
// Playwright scraper (scraper/src/targets/), not here.
//
// Credentials: free signup at https://developer.adzuna.com/ yields an app id
// and key. Set ADZUNA_APP_ID and ADZUNA_APP_KEY. Without them this collector
// no-ops rather than throwing, so a missing key can't break a collect run.
//
// Config shape:
//   { source: 'adzuna', slug, displayName, company, country, queries, maxPages }

const API_BASE = 'https://api.adzuna.com/v1/api/jobs';
const DEFAULT_COUNTRY = 'us';
const DEFAULT_RESULTS_PER_PAGE = 50;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_DAYS_OLD = 30;

const DEFAULT_QUERIES = ['software engineer', 'machine learning engineer', 'data engineer'];

function credentials() {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  return id && key ? { id, key } : null;
}

function buildUrl({ country, page, what, company, resultsPerPage, maxDaysOld }, creds) {
  const url = new URL(`${API_BASE}/${country}/search/${page}`);
  url.searchParams.set('app_id', creds.id);
  url.searchParams.set('app_key', creds.key);
  url.searchParams.set('results_per_page', String(resultsPerPage));
  url.searchParams.set('max_days_old', String(maxDaysOld));
  url.searchParams.set('content-type', 'application/json');
  if (what) url.searchParams.set('what', what);
  if (company) url.searchParams.set('company', company);
  return url.toString();
}

// Adzuna's company matching is fuzzy — a "Tesla" query also returns staffing
// agencies advertising Tesla roles. Require the returned display_name to
// actually contain the configured company name.
function matchesCompany(result, company) {
  if (!company) return true;
  const name = String(result?.company?.display_name || '').toLowerCase();
  return name.includes(company.toLowerCase());
}

async function fetchCompany(config) {
  const {
    slug,
    displayName,
    company,
    country = DEFAULT_COUNTRY,
    queries = DEFAULT_QUERIES,
    maxPages = DEFAULT_MAX_PAGES,
    resultsPerPage = DEFAULT_RESULTS_PER_PAGE,
    maxDaysOld = DEFAULT_MAX_DAYS_OLD,
  } = config;

  const creds = credentials();
  if (!creds) {
    // eslint-disable-next-line no-console
    console.warn(`[adzuna] ADZUNA_APP_ID/ADZUNA_APP_KEY not set — skipping ${slug}`);
    return [];
  }

  const seen = new Set();
  const jobs = [];

  for (const what of queries) {
    for (let page = 1; page <= maxPages; page++) {
      const url = buildUrl(
        { country, page, what, company, resultsPerPage, maxDaysOld },
        creds,
      );
      // eslint-disable-next-line no-await-in-loop
      const data = await fetchJson(url, { retries: 1 });
      const results = Array.isArray(data?.results) ? data.results : [];
      if (results.length === 0) break;

      for (const r of results) {
        const id = String(r.id || '');
        if (!id || seen.has(id)) continue;
        if (!matchesCompany(r, company)) continue;
        seen.add(id);

        jobs.push({
          source: 'adzuna',
          external_id: id,
          company_name: displayName || r.company?.display_name || slug,
          job_title: r.title || '',
          location: r.location?.display_name || '',
          apply_url: r.redirect_url || '',
          // Deliberately empty — see the header note on snippets.
          description: '',
          date_posted: r.created || null,
        });
      }

      if (results.length < resultsPerPage) break; // last page
    }
  }

  return jobs.filter((j) => j.external_id && j.job_title && j.apply_url);
}

module.exports = { fetchCompany, source: 'adzuna' };
