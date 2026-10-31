'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel, looksUS } = require('../services/normalize');

// Generic Phenom-Cloud "PCSX" collector. The same API shape powers
// apply.careers.microsoft.com AND careers.qualcomm.com (and likely other
// enterprise Phenom tenants). Microsoft uses its own dedicated collector
// because of legacy URL conventions; this one is for everyone else.
//
//   GET {apiBase}?domain={domain}&query={q}&start={offset}&num={n}&sort_by=recent
//   → { status, error, data: { positions: [...], count, ... }, metadata }
//
// Config entry shape:
//   {
//     source: 'pcsx',
//     slug: 'qualcomm',
//     displayName: 'Qualcomm',
//     apiBase: 'https://careers.qualcomm.com/api/pcsx/search',
//     domain: 'qualcomm.com',
//     applyUrlBase: 'https://careers.qualcomm.com/careers',  // job page prefix
//   }

const QUERIES = [
  'software engineer',
  'machine learning',
  'data scientist',
  'data engineer',
  'applied scientist',
  'research engineer',
  'security engineer',
  'site reliability',
  'devops',
];
const PAGE_SIZE = 10;
const MAX_PAGES_PER_QUERY = 20; // 200 rows per query

async function fetchQuery(company, query) {
  const { apiBase, domain } = company;
  const rows = [];
  for (let start = 0; start < MAX_PAGES_PER_QUERY * PAGE_SIZE; start += PAGE_SIZE) {
    const url =
      `${apiBase}?domain=${encodeURIComponent(domain)}` +
      `&query=${encodeURIComponent(query)}` +
      `&location=&start=${start}&num=${PAGE_SIZE}&sort_by=recent`;
    let data;
    try {
      data = await fetchJson(url, { retries: 1 });
    } catch {
      break;
    }
    const positions = Array.isArray(data?.data?.positions) ? data.data.positions : [];
    if (!positions.length) break;
    rows.push(...positions);
    const total = Number(data.data?.count || 0);
    if (start + PAGE_SIZE >= total) break;
  }
  return rows;
}

function locationOf(p) {
  if (Array.isArray(p.standardizedLocations) && p.standardizedLocations.length) {
    return p.standardizedLocations.join(', ');
  }
  if (Array.isArray(p.locations)) return p.locations.join(', ');
  return p.locations || '';
}

// ─── Descriptions ────────────────────────────────────────────────────────────
//
// Search rows carry no body. The JD is one request per job:
//   {apiBase with /search → /position_details}?position_id=ID&domain=D
//   → { data: { jobDescription: '<html>', … } }
// Verified 2026-10-31 on Microsoft (6.4k chars) and Qualcomm (14k). Until this
// existed every Microsoft and Qualcomm row went through the classifiers on its
// title alone: sponsorship came from USCIS history, and a role that says
// "U.S. citizenship required" or "will not sponsor" looked open to a visa holder.
//
// Microsoft rate-limits in bursts (an HTTP 429 on a cold first request, verified
// the same day), so keep this modest. If it starts failing from CI, lower
// DETAIL_MAX first.
const DETAIL_MAX = 80;
const DETAIL_CONCURRENCY = 2;
const DETAIL_DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detailBase(apiBase) {
  return String(apiBase).replace(/\/search\/?$/, '/position_details');
}

// The same gates normalize applies, moved ahead of the per-job requests, newest
// first so that when the cap bites it is the oldest rows that go without. Rows
// already stored keep the JD they got when they were new (see upsertJob).
function pickForDetail(rows, max = DETAIL_MAX) {
  return rows
    .filter(
      (r) =>
        r.external_id &&
        (!CONFIG.filterSoftwareOnly || looksSoftware(r.job_title)) &&
        passesLevel(r.job_title, CONFIG.entryLevelMode || 'permissive') &&
        looksUS(r.location)
    )
    .sort((a, b) => (Number(b.date_posted) || 0) - (Number(a.date_posted) || 0))
    .slice(0, max);
}

async function fetchOneDescription(base, domain, id) {
  const data = await fetchJson(
    `${base}?position_id=${encodeURIComponent(id)}&domain=${encodeURIComponent(domain)}`,
    { retries: 1 }
  );
  return data?.data?.jobDescription ?? data?.jobDescription ?? '';
}

// Fills `description` on the rows worth reading, in place. A failed fetch leaves
// that row empty rather than failing the company.
async function addDescriptions(rows, { apiBase, domain }, fetchOne = fetchOneDescription) {
  const picked = pickForDetail(rows);
  const base = detailBase(apiBase);
  const bodies = await runWithConcurrency(picked, DETAIL_CONCURRENCY, async (r) => {
    await sleep(DETAIL_DELAY_MS);
    return fetchOne(base, domain, r.external_id);
  });
  let failed = 0;
  picked.forEach((r, i) => {
    if (typeof bodies[i] === 'string') r.description = bodies[i];
    else failed++;
  });
  if (failed) {
    console.warn(`[pcsx] ${domain}: ${failed}/${picked.length} description fetches failed — those rows keep no JD this run`);
  }
  return rows;
}

async function fetchCompany(company) {
  const { slug, displayName, apiBase, domain, applyUrlBase } = company;
  if (!apiBase || !domain || !applyUrlBase) {
    throw new Error(`pcsx company "${slug}" missing apiBase/domain/applyUrlBase`);
  }

  const byId = new Map();
  for (const q of QUERIES) {
    try {
      const rows = await fetchQuery(company, q);
      for (const r of rows) {
        const id = r.id || r.displayJobId || r.atsJobId;
        if (id && !byId.has(String(id))) byId.set(String(id), r);
      }
    } catch {
      /* one query failing is fine */
    }
  }

  const out = [];
  for (const p of byId.values()) {
    const id = p.id || p.displayJobId || p.atsJobId;
    out.push({
      source: 'pcsx',
      external_id: id ? String(id) : null,
      company_name: displayName || slug,
      job_title: p.name || '',
      location: locationOf(p),
      apply_url: p.positionUrl
        ? (p.positionUrl.startsWith('http') ? p.positionUrl : applyUrlBase + p.positionUrl)
        : `${applyUrlBase}/ShowJob/Id/${id}`,
      description: '',
      date_posted: p.postedTs || p.creationTs || null,
    });
  }
  await addDescriptions(out, { apiBase, domain });
  return out;
}

module.exports = { fetchCompany, addDescriptions, pickForDetail, detailBase, source: 'pcsx' };
