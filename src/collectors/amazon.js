'use strict';

const { fetchJson } = require('./http');

// amazon.jobs has a public JSON search endpoint. We query for a handful of role buckets
// scoped to the US and aggregate + dedupe by job id.
const QUERIES = [
  'software engineer',
  'software development engineer',
  'machine learning engineer',
  'applied scientist',
  'data scientist',
  'data engineer',
];

const PAGE_SIZE = 100;
const MAX_OFFSET_PER_QUERY = 400; // 4 pages per query

async function fetchQuery(q) {
  const rows = [];
  for (let offset = 0; offset < MAX_OFFSET_PER_QUERY; offset += PAGE_SIZE) {
    const url =
      `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q)}` +
      `&loc_query=United+States&country=USA&result_limit=${PAGE_SIZE}` +
      `&offset=${offset}&sort=recent`;
    const data = await fetchJson(url, { retries: 1 });
    const items = Array.isArray(data?.jobs) ? data.jobs : [];
    if (!items.length) break;
    rows.push(...items);
    if (offset + PAGE_SIZE >= (data.hits || 0)) break;
  }
  return rows;
}

async function fetchCompany({ displayName }) {
  const all = [];
  for (const q of QUERIES) {
    try {
      const rows = await fetchQuery(q);
      all.push(...rows);
    } catch {
      /* keep going on a single-query failure */
    }
  }

  const seen = new Set();
  const out = [];
  for (const j of all) {
    const id = j.id_icims || j.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const description = [j.description, j.basic_qualifications, j.preferred_qualifications]
      .filter(Boolean)
      .join('\n');

    out.push({
      source: 'amazon',
      external_id: String(id),
      company_name: displayName || 'Amazon',
      job_title: j.title || '',
      location:
        j.normalized_location ||
        j.location ||
        [j.city, j.state, j.country].filter(Boolean).join(', '),
      apply_url: j.job_path ? `https://www.amazon.jobs${j.job_path}` : '',
      description,
      date_posted: j.posted_date || null,
    });
  }
  return out;
}

module.exports = { fetchCompany, source: 'amazon' };
