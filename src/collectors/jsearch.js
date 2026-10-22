'use strict';

const { fetchJson } = require('./http');

// JSearch (RapidAPI) — a licensed API over Google for Jobs, used for employers
// whose own careers sites block automated clients. Google indexes those
// employers' postings directly, so the search reaches them even when we can't.
//
// Why Tesla is here: Akamai denies every automated browser on tesla.com (see
// the Tesla note in src/config.js), and Adzuna returns no description text.
// JSearch returns the full posting, so the 0-2 year ceiling and the restriction
// classifier can read these rows.
//
// ONLY THE EMPLOYER'S OWN POSTING IS KEPT. Google for Jobs merges every board
// that reposts a job (LinkedIn, Indeed, staffing agencies) into one listing. A
// row survives only if one of its apply links is on the configured host
// (`applyHost`, e.g. tesla.com), and that link becomes apply_url. Reposts with
// no employer link are dropped, which also keeps LinkedIn/Indeed rows out — see
// the red lines in HANDOFF.md.
//
// BUDGET. The free Basic plan is 200 requests/month, a hard limit, and each page
// of up to 10 results costs one request. So this source:
//   - never runs in the 2-hourly collect: its entry has `cadence: 'daily'`,
//     which SCHEDULED_COMPANIES leaves out, and .github/workflows/jsearch.yml
//     runs it once a day via `npm run collect -- --source jsearch`;
//   - asks for one page per query and at most MAX_QUERIES queries, so a run
//     costs at most 4 requests (~124/month), leaving room for manual runs;
//   - asks only for postings from the last 3 days, so the 10 results per query
//     go to new roles, and a skipped day is still covered;
//   - never retries: a retry is another billed request.
//
// Credentials: subscribe to the free Basic plan at
// https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/pricing and set
// JSEARCH_API_KEY to your RapidAPI key. Without it this collector no-ops.
//
// Config shape:
//   { source: 'jsearch', slug, displayName, employer, applyHost, queries, cadence: 'daily' }

const API_URL = 'https://jsearch.p.rapidapi.com/search-v2';
const API_HOST = 'jsearch.p.rapidapi.com';

const DEFAULT_QUERIES = [
  'software engineer',
  'machine learning engineer',
  'data engineer',
  'site reliability engineer',
];

// One request per query (num_pages=1). Raising either multiplies the monthly
// spend — 4 queries × 31 days is already 124 of the 200.
const MAX_QUERIES = 4;
const DATE_POSTED = '3days';

function credentials() {
  return process.env.JSEARCH_API_KEY || null;
}

function buildUrl(what, employer) {
  const url = new URL(API_URL);
  url.searchParams.set('query', `${what} at ${employer}`);
  url.searchParams.set('num_pages', '1');
  url.searchParams.set('country', 'us');
  url.searchParams.set('date_posted', DATE_POSTED);
  url.searchParams.set('employment_types', 'FULLTIME');
  return url.toString();
}

// search-v2 nests jobs under data.jobs; the older /search endpoint returned
// `data` as the array itself. Accept both, so a response-shape change reads as
// rows rather than as a silent zero.
function jobsFrom(resp) {
  if (Array.isArray(resp?.data?.jobs)) return resp.data.jobs;
  if (Array.isArray(resp?.data)) return resp.data;
  return [];
}

function onHost(link, host) {
  try {
    const h = new URL(link).hostname.toLowerCase();
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

// Google appends its own utm_* tracking to apply links. Dropping it keeps
// apply_url identical across runs and across sources.
function cleanLink(link) {
  const u = new URL(link);
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
  return u.toString();
}

// The employer's own apply link: the primary one if it's on the employer's
// host, otherwise the first alternative that is. null when only reposts exist.
function employerApplyLink(job, host) {
  const options = Array.isArray(job.apply_options) ? job.apply_options : [];
  const links = [job.job_apply_link, ...options.map((o) => o?.apply_link)];
  const link = links.find((l) => l && onHost(l, host));
  return link ? cleanLink(link) : null;
}

function buildLocation(job) {
  const parts = [job.job_city, job.job_state, job.job_country].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return job.job_location || (job.job_is_remote ? 'Remote' : '');
}

// Pure field mapping, split out so it can be regression-tested without network
// access. Returns null for anything that isn't the employer's own posting.
function mapJob(job, { slug, displayName, employer, applyHost }) {
  const apply_url = employerApplyLink(job, applyHost);
  if (!apply_url) return null;

  // An apply link on the employer's host is the main test; the name check
  // catches the odd agency listing that deep-links into the employer's site.
  const name = String(job.employer_name || '').toLowerCase();
  if (employer && !name.includes(employer.toLowerCase())) return null;

  return {
    source: 'jsearch',
    external_id: String(job.job_id || apply_url),
    company_name: displayName || job.employer_name || slug,
    job_title: (job.job_title || '').trim(),
    location: buildLocation(job),
    apply_url,
    description: job.job_description || '',
    date_posted: job.job_posted_at_datetime_utc || job.job_posted_at_timestamp || null,
  };
}

async function fetchCompany(config) {
  const {
    slug,
    displayName,
    employer = displayName,
    applyHost,
    queries = DEFAULT_QUERIES,
  } = config;
  if (!applyHost) throw new Error(`jsearch entry ${slug} missing applyHost`);

  const key = credentials();
  if (!key) {
    // eslint-disable-next-line no-console
    console.warn(`[jsearch] JSEARCH_API_KEY not set — skipping ${slug}`);
    return [];
  }

  if (queries.length > MAX_QUERIES) {
    // eslint-disable-next-line no-console
    console.warn(
      `[jsearch] ${slug}: ${queries.length} queries configured, running the first ` +
        `${MAX_QUERIES} to stay inside the free plan`
    );
  }

  const headers = { 'x-rapidapi-key': key, 'x-rapidapi-host': API_HOST };
  const seen = new Set();
  const jobs = [];
  let results = 0;
  let answered = 0;

  for (const what of queries.slice(0, MAX_QUERIES)) {
    let data;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await fetchJson(buildUrl(what, employer), { retries: 0, headers });
      answered++;
    } catch (err) {
      // The first query failing means a bad key, no subscription or a spent
      // quota — surface it as a collector failure rather than an empty success.
      if (!answered) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[jsearch] ${slug}: stopped at query "${what}" — ${err.message}`);
      break;
    }

    for (const job of jobsFrom(data)) {
      results++;
      const row = mapJob(job, { slug, displayName, employer, applyHost });
      if (!row || seen.has(row.apply_url)) continue;
      seen.add(row.apply_url);
      jobs.push(row);
    }
  }

  // The kept/seen ratio is the number to watch: a sudden drop to zero kept
  // means the employer's links stopped appearing, not that hiring stopped.
  // eslint-disable-next-line no-console
  console.log(`[jsearch] ${slug}: kept ${jobs.length} of ${results} results with a ${applyHost} apply link`);

  return jobs.filter((j) => j.job_title);
}

module.exports = {
  fetchCompany,
  mapJob,
  jobsFrom,
  buildUrl,
  MAX_QUERIES,
  source: 'jsearch',
};
