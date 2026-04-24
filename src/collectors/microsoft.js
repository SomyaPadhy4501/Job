'use strict';

const { fetchJson } = require('./http');

// Microsoft's public careers search: paginated JSON, no auth.
// Description is only in the detail endpoint, which we fetch for relevant rows.

const QUERIES = [
  'Software Engineer',
  'Machine Learning',
  'Data Scientist',
  'Data Engineer',
  'Applied Scientist',
];

const PAGE_SIZE = 20;
const MAX_PAGES = 10; // 200 per query

async function fetchSearchPage(q, page) {
  const url =
    `https://gcsservices.careers.microsoft.com/search/api/v1/search` +
    `?q=${encodeURIComponent(q)}&lc=United%20States&l=en_us` +
    `&pg=${page}&pgSz=${PAGE_SIZE}&o=Recent&flt=true`;
  const data = await fetchJson(url, { retries: 1 });
  return data?.operationResult?.result?.jobs || [];
}

async function fetchDetail(jobId) {
  try {
    const data = await fetchJson(
      `https://gcsservices.careers.microsoft.com/search/api/v1/job/${encodeURIComponent(jobId)}?lang=en_us`,
      { retries: 1 }
    );
    const info = data?.operationResult?.result || {};
    return [info.description, info.qualifications, info.responsibilities]
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

async function fetchCompany({ displayName }) {
  const rowsById = new Map();

  for (const q of QUERIES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let jobs = [];
      try {
        jobs = await fetchSearchPage(q, page);
      } catch {
        break;
      }
      if (!jobs.length) break;
      for (const j of jobs) {
        const id = j.jobId || j.JobId || j.id;
        if (!id || rowsById.has(id)) continue;
        rowsById.set(id, j);
      }
      if (jobs.length < PAGE_SIZE) break;
    }
  }

  const merged = Array.from(rowsById.entries());
  const out = [];
  // Cap detail enrichment to keep network traffic bounded.
  const ENRICH_CAP = 80;
  let enriched = 0;

  for (const [id, j] of merged) {
    const title = j.title || j.Title || '';
    const location =
      j.primaryLocation ||
      j.properties?.primaryLocation ||
      j.locations?.[0]?.location ||
      j.jobPropertiesFormatted?.primaryLocation ||
      '';
    let description = j.shortDescription || j.description || '';

    if (!description && enriched < ENRICH_CAP) {
      description = await fetchDetail(id);
      enriched++;
    }

    out.push({
      source: 'microsoft',
      external_id: String(id),
      company_name: displayName || 'Microsoft',
      job_title: title,
      location,
      apply_url: `https://jobs.careers.microsoft.com/global/en/job/${encodeURIComponent(id)}`,
      description: description || '',
      date_posted: j.postingDate || j.postedDate || null,
    });
  }

  return out;
}

module.exports = { fetchCompany, source: 'microsoft' };
