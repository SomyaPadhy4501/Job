'use strict';

const { runTarget } = require('./_base');

// Google's careers page at /about/careers/applications/jobs/results/ is
// JS-rendered via their internal "/_/careersfrontend/.../SearchJobs" RPC.
// The exact RPC path is obfuscated in their bundle, but the responses all
// route through /_/careersfrontend/ (or /_/CareersPublicUi/). We match any
// POST response under those prefixes that deserialises to JSON with a list
// of job-shaped objects.

const SEARCH_URL =
  'https://www.google.com/about/careers/applications/jobs/results/?q=software+engineer&location=United+States&sort_by=date';

function matches(url, method) {
  return (
    (method === 'POST' || method === 'GET') &&
    (url.includes('/_/careersfrontend') ||
      url.includes('/_/CareersPublicUi') ||
      url.includes('jobs.googleapis.com') ||
      url.includes('/careers/rpc/'))
  );
}

// Google's RPC responses are AF_rpc-wrapped arrays. Walk the tree for
// anything that looks like a job entry.
function walkForJobs(obj, out, depth = 0) {
  if (!obj || depth > 10) return;
  if (Array.isArray(obj)) { for (const x of obj) walkForJobs(x, out, depth + 1); return; }
  if (typeof obj !== 'object') return;

  const hasTitle = obj.title || obj.jobTitle || obj.job_title;
  const hasLoc = obj.locations || obj.location || obj.cityState;
  const hasLink = obj.applyUrl || obj.apply_url || obj.jobUrl || obj.url || obj.applicationUrl;
  if (hasTitle && hasLoc && hasLink) { out.push(obj); return; }

  for (const k of Object.keys(obj)) walkForJobs(obj[k], out, depth + 1);
}

function extract(data) {
  const rows = [];
  walkForJobs(data, rows);
  return rows.map((j) => {
    const locs = j.locations || j.location || j.cityState;
    const location = Array.isArray(locs)
      ? locs.map((l) => l?.city || l?.display || l?.name || l).filter(Boolean).join(', ')
      : String(locs?.display || locs?.city || locs || '');
    const apply = j.applyUrl || j.apply_url || j.jobUrl || j.applicationUrl || j.url || '';
    return {
      external_id: String(j.id || j.jobId || j.requisition || apply),
      company_name: 'Google',
      job_title: j.title || j.jobTitle || j.job_title,
      location,
      apply_url: apply.startsWith('http') ? apply : `https://www.google.com${apply}`,
      description: j.description || j.summary || '',
      date_posted: j.postedDate || j.publishDate || j.date_posted || null,
    };
  }).filter((r) => r.external_id && r.job_title && r.apply_url);
}

async function run(context) {
  return runTarget(context, {
    name: 'google',
    url: SEARCH_URL,
    responseMatcher: matches,
    extract,
    scrollCount: 10,
  });
}

module.exports = { run, source: 'google' };
