'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// Generic collector for career sites powered by Eightfold AI.
//
// Eightfold exposes an open `/api/apply/v2/jobs` endpoint on every tenant that
// hasn't turned it off — no auth, no cookies — as long as the tenant's `domain`
// query param is set. This module is the tenant-agnostic implementation;
// src/collectors/netflix.js is a thin wrapper that supplies Netflix's host plus
// its L-level seniority hook, so there is one paging/enrichment path rather
// than one per tenant.
//
// Response shape:
//   { positions: [{ id, name, location, locations, t_create, t_update,
//                   department, business_unit, canonicalPositionUrl, ... }],
//     count: <number> }
//
// Two things about tenant discovery, learned the hard way (2026-08-13):
//
//   - The `{slug}.eightfold.ai` host works for some tenants (Bayer, NetApp) and
//     404s or 403s for others (Nutanix, Micron, Dolby, Vodafone). A 403 is the
//     tenant disabling anonymous API access, not a user-agent block — a browser
//     UA does not change it. Don't chase those.
//   - Other tenants front the same API on a vanity host (Netflix uses
//     explore.jobs.netflix.net). The host is not derivable from the company
//     name, so probe it and record the working `apiBase` in config.
//
// Config shape:
//   { source: 'eightfold', slug, displayName, apiBase, domain, maxDetail }

// The API hard-caps a page at 10 positions on every tenant tested (Netflix,
// Bayer, NetApp all return 10 for num=25/50/100). This is a server limit, not a
// tunable. It has to match the `start` step exactly: the previous
// single-tenant Netflix collector asked for num=100 and advanced start by 100,
// so it silently skipped 90 of every 100 postings and only ever saw ~10% of the
// catalogue — which is why Netflix contributed 19 rows out of 490 postings.
const PAGE_SIZE = 10;

// Safety stop on paging. Tenants seen so far are small (Netflix 490, Bayer 627,
// NetApp 283), so this is generous rather than binding.
const MAX_POSITIONS = 3_000;

// ─── Rate limiting: read this before raising any number below ──────────────
//
// Eightfold's edge blocks by IP across ALL tenants at once. During development
// (2026-08-13) a few full-catalogue runs plus description fetches got every
// tenant — including Netflix, which had been working seconds earlier — returning
// HTTP 403 simultaneously, and the block persisted across retries. It is not a
// user-agent check and not per-tenant.
//
// The budget per tenant per run is therefore roughly:
//   ceil(count / 10) page requests  +  up to DEFAULT_MAX_DETAIL detail requests
// which for Netflix's 490 postings is 49 + 60 ≈ 110 requests. Keep the total
// modest and spaced. If tenants start 403ing in production, lower
// DEFAULT_MAX_DETAIL first — descriptions are the bulk of the volume — then
// raise PAGE_DELAY_MS.
const DEFAULT_MAX_DETAIL = 60;
const DETAIL_CONCURRENCY = 2;
const PAGE_DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// No sort parameter is applied: `sort_by` is accepted but ignored (timestamp,
// relevance and recent all return identical ordering), so results arrive in an
// arbitrary order and we sort locally instead — see the candidate sort below.
async function fetchPage(apiBase, domain, start) {
  const url =
    `${apiBase}?domain=${encodeURIComponent(domain)}` +
    `&start=${start}&num=${PAGE_SIZE}`;
  return fetchJson(url, { retries: 1 });
}

// The list endpoint returns `job_description: ''` for every row — the text only
// comes back from the per-job endpoint (`/api/apply/v2/jobs/{id}?domain=…`,
// verified returning 5k+ chars for NetApp). Worth one request per surviving
// candidate because both `restriction` (clearance / ITAR / citizenship) and the
// description half of the sponsorship classifier are dead without it. Netflix
// rows have been landing with empty descriptions for exactly this reason.
async function enrichDescription(apiBase, domain, id) {
  const data = await fetchJson(
    `${apiBase}/${encodeURIComponent(id)}?domain=${encodeURIComponent(domain)}`,
    { retries: 1 }
  );
  // The endpoint returns the position object directly, not wrapped in
  // `positions`, but tolerate both in case a tenant differs.
  const pos = data?.positions?.[0] || data;
  return pos?.job_description || '';
}

