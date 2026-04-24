'use strict';

const { fetchJson } = require('./http');

// Uber's public career search — undocumented but no auth needed.
// Response shape: { status, data: { results: [...], totalResults: { low, high } } }
// Each result exposes `level` (3 = entry, 4 = mid, 5+ = senior), which we use
// to seed is_entry_level / is_mid_level flags more accurately than title parsing.

const SEARCH_URL = 'https://www.uber.com/api/loadSearchJobsResults?localeCode=en-us';

const QUERIES = [
  'Software Engineer',
  'Machine Learning',
  'Data Scientist',
  'Data Engineer',
  'Applied Scientist',
  'Platform Engineer',
  'Site Reliability',
  'DevOps',
  'Security Engineer',
];

async function fetchQuery(query) {
  const body = {
    params: {
      location: [{ countryName: 'United States' }],
      department: [],
      team: [],
      programAndPlatform: [],
      employmentType: [],
      query,
      pageNumber: 0,
      limit: 200,
    },
  };
  const data = await fetchJson(SEARCH_URL, {
    method: 'POST',
    body,
    headers: { 'x-csrf-token': 'x' },
    retries: 1,
  });
  return Array.isArray(data?.data?.results) ? data.data.results : [];
}

async function fetchCompany({ displayName }) {
  const byId = new Map();
  for (const q of QUERIES) {
    try {
      const rows = await fetchQuery(q);
      for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
    } catch {
      /* skip a single failed query, keep the rest */
    }
  }

  const out = [];
  for (const j of byId.values()) {
    // Drop senior+. Uber's internal levels: 3 entry, 4 mid, 5+ senior.
    if (typeof j.level === 'number' && j.level >= 5) continue;

    // Prefer first US location from allLocations; fall back to location object.
    const locs = Array.isArray(j.allLocations) && j.allLocations.length
      ? j.allLocations
      : j.location
      ? [j.location]
      : [];
    const usLocs = locs.filter((l) =>
      String(l?.countryName || '').toLowerCase().includes('united states')
    );
    const pick = usLocs[0] || locs[0];
    const location = pick
      ? [pick.city, pick.region].filter(Boolean).join(', ')
      : '';

    out.push({
      source: 'uber',
      external_id: String(j.id),
      company_name: displayName || 'Uber',
      job_title: j.title || '',
      location,
      apply_url: `https://www.uber.com/global/en/careers/list/${j.id}/`,
      description: j.description || '',
      date_posted: j.creationDate || j.updatedDate || null,
      // Level 3 = entry, 4 = mid per Uber's internal ladder — authoritative signal.
      entry_level_override: j.level === 3 ? 1 : undefined,
      mid_level_override: j.level === 4 ? 1 : undefined,
    });
  }
  return out;
}

module.exports = { fetchCompany, source: 'uber' };
