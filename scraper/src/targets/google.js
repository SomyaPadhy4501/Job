'use strict';

const { CONFIG } = require('../config');
const log = require('../logger');

// Google Careers (google.com/about/careers/applications/jobs/results).
//
// The results page is server-rendered: every page of 20 carries the full job
// records in an `AF_initDataCallback({key: 'ds:1', ...})` script block —
// title, locations with country codes, description, qualifications, dates and
// Google's own experience level. So we fetch the HTML over plain HTTP (the
// browser context's request client, no page rendering), page through with
// `page=`, and never open a job's detail page.
//
// We list every US job at the Early and Mid levels, sorted newest first
// (stopping once a whole page is past MAX_AGE_DAYS), and keep software-type
// titles here; the API's normalizer makes the final call
// on role, level and age. Advanced (staff+) roles are left out at the source.
//
// Until 2026-11-24 this target rendered two pages per keyword query and read
// the cards from the DOM: 40 cards at most per query, most of them Senior or
// Staff, so each query yielded 3-13 seeds and the run 14 rows.

const SEARCH_BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
const JOB_BASE = 'https://www.google.com/about/careers/applications/jobs/results/';

// One crawl per level keeps each under the page cap: on 2026-11-24 the US had
// 67 Early and 804 Mid openings (4 and 41 pages of 20).
const LEVELS = ['EARLY', 'MID'];
// The `target_level` filter's values as they come back in each record (field 20).
const LEVEL_CODES = { 1: 'EARLY', 2: 'MID', 3: 'ADVANCED' };

const GOOGLE_COMPANIES = new Set(['google', 'youtube', 'deepmind', 'google deepmind']);

const MAX_PAGES_PER_CRAWL = 40;
// The list is newest first. The API keeps postings up to RETENTION_DAYS (14)
// old; stop a crawl at the first page that is entirely older than this.
const MAX_AGE_DAYS = 30;
const REQUEST_GAP_MS = 1200;
const MAX_DESCRIPTION_CHARS = 20_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function googleSearchUrl({ level, page = 1 } = {}) {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set('location', 'United States');
  if (level) url.searchParams.append('target_level', level);
  url.searchParams.set('sort_by', 'date');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

// The `ds:1` block: [jobs, null, totalCount, pageSize]. Picked by shape rather
// than by key, in case Google renumbers the blocks.
function extractGoogleData(html) {
  const source = String(html || '');
  const re = /AF_initDataCallback\(\{key: '(ds:\d+)', hash: '[^']*', data:([\s\S]*?), sideChannel: \{\}\}\);<\/script>/g;
  for (const match of source.matchAll(re)) {
    let data;
    try {
      data = JSON.parse(match[2]);
    } catch {
      continue;
    }
    if (!Array.isArray(data) || !Array.isArray(data[0])) continue;
    const jobs = data[0];
    const looksLikeJobs =
      jobs.length === 0
        ? typeof data[2] === 'number'
        : jobs.every((j) => Array.isArray(j) && /^\d+$/.test(String(j[0])) && typeof j[1] === 'string');
    if (!looksLikeJobs) continue;
    return {
      jobs,
      total: typeof data[2] === 'number' ? data[2] : null,
      pageSize: typeof data[3] === 'number' ? data[3] : null,
    };
  }
  return null;
}

// The cards link to `jobs/results/<id>-<slug>?...`; keep the slugged path so
// apply URLs match the ones already stored for Google.
function extractDetailPaths(html) {
  const out = new Map();
  const re = /href="(?:[^"]*\/)?jobs\/results\/(\d+)-([a-z0-9-]+)[?"]/g;
  for (const m of String(html || '').matchAll(re)) {
    if (!out.has(m[1])) out.set(m[1], `${m[1]}-${m[2]}`);
  }
  return out;
}

function looksRelevantTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!/(engineer|scientist|developer|research|\bsre\b)/.test(t)) return false;
  if (/\b(senior|staff|principal|lead|manager|director|head|vp|architect)\b/.test(t)) return false;
  if (/\bintern(ship)?s?\b|\bco-?op\b|\bapprentice/.test(t)) return false;
  // Software Engineer II/III are Google's entry and early-mid rungs; IV and up
  // are not. "III" stays and the API judges it by the stated years.
  if (/\b(iv|v|vi)\b/.test(t)) return false;
  return true;
}

function htmlField(field) {
  return Array.isArray(field) && typeof field[1] === 'string' ? field[1].trim() : '';
}