async function fetchEightfold({
  source,
  slug,
  displayName,
  apiBase,
  domain,
  maxDetail,
  // Optional per-tenant seniority hook. Given a title, returns
  // { reject?, entry?, mid? }. Used where a tenant encodes level in the title
  // in a way our generic title regex can't read (Netflix's L3/L4/L5).
  levelSignal,
}) {
  if (!apiBase) throw new Error(`eightfold entry "${slug}" missing apiBase`);
  if (!domain) throw new Error(`eightfold entry "${slug}" missing domain`);

  const detailCap = maxDetail || DEFAULT_MAX_DETAIL;

  // Page the full catalogue. These tenants are small enough that pulling
  // everything and filtering locally is both cheaper and more complete than the
  // keyword fan-out this collector used to do for Netflix — a fan-out can only
  // ever find titles matching the query list.
  const byId = new Map();
  for (let start = 0; start < MAX_POSITIONS; start += PAGE_SIZE) {
    if (start > 0) await sleep(PAGE_DELAY_MS);

    let data;
    try {
      data = await fetchPage(apiBase, domain, start);
    } catch (err) {
      // Nothing collected yet means the tenant is broken or has closed the API;
      // report it rather than returning an empty list that reads as success.
      if (start === 0) throw err;
      console.warn(
        `[eightfold] ${slug}: paging stopped early at start=${start} ` +
          `(${byId.size} rows kept) — ${err.message}`
      );
      break;
    }

    const positions = Array.isArray(data?.positions) ? data.positions : [];
    if (!positions.length) break;
    for (const p of positions) if (!byId.has(p.id)) byId.set(p.id, p);

    if (start + PAGE_SIZE >= (data.count || 0)) break;
  }

  // Title pre-filter before spending a request per description. Same two gates
  // normalize applies, just moved ahead of the expensive part.
  const candidates = [];
  for (const p of byId.values()) {
    const title = p.name || p.posting_name || '';
    if (!title) continue;

    const lvl = levelSignal ? levelSignal(title) : null;
    if (lvl?.reject) continue;

    if (CONFIG.filterSoftwareOnly && !looksSoftware(title)) continue;
    if (!passesLevel(title, CONFIG.entryLevelMode || 'permissive')) continue;

    candidates.push({ position: p, title, lvl });
  }

  // The API returns no useful ordering, so sort newest-first ourselves. This
  // only matters because of detailCap below: when it bites, the rows that lose
  // their description should be the oldest ones, not an arbitrary slice.
  candidates.sort(
    (a, b) =>
      (b.position.t_update || b.position.t_create || 0) -
      (a.position.t_update || a.position.t_create || 0)
  );

  const toEnrich = candidates.slice(0, detailCap);
  const descriptions = await runWithConcurrency(toEnrich, DETAIL_CONCURRENCY, (c) =>
    enrichDescription(apiBase, domain, c.position.id)
  );

  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const { position: p, title, lvl } = candidates[i];
    const desc = typeof descriptions[i] === 'string' ? descriptions[i] : '';
    out.push(mapPosition(p, { source, slug, displayName, title, lvl, description: desc }));
  }

  return out;
}

// Pure field mapping, split out so it can be regression-tested without network
// access.
function mapPosition(p, { source, slug, displayName, title, lvl, description }) {
  const location =
    Array.isArray(p.locations) && p.locations.length ? p.locations.join(', ') : p.location || '';

  return {
    source,
    external_id: String(p.id),
    company_name: displayName || slug,
    job_title: title || p.name || p.posting_name || '',
    location,
    description: description || p.job_description || '',
    apply_url: p.canonicalPositionUrl || '',
    // t_update first, NOT t_create — this ordering is load-bearing. Eightfold
    // employers keep postings open for months (Netflix's catalogue includes
    // live 2024 and 2025 rows), so t_create puts nearly every row outside the
    // 30-day retention window in normalize and the whole tenant collects to
    // zero. t_update tracks "this posting is still being maintained", which is
    // the question retention is actually asking. Closed postings are pruned by
    // last_seen_at in pruneStaleJobs instead.
    // Unix seconds — parseDateToIso handles the scaling.
    date_posted: p.t_update || p.t_create || null,
    entry_level_override: lvl?.entry,
    mid_level_override: lvl?.mid,
  };
}

// Config-driven entry point for plain tenants (no per-tenant level hook).
async function fetchCompany(company) {
  return fetchEightfold({ ...company, source: 'eightfold' });
}

module.exports = { fetchCompany, fetchEightfold, mapPosition, source: 'eightfold' };
