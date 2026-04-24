'use strict';

const { fetchJson } = require('./http');

// Ashby public job-board API. Returns { jobs: [...] } with descriptionHtml on each posting.
async function fetchCompany({ slug, displayName }) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((j) => ({
    source: 'ashby',
    external_id: j.id,
    company_name: displayName || slug,
    job_title: j.title || '',
    location: j.location || j.locationName || '',
    apply_url: j.jobUrl || j.applyUrl || '',
    description: j.descriptionHtml || j.descriptionPlain || '',
    date_posted: j.publishedAt || j.updatedAt || null,
  }));
}

module.exports = { fetchCompany, source: 'ashby' };
