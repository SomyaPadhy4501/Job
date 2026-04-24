'use strict';

const { fetchJson } = require('./http');

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
  return out;
}

module.exports = { fetchCompany, source: 'pcsx' };
