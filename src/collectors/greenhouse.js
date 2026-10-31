'use strict';

const { fetchJson } = require('./http');

// Greenhouse public board API.
// content=true asks for job body HTML so we can classify sponsorship.
async function fetchCompany({ slug, displayName }) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];

  return jobs.map((j) => ({
    source: 'greenhouse',
    external_id: j.id,
    company_name: displayName || slug,
    job_title: j.title || '',
    location: j.location?.name || '',
    apply_url: j.absolute_url || '',
    description: j.content || '',
    // first_published, not updated_at: any edit bumps updated_at, so a role
    // posted Oct 7 and touched Oct 31 showed as brand new (Reddit, DoorDash).
    date_posted: j.first_published || j.updated_at || null,
  }));
}

module.exports = { fetchCompany, source: 'greenhouse' };
