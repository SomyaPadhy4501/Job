'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// Collector for employers hosted on Rippling's ATS.
//
// Public, unauthenticated, two-tier:
//   list   https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
//   detail https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}
//
// The list is deliberately thin — name, url, uuid, department, workLocation and
// nothing else. No date, no description, no seniority. Everything that matters
// for classification lives on the detail endpoint (`createdOn`, plus a
// `description` object), so unlike SmartRecruiters the detail fetch is not
// optional polish here: without it a row has no date_posted and no restriction
// verdict. The title pre-filter runs first to keep that bounded.
//
// Rippling matters more than its size suggests because it's where companies
// migrate *to*. Opendoor is the case that surfaced it: they moved off
// Greenhouse, the configured `greenhouse/opendoor` slug started returning 404,
// and 74 postings became invisible except for the handful Getro happened to
// mirror.
//
// Config shape:
//   { source: 'rippling', slug, displayName, maxDetail }

const API_BASE = 'https://api.rippling.com/platform/api/ats/v1/board';

// Cap on detail fetches per employer per run. Every surviving candidate needs
// one, so this bounds the whole collector. Opendoor's 74 postings reduce to
// ~25 software titles, so this is generous rather than binding.
const DEFAULT_MAX_DETAIL = 150;
const DETAIL_CONCURRENCY = 4;

// `description` is an object of named rich-text blocks rather than a string.
// Both are joined: `company` carries boilerplate but `role` is where
// requirements — including work-authorization and clearance language — live.
// Unknown keys are included too, since the block names aren't documented and a
// tenant may use others.
function buildDescription(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  return Object.values(description)
    .filter((v) => typeof v === 'string' && v)
    .join('\n\n');
}

function buildLocation(job, detail) {
  const locs = detail?.workLocations;
  if (Array.isArray(locs) && locs.length) {
    return locs.map((l) => (typeof l === 'string' ? l : l?.label || l?.id || '')).filter(Boolean).join(', ');
  }
  const wl = job.workLocation;
  if (!wl) return '';
  return typeof wl === 'string' ? wl : wl.label || wl.id || '';
}

async function fetchDetail(slug, uuid) {
  return fetchJson(`${API_BASE}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(uuid)}`, {
    retries: 1,
  });
}

async function fetchCompany({ slug, displayName, maxDetail }) {
  if (!slug) throw new Error('rippling entry missing slug');
  const detailCap = maxDetail || DEFAULT_MAX_DETAIL;

  // The list endpoint returns the whole board in one response — no paging.
  const list = await fetchJson(`${API_BASE}/${encodeURIComponent(slug)}/jobs`, { retries: 1 });
  const jobs = Array.isArray(list) ? list : [];

  // Title pre-filter before spending a request per job. Same two gates
  // normalize applies, moved ahead of the expensive part.
  const candidates = [];
  for (const j of jobs) {
    const title = (j.name || '').trim();
    if (!title || !j.uuid) continue;
    if (CONFIG.filterSoftwareOnly && !looksSoftware(title)) continue;
    if (!passesLevel(title, CONFIG.entryLevelMode || 'permissive')) continue;
    candidates.push(j);
  }

  const toEnrich = candidates.slice(0, detailCap);
  const details = await runWithConcurrency(toEnrich, DETAIL_CONCURRENCY, (j) =>
    fetchDetail(slug, j.uuid)
  );

  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const detail = i < toEnrich.length && !details[i]?.__error ? details[i] : null;
    // Rippling lets an employer hide a posting from search while keeping it
    // reachable by link. Respect that rather than surfacing it as an open role.
    if (detail?.unlistedFromSearch) continue;
    out.push(mapJob(candidates[i], { slug, displayName, detail }));
  }

  return out;
}

// Pure field mapping, split out so it can be regression-tested without network
// access.
function mapJob(j, { slug, displayName, detail }) {
  return {
    source: 'rippling',
    external_id: String(j.uuid),
    // detail.companyName is the employer's own spelling and beats our config
    // label where the two differ.
    company_name: (detail?.companyName || displayName || slug).trim(),
    job_title: (j.name || '').trim(),
    location: buildLocation(j, detail),
    apply_url: j.url || detail?.url || `https://ats.rippling.com/${slug}/jobs/${j.uuid}`,
    description: buildDescription(detail?.description),
    // Deliberately null, even though `createdOn` is available and accurate.
    //
    // createdOn is a creation timestamp and Rippling exposes no updated/modified
    // counterpart, so it can't answer "is this still open?" — and these
    // employers keep postings live for months. Feeding it to date_posted put 21
    // of Opendoor's 24 open software roles outside the 30-day retention window:
    // the whole tenant collapsed to 1 row while every one of those jobs was
    // still listed and still applyable.
    //
    // A Rippling board only contains currently-open roles, so presence in the
    // feed IS the freshness signal. Null dates are exempt from the retention
    // check and pruned via last_seen_at once they leave the feed, which is the
    // same treatment Workday and Adzuna rows already get for the same reason.
    // The cost is that these rows sort without a posting date; the alternative
    // was discarding 88% of them.
    date_posted: null,
  };
}

module.exports = { fetchCompany, mapJob, buildDescription, buildLocation, source: 'rippling' };
