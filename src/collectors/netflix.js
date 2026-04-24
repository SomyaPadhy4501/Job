'use strict';

const { fetchJson } = require('./http');

// Netflix's public career site is powered by Eightfold AI. The underlying
// `/api/apply/v2/jobs` JSON endpoint is open (no auth, no cookies) as long as
// the right `domain` query param is set. Response shape:
//   { positions: [{ id, name, location, locations, t_create, t_update,
//                   department, business_unit, canonicalPositionUrl, ... }],
//     count: <number> }

const BASE = 'https://explore.jobs.netflix.net/api/apply/v2/jobs';
const QUERIES = [
  'software engineer',
  'machine learning',
  'data scientist',
  'data engineer',
  'platform engineer',
  'site reliability',
  'security engineer',
];
const PAGE_SIZE = 100;
const MAX_PER_QUERY = 400;

// Netflix uses L-levels in titles (e.g., "Software Engineer L4/L5, ..."). We
// reject L6+ outright and use L-levels as a stronger signal than the title
// regex for entry/mid flags.
function netflixLevelSignal(title) {
  const m = (title || '').match(/\bL(\d)(?:\/L?(\d))?/i);
  if (!m) return { reject: false };
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (hi >= 6) return { reject: true };
  // L3 = entry, L4 = early-mid — treat L3 or L3/L4 as entry, L4/L5 as mid.
  if (lo === 3) return { reject: false, entry: 1 };
  if (lo === 4) return { reject: false, mid: 1 };
  return { reject: false }; // L5 alone: let normalize decide
}

async function fetchQuery(query) {
  const rows = [];
  for (let start = 0; start < MAX_PER_QUERY; start += PAGE_SIZE) {
    const url = `${BASE}?domain=netflix.com&start=${start}&num=${PAGE_SIZE}&query=${encodeURIComponent(query)}&sort_by=relevance`;
    const data = await fetchJson(url, { retries: 1 });
    const positions = Array.isArray(data?.positions) ? data.positions : [];
    if (!positions.length) break;
    rows.push(...positions);
    if (start + PAGE_SIZE >= (data.count || 0)) break;
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
      /* a single query failure is fine */
    }
  }

  const out = [];
  for (const j of byId.values()) {
    const lvl = netflixLevelSignal(j.name);
    if (lvl.reject) continue;

    const loc =
      Array.isArray(j.locations) && j.locations.length
        ? j.locations.join(', ')
        : j.location || '';

    out.push({
      source: 'netflix',
      external_id: String(j.id),
      company_name: displayName || 'Netflix',
      job_title: j.name || j.posting_name || '',
      location: loc,
      apply_url: j.canonicalPositionUrl || `https://explore.jobs.netflix.net/careers/job/${j.id}`,
      description: j.job_description || '',
      date_posted: j.t_update || j.t_create || null, // Unix seconds; normalize handles it
      entry_level_override: lvl.entry,
      mid_level_override: lvl.mid,
    });
  }
  return out;
}

module.exports = { fetchCompany, source: 'netflix' };
