'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

// Meta Careers (metacareers.com/jobsearch).
//
// The search page shows 10 jobs per page ("Page 1 of 136"), but it gets them
// from one GraphQL call (CareersJobSearchResultsDataQuery) that returns every
// open job at once: id, title, locations, teams. A second call
// (CareersJobSearchLocationFilterV3Query) maps each location name to its
// country. We load the page once in the browser, read both responses, and
// keep US software-type titles.
//
// Descriptions and posting dates come from each job's page, which is served
// over plain HTTP with a schema.org JobPosting block. We fetch them one at a
// time, starts at least DETAIL_GAP_MS apart, within a row and time budget.
// The list is not in posting-date order (`sort_by_new` notwithstanding: on
// 2026-11-24, 190 of the first 242 were posted 3+ weeks earlier), so there is
// no early stop by age; postings past MAX_AGE_DAYS are fetched but not sent.
// About 380 US software seeds take ~7 minutes at one page a second.
//
// Until 2026-11-24 this target read the job links in the DOM of 10 search
// URLs: page 1 only, 10 cards each, so 6-10 seeds per URL and 29 rows. One of
// them (teams[0]=Research and Data) named no real team and matched nothing.

const SEARCH_URL = 'https://www.metacareers.com/jobsearch?sort_by_new=true';
const JOB_BASE = 'https://www.metacareers.com/profile/job_details/';

const MAX_DETAIL_ROWS = 300;
const DETAIL_GAP_MS = 1000;
const DETAIL_BUDGET_MS = 8 * 60_000;
// The API drops postings older than RETENTION_DAYS (14); don't send ones a
// week past that.
const MAX_AGE_DAYS = 21;
const FAIL_STREAK_STOP = 5;
const MAX_DESCRIPTION_CHARS = 20_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Relay may stream several JSON objects, one per line.
function parseGraphqlBody(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t));
    } catch {}
  }
  return out;
}

function extractAllJobs(payload) {
  const jobs = payload?.data?.job_search_with_featured_jobs_v2?.all_jobs;
  return Array.isArray(jobs) ? jobs : null;
}

// location_display_name -> country, from the location filter.
function extractLocationCountries(payload) {
  const locations = payload?.data?.job_search_filters?.locations;
  if (!Array.isArray(locations)) return null;
  const out = new Map();
  for (const l of locations) {
    if (l && typeof l.location_display_name === 'string') {
      out.set(l.location_display_name.trim(), String(l.country || ''));
    }
  }
  return out;
}

const US_STATE_CODES = new Set(
  ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY ' +
    'NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' ')
);

// Without the filter's map, fall back to the shape of US names: "City, ST"
// with a state code, or "Remote, US".
function isUsLocation(name, countries) {
  const n = String(name || '').trim();
  if (countries && countries.has(n)) return countries.get(n) === 'United States';
  const code = n.match(/, ([A-Z]{2})$/);
  return (code != null && US_STATE_CODES.has(code[1])) || /^Remote, US$/i.test(n);
}

function looksRelevantTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!/(engineer|scientist|developer|research)/.test(t)) return false;
  if (/\b(senior|staff|principal|lead|leadership|manager|director|head|vp|architect)\b/.test(t)) return false;
  // The API drops internships outright; don't spend a page fetch on them.
  if (/\bintern(ship)?s?\b|\bco-?op\b/.test(t)) return false;
  return true;
}

// All-jobs list -> US software seeds, deduped by id, in list order.
function selectSeeds(allJobs, countries) {
  const out = [];
  const seen = new Set();
  for (const job of allJobs || []) {
    const id = String(job?.id || '');
    const title = String(job?.title || '').replace(/\s+/g, ' ').trim();
    if (!/^\d+$/.test(id) || !title || seen.has(id)) continue;
    if (!looksRelevantTitle(title)) continue;
    const locations = (Array.isArray(job.locations) ? job.locations : []).map((l) => String(l).trim());
    const us = locations.filter((l) => isUsLocation(l, countries));
    if (!us.length) continue;
    seen.add(id);
    out.push({ id, title, location: us.join('; ') });
  }
  return out;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// The schema.org JobPosting in a job page, or null.
function extractJobPosting(html) {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of String(html || '').matchAll(re)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : [data];
    const posting = items.find((d) => d && d['@type'] === 'JobPosting');
    if (posting) return posting;
  }
  return null;
}

