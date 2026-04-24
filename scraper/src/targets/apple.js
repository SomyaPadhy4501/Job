'use strict';

const { runTarget } = require('./_base');

// jobs.apple.com is a server-rendered page that hydrates by calling an internal
// search API with a cookie-bound auth header. The exact path has shifted a few
// times (/api/role/search → /api/v1/jobs/search). Rather than pin one URL we
// match any Apple-origin /api/ endpoint whose JSON looks like a jobs listing.

const SEARCH_URL =
  'https://jobs.apple.com/en-us/search?search=Software+engineer&sort=relevance&location=united-states-USA';

function matches(url, method) {
  if (!url.startsWith('https://jobs.apple.com/')) return false;
  if (!url.includes('/api/')) return false;
  // Apple's frontend uses both GET and POST for search at various points.
  return method === 'GET' || method === 'POST';
}

// Extract from whichever list field Apple returns.
function extract(data) {
  const candidates = [
    data?.searchResults,
    data?.results,
    data?.jobs,
    data?.data?.searchResults,
    data?.data?.jobs,
  ];
  const rows = candidates.find((c) => Array.isArray(c) && c.length) || [];
  return rows.map((j) => {
    const id = j.positionId || j.id || j.jobId || j.reqId;
    const locs = j.locations || j.postingLocations || j.postLocation || j.location;
    const location = Array.isArray(locs)
      ? locs.map((l) => l?.name || l?.city || l).filter(Boolean).join(', ')
      : typeof locs === 'string'
      ? locs
      : locs?.name || '';
    return {
      external_id: id ? String(id) : '',
      company_name: 'Apple',
      job_title: j.postingTitle || j.title || j.jobTitle || '',
      location,
      apply_url: id
        ? `https://jobs.apple.com/en-us/details/${id}`
        : j.url || j.applyUrl || '',
      description: j.jobSummary || j.description || j.jobDescription || '',
      date_posted: j.postDateInGMT || j.postedDate || j.postingDate || null,
    };
  }).filter((r) => r.external_id && r.job_title);
}

async function run(context) {
  return runTarget(context, {
    name: 'apple',
    url: SEARCH_URL,
    responseMatcher: matches,
    extract,
    scrollCount: 8,
  });
}

module.exports = { run, source: 'apple' };
