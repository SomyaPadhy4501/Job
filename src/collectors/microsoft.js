'use strict';

const { fetchJson } = require('./http');

// Microsoft's apply.careers.microsoft.com fetches from a public PCSX API:
//   GET /api/pcsx/search?domain=microsoft.com&query=…&start=…&sort_by=…
// Anonymous access works (no auth, no cookies, no TLS issues) — earlier probes
// failed because they targeted the wrong path. Confirmed via network
// interception: the real frontend hits /api/pcsx/search, never /api/apply/v2.
//
// Response shape:
//   { status, error, data: { positions: [...], count: <totalCount>, … }, metadata }

const BASE = 'https://apply.careers.microsoft.com/api/pcsx/search';
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
const PAGE_SIZE = 10; // server-defined, can't override
const MAX_PAGES_PER_QUERY = 20; // 200 rows per query

async function fetchQuery(query) {
  const rows = [];
  for (let start = 0; start < MAX_PAGES_PER_QUERY * PAGE_SIZE; start += PAGE_SIZE) {
    const url =
      `${BASE}?domain=microsoft.com&query=${encodeURIComponent(query)}` +
      `&location=&start=${start}&sort_by=recent`;
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

async function fetchCompany({ displayName }) {
  const byId = new Map();
  for (const q of QUERIES) {
    try {
      const rows = await fetchQuery(q);
      for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
    } catch {
      /* one query failing is fine */
    }
  }

  const out = [];
  for (const p of byId.values()) {
    const id = p.id || p.displayJobId || p.atsJobId;
    const loc =
      Array.isArray(p.standardizedLocations) && p.standardizedLocations.length
        ? p.standardizedLocations.join(', ')
        : Array.isArray(p.locations)
        ? p.locations.join(', ')
        : p.locations || '';
    out.push({
      source: 'microsoft',
      external_id: id ? String(id) : null,
      company_name: displayName || 'Microsoft',
      job_title: p.name || '',
      location: loc,
      apply_url: p.positionUrl
        ? `https://jobs.careers.microsoft.com${p.positionUrl}`
        : `https://jobs.careers.microsoft.com/global/en/job/${id}`,
      description: '', // detail body requires a separate /api/pcsx/position_details call
      date_posted: p.postedTs || p.creationTs || null, // Unix seconds; normalize handles it
    });
  }
  return out;
}

module.exports = { fetchCompany, source: 'microsoft' };
