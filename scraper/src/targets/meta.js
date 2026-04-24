'use strict';

const { runTarget } = require('./_base');

// metacareers.com is a Relay GraphQL SPA. The search page posts to /graphql
// with an fb_dtsg CSRF token and a rotating `doc_id` for the
// CareersJobSearchResultsDataQuery operation. Letting Playwright load the page
// means the browser does the CSRF/doc_id handshake for us; we just intercept
// the /graphql responses and keep the ones with job_results in them.

const SEARCH_URL =
  'https://www.metacareers.com/jobsearch?q=Software+Engineer&offices%5B0%5D=United+States';

function matches(url, method) {
  return method === 'POST' && url.includes('metacareers.com/graphql');
}

// Meta's GraphQL responses are batched and deeply nested. Walk the tree and
// pull out anything that has the shape of a job row.
function walkForJobs(obj, out, depth = 0) {
  if (!obj || depth > 10) return;
  if (Array.isArray(obj)) { for (const x of obj) walkForJobs(x, out, depth + 1); return; }
  if (typeof obj !== 'object') return;

  // Meta job nodes typically carry id + title + locations + url on metacareers.
  if ((obj.title || obj.job_title) && (obj.id || obj.__id) && (obj.locations || obj.primary_location || obj.cities)) {
    out.push(obj);
    return;
  }
  for (const k of Object.keys(obj)) walkForJobs(obj[k], out, depth + 1);
}

function extract(data) {
  const rows = [];
  walkForJobs(data, rows);
  return rows.map((j) => {
    const id = j.id || j.__id || j.posting_id;
    const locs = j.locations || j.cities || (j.primary_location ? [j.primary_location] : []);
    const location = Array.isArray(locs)
      ? locs.map((l) => l?.title || l?.name || l).filter(Boolean).join(', ')
      : String(locs || '');
    return {
      external_id: String(id),
      company_name: 'Meta',
      job_title: j.title || j.job_title,
      location,
      apply_url: `https://www.metacareers.com/jobs/${id}/`,
      description: j.description || j.short_description || '',
      date_posted: j.created_time || j.date_posted || null,
    };
  }).filter((r) => r.external_id && r.job_title);
}

async function run(context) {
  return runTarget(context, {
    name: 'meta',
    url: SEARCH_URL,
    responseMatcher: matches,
    extract,
    scrollCount: 10,
  });
}

module.exports = { run, source: 'meta' };