// [seconds, nanos] -> ISO string.
function timestampToIso(ts) {
  if (!Array.isArray(ts) || typeof ts[0] !== 'number') return null;
  const d = new Date(ts[0] * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function recordPublishedIso(record) {
  return timestampToIso(record?.[14]) || timestampToIso(record?.[13]) || timestampToIso(record?.[12]);
}

// True when every record on the page was published before `cutoffMs`.
function pageIsOlderThan(records, cutoffMs) {
  if (!records.length) return false;
  return records.every((r) => {
    const iso = recordPublishedIso(r);
    return iso != null && new Date(iso).getTime() < cutoffMs;
  });
}

// One record from the `ds:1` jobs array. Field positions (2026-11-24):
//   0 id, 1 title, 3 responsibilities, 4 qualifications, 7 company,
//   9 locations [[display, addresses, city, zip, state, country]],
//   10 about the job, 12 created, 13 modified, 14 published,
//   20 level (1 Early, 2 Mid, 3 Advanced).
// Returns null for rows we don't want (no US location, wrong level, title).
function parseGoogleJob(record, detailPaths = new Map()) {
  if (!Array.isArray(record)) return null;
  const id = String(record[0] || '');
  const title = String(record[1] || '').replace(/\s+/g, ' ').trim();
  if (!/^\d+$/.test(id) || !title) return null;
  if (!looksRelevantTitle(title)) return null;

  const level = LEVEL_CODES[record[20]] || null;
  if (level && level !== 'EARLY' && level !== 'MID') return null;

  const locations = (Array.isArray(record[9]) ? record[9] : [])
    .filter((l) => Array.isArray(l) && typeof l[0] === 'string')
    .map((l) => ({ name: l[0].trim(), country: typeof l[5] === 'string' ? l[5] : '' }));
  const usLocations = locations.filter((l) => l.country === 'US');
  if (!usLocations.length) return null;

  const about = htmlField(record[10]);
  const responsibilities = htmlField(record[3]);
  const qualifications = htmlField(record[4]);
  const description = [
    about && `<h3>About the job</h3>${about}`,
    qualifications,
    responsibilities && `<h3>Responsibilities</h3>${responsibilities}`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_DESCRIPTION_CHARS);

  // Google, YouTube and DeepMind roles are all Google's (as before, stored
  // under "Google"). Waymo, Wing and the other Alphabet companies listed here
  // are skipped: Waymo has its own Greenhouse feed.
  const company = typeof record[7] === 'string' ? record[7].trim() : '';
  if (company && !GOOGLE_COMPANIES.has(company.toLowerCase())) return null;
  const path = detailPaths.get(id) || id;

  return {
    external_id: id,
    company_name: 'Google',
    job_title: title,
    location: usLocations.map((l) => l.name).join('; '),
    countries: ['US'],
    apply_url: `${JOB_BASE}${path}`,
    description,
    date_posted: recordPublishedIso(record),
    entry_level_override: level === 'EARLY' ? 1 : undefined,
    mid_level_override: level === 'MID' ? 1 : undefined,
  };
}

async function fetchHtml(context, url) {
  const res = await context.request.get(url, {
    timeout: CONFIG.navTimeoutMs,
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  return res.text();
}

async function crawlLevel(context, level, byId) {
  let pages = 0;
  let seen = 0;
  let kept = 0;
  let total = null;
  let stoppedAtAge = false;

  for (let page = 1; page <= MAX_PAGES_PER_CRAWL; page++) {
    if (page > 1) await sleep(REQUEST_GAP_MS);
    const url = googleSearchUrl({ level, page });
    let html;
    try {
      html = await fetchHtml(context, url);
    } catch (err) {
      log.warn('target.google.page-fail', { level, page, error: err.message });
      break;
    }
    const data = extractGoogleData(html);
    if (!data) {
      log.warn('target.google.no-data', { level, page });
      break;
    }
    pages++;
    if (total == null) total = data.total;
    if (!data.jobs.length) break;

    const paths = extractDetailPaths(html);
    for (const record of data.jobs) {
      seen++;
      const row = parseGoogleJob(record, paths);
      if (!row || byId.has(row.external_id)) continue;
      byId.set(row.external_id, row);
      kept++;
    }

    const pageSize = data.pageSize || data.jobs.length;
    if (total != null && page * pageSize >= total) break;
    if (pageIsOlderThan(data.jobs, Date.now() - MAX_AGE_DAYS * 86_400_000)) {
      stoppedAtAge = true;
      break;
    }
    if (page === MAX_PAGES_PER_CRAWL && total != null && page * pageSize < total) {
      log.warn('target.google.page-cap', { level, total, listed: page * pageSize });
    }
  }

  log.info('target.google.search', { level, total, pages, seen, kept, stoppedAtAge });
}

async function run(context) {
  const byId = new Map();
  for (const [i, level] of LEVELS.entries()) {
    if (i > 0) await sleep(REQUEST_GAP_MS);
    await crawlLevel(context, level, byId);
  }
  return [...byId.values()];
}

module.exports = {
  run,
  source: 'google',
  // exported for tests
  googleSearchUrl,
  extractGoogleData,
  extractDetailPaths,
  parseGoogleJob,
  pageIsOlderThan,
  looksRelevantTitle,
};
