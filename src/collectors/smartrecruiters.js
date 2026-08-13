'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// Collector for employers hosted on SmartRecruiters.
//
// SmartRecruiters publishes a documented, unauthenticated postings API — no key,
// no scraping, no bot gate:
//   https://api.smartrecruiters.com/v1/companies/{slug}/postings
//
// It's the richest of the ATS APIs we consume. The list response alone carries
// the posting date, a structured location, and an experience level, so unlike
// Workday or Adzuna these rows arrive fully classified without a detail fetch.
// The detail endpoint is used only to add description text.
//
// Server-side `country=us` is the important filter: it cuts Bosch from 4,812
// postings to 288, so a whole employer costs 3 requests. Note that
// `function=engineering` is accepted but silently ignored — role filtering has
// to happen locally.
//
// Config shape:
//   { source: 'smartrecruiters', slug, displayName, maxDetail }
//
// `slug` is SmartRecruiters' company identifier and is case-sensitive and exact
// ('BoschGroup', not 'bosch'). There is no company-search endpoint to discover
// it — `/v1/companies?q=` 404s — so use scripts/probe-smartrecruiters.js, which
// tries name variants against the postings API and keeps what answers.

const API_BASE = 'https://api.smartrecruiters.com/v1/companies';

// The API caps `limit` at 100 (200 returns 100).
const PAGE_SIZE = 100;

// Safety stop. With country=us applied, no employer tested comes close.
const MAX_POSTINGS = 2_000;

// Cap on description fetches per employer per run. Unlike Getro/Eightfold this
// cap costs only description text, never a row: apply_url, location, date and
// experience level all come from the list response, so an un-enriched row still
// makes it into the DB — it just relies on the USCIS company lookup for
// sponsorship and carries no `restriction` verdict.
const DEFAULT_MAX_DETAIL = 120;
const DETAIL_CONCURRENCY = 4;

// SmartRecruiters' own experienceLevel taxonomy. Trusted at the ends of the
// range only, same reasoning as the Getro seniority mapping: 'mid_senior_level'
// is the vendor lumping two levels together, so it becomes a mid stamp rather
// than a reject, and anything unrecognized is left to the title heuristics.
const LEVEL_REJECT = new Set(['director', 'executive', 'internship']);
const LEVEL_ENTRY = new Set(['entry_level', 'associate']);
const LEVEL_MID = new Set(['mid_senior_level']);

function buildLocation(loc) {
  if (!loc) return '';
  if (loc.fullLocation) return loc.fullLocation;
  const parts = [loc.city, loc.region, loc.country ? loc.country.toUpperCase() : ''].filter(Boolean);
  const base = parts.join(', ');
  return loc.remote ? (base ? `${base}, Remote` : 'Remote') : base;
}

// jobAd.sections is a fixed set of rich-text blocks. Concatenate the ones that
// can carry work-authorization language — qualifications and
// additionalInformation are where "must be authorized to work" and clearance
// requirements usually live, so dropping them would defeat the point of
// fetching the detail at all.
function buildDescription(detail) {
  const sections = detail?.jobAd?.sections;
  if (!sections) return '';
  return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((k) => sections[k]?.text || '')
    .filter(Boolean)
    .join('\n\n');
}

async function fetchPage(slug, offset) {
  const url =
    `${API_BASE}/${encodeURIComponent(slug)}/postings` +
    `?country=us&limit=${PAGE_SIZE}&offset=${offset}`;
  return fetchJson(url, { retries: 1 });
}

async function fetchDetail(slug, id) {
  return fetchJson(`${API_BASE}/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`, {
    retries: 1,
  });
}

async function fetchCompany({ slug, displayName, maxDetail }) {
  if (!slug) throw new Error('smartrecruiters entry missing slug');
  const detailCap = maxDetail || DEFAULT_MAX_DETAIL;

  const postings = [];
  for (let offset = 0; offset < MAX_POSTINGS; offset += PAGE_SIZE) {
    let data;
    try {
      data = await fetchPage(slug, offset);
    } catch (err) {
      // Nothing collected yet means the slug is wrong or the employer closed
      // their board — surface it rather than reporting an empty success.
      if (offset === 0) throw err;
      console.warn(
        `[smartrecruiters] ${slug}: paging stopped early at offset=${offset} ` +
          `(${postings.length} rows kept) — ${err.message}`
      );
      break;
    }

    const content = Array.isArray(data?.content) ? data.content : [];
    if (!content.length) break;
    postings.push(...content);

    if (postings.length >= (data.totalFound || 0)) break;
  }

  // Local filtering. Everything needed is already in the list response, so this
  // runs before any detail fetch.
  const candidates = [];
  for (const p of postings) {
    const title = (p.name || '').trim();
    if (!title || !p.id) continue;

    const level = p.experienceLevel?.id;
    if (LEVEL_REJECT.has(level)) continue;

    if (CONFIG.filterSoftwareOnly && !looksSoftware(title)) continue;
    if (!passesLevel(title, CONFIG.entryLevelMode || 'permissive')) continue;

    candidates.push({ posting: p, title, level });
  }

  // Newest first, so that when detailCap bites it's the oldest rows that go
  // without a description.
  candidates.sort(
    (a, b) =>
      new Date(b.posting.releasedDate || 0).getTime() -
      new Date(a.posting.releasedDate || 0).getTime()
  );

  const toEnrich = candidates.slice(0, detailCap);
  const details = await runWithConcurrency(toEnrich, DETAIL_CONCURRENCY, (c) =>
    fetchDetail(slug, c.posting.id)
  );

  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const detail = i < toEnrich.length && !details[i]?.__error ? details[i] : null;
    out.push(mapPosting(candidates[i].posting, { slug, displayName, detail }));
  }

  return out;
}

// Pure field mapping, split out so it can be regression-tested without network
// access.
function mapPosting(p, { slug, displayName, detail }) {
  const level = p.experienceLevel?.id;

  return {
    source: 'smartrecruiters',
    external_id: String(p.id),
    company_name: (p.company?.name || displayName || slug).trim(),
    job_title: (p.name || '').trim(),
    location: buildLocation(p.location),
    // The id-only posting URL resolves directly (HTTP 200, no redirect), so we
    // don't have to reconstruct SmartRecruiters' title slug — which is lossy
    // to rebuild, since trailing punctuation becomes a trailing dash. This
    // fallback is why detailCap can never cost us a row, only its description.
    apply_url:
      detail?.applyUrl ||
      detail?.postingUrl ||
      `https://jobs.smartrecruiters.com/${encodeURIComponent(slug)}/${encodeURIComponent(p.id)}`,
    description: detail ? buildDescription(detail) : '',
    date_posted: p.releasedDate || null,
    entry_level_override: LEVEL_ENTRY.has(level) ? 1 : undefined,
    mid_level_override: LEVEL_MID.has(level) ? 1 : undefined,
  };
}

module.exports = {
  fetchCompany,
  mapPosting,
  buildLocation,
  buildDescription,
  source: 'smartrecruiters',
};
