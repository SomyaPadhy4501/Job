'use strict';

const { runTarget } = require('./_base');

// Microsoft's apply.careers.microsoft.com fetches jobs from its own PCSX API:
//   GET /api/pcsx/search?domain=microsoft.com&query=…&start=…&sort_by=…
// The frontend paginates by scrolling, which fires additional /api/pcsx/search
// calls with increasing `start`. Playwright + response interception captures
// all of them.
//
// Response shape:
//   { status, error,
//     data: { positions: [position, ...], filterDef, count, appliedFilters, ... },
//     metadata }
// Each position has: id, name, standardizedLocations[], postedTs, creationTs,
// positionUrl, displayJobId, atsJobId, department.

const SEARCH_URL =
  'https://apply.careers.microsoft.com/careers?query=software+engineer&start=0&sort_by=recent';

function matches(url, method) {
  return method === 'GET' && url.includes('/api/pcsx/search');
}

function extract(data) {
  const positions = Array.isArray(data?.data?.positions) ? data.data.positions : [];
  return positions.map((p) => {
    const id = p.id || p.displayJobId || p.atsJobId;
    const loc =
      Array.isArray(p.standardizedLocations) && p.standardizedLocations.length
        ? p.standardizedLocations.join(', ')
        : Array.isArray(p.locations)
        ? p.locations.join(', ')
        : p.locations || '';
    return {
      external_id: id ? String(id) : '',
      company_name: 'Microsoft',
      job_title: p.name || '',
      location: loc,
      apply_url: p.positionUrl
        ? `https://jobs.careers.microsoft.com${p.positionUrl}`
        : `https://jobs.careers.microsoft.com/global/en/job/${id}`,
      description: '',
      date_posted: p.postedTs || p.creationTs || null, // Unix seconds
    };
  }).filter((r) => r.external_id && r.job_title);
}

async function run(context) {
  return runTarget(context, {
    name: 'microsoft',
    url: SEARCH_URL,
    responseMatcher: matches,
    extract,
    scrollCount: 10,
  });
}

module.exports = { run, source: 'microsoft' };