// Meta joins list items with "&nbsp;" and no other separator.
function asLines(text) {
  return decodeEntities(String(text || '').replace(/&nbsp;/g, '\n'))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function postingDetails(posting) {
  if (!posting) return null;
  const sections = [
    ['', posting.description],
    ['Responsibilities', posting.responsibilities],
    ['Qualifications', posting.qualifications],
  ]
    .map(([heading, body]) => {
      const text = asLines(body);
      return text ? (heading ? `${heading}:\n${text}` : text) : '';
    })
    .filter(Boolean);

  const places = Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : [];
  const countries = [
    ...new Set(
      places
        .map((p) => p?.address?.addressCountry)
        .map((c) => (typeof c === 'string' ? c : c?.name || ''))
        .filter(Boolean)
        .map((c) => (/^(us|usa|united states)$/i.test(c) ? 'US' : c))
    ),
  ];

  const posted = posting.datePosted ? new Date(posting.datePosted) : null;
  return {
    title: typeof posting.title === 'string' ? decodeEntities(posting.title).trim() : '',
    description: sections.join('\n\n').slice(0, MAX_DESCRIPTION_CHARS),
    date_posted: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
    countries,
  };
}

function buildRow(seed, details) {
  return {
    external_id: seed.id,
    company_name: 'Meta',
    job_title: details?.title || seed.title,
    location: seed.location,
    countries: details?.countries?.length ? details.countries : ['US'],
    apply_url: `${JOB_BASE}${seed.id}`,
    description: details?.description || '',
    date_posted: details?.date_posted || null,
  };
}

// Load the search page once and read the two GraphQL responses.
async function loadJobList(context) {
  const page = await context.newPage();
  let allJobs = null;
  let countries = null;
  page.on('response', async (res) => {
    try {
      if (!/\/graphql/.test(res.url())) return;
      const text = await res.text();
      for (const payload of parseGraphqlBody(text)) {
        allJobs = allJobs || extractAllJobs(payload);
        countries = countries || extractLocationCountries(payload);
      }
    } catch {}
  });

  try {
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeoutMs });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !(allJobs && countries)) {
      await page.waitForTimeout(500);
    }
    // The location map is nice to have; give it a moment more if the list came first.
    if (allJobs && !countries) await page.waitForTimeout(3000);
  } finally {
    await page.close().catch(() => {});
  }
  return { allJobs, countries };
}

async function fetchJobPage(context, id) {
  const res = await context.request.get(`${JOB_BASE}${id}/`, {
    timeout: CONFIG.navTimeoutMs,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'upgrade-insecure-requests': '1',
    },
  });
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  return res.text();
}

async function run(context) {
  const { allJobs, countries } = await loadJobList(context);
  if (!allJobs) {
    log.warn('target.meta.no-list', { url: SEARCH_URL });
    return [];
  }
  const seeds = selectSeeds(allJobs, countries);
  log.info('target.meta.search', {
    listed: allJobs.length,
    usSoftware: seeds.length,
    locationMap: countries ? countries.size : 0,
  });

  const rows = [];
  const started = Date.now();
  const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
  let failStreak = 0;
  let fetched = 0;
  let old = 0;
  let stop = 'end';
  let lastStart = 0;

  for (const seed of seeds) {
    if (rows.length >= MAX_DETAIL_ROWS) { stop = 'row-cap'; break; }
    if (Date.now() - started > DETAIL_BUDGET_MS) { stop = 'time-budget'; break; }
    // Sequential, and each request starts at least DETAIL_GAP_MS after the last.
    if (lastStart) await sleep(Math.max(0, DETAIL_GAP_MS - (Date.now() - lastStart)));
    lastStart = Date.now();

    let details = null;
    fetched++;
    try {
      details = postingDetails(extractJobPosting(await fetchJobPage(context, seed.id)));
      if (!details) throw new Error('no JobPosting');
      failStreak = 0;
    } catch (err) {
      failStreak++;
      log.warn('target.meta.detail-fail', { id: seed.id, error: err.message });
      // Keep the listing itself: it is still an open US role.
      rows.push(buildRow(seed, null));
      if (failStreak >= FAIL_STREAK_STOP) { stop = 'detail-failures'; break; }
      continue;
    }

    if (details.date_posted && new Date(details.date_posted).getTime() < cutoff) {
      old++;
      continue;
    }
    rows.push(buildRow(seed, details));
  }

  log.info('target.meta.details', {
    seeds: seeds.length,
    fetched,
    kept: rows.length,
    old,
    unfetched: seeds.length - fetched,
    stop,
    ms: Date.now() - started,
  });
  return rows;
}

module.exports = {
  run,
  source: 'meta',
  // exported for tests
  parseGraphqlBody,
  extractAllJobs,
  extractLocationCountries,
  isUsLocation,
  looksRelevantTitle,
  selectSeeds,
  extractJobPosting,
  postingDetails,
  buildRow,
};
