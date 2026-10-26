'use strict';

const { fetchJson } = require('./http');

// Dated by first_published, not updated_at. updated_at moves on any edit and on
// board-wide re-syncs: on 2026-10-26 all 2,502 Anduril jobs carried that day's
// updated_at, including a 2026 early-career role first published 2025-08-11.
// Reading it re-dated old postings to "today", floated them to the top of
// newest-first, and kept them clear of the retention window indefinitely.
function mapJob(j, { slug, displayName }) {
  return {
    source: 'greenhouse',
    external_id: j.id,
    company_name: displayName || slug,
    job_title: j.title || '',
    location: j.location?.name || '',
    apply_url: j.absolute_url || '',
    description: j.content || '',
    date_posted: j.first_published || j.updated_at || null,
  };
}

// Greenhouse public board API.
// content=true asks for job body HTML so we can classify sponsorship.
async function fetchCompany(company) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.slug)}/jobs?content=true`;
  const data = await fetchJson(url);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((j) => mapJob(j, company));
}

module.exports = { fetchCompany, mapJob, source: 'greenhouse' };
