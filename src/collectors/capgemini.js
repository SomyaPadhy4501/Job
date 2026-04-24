'use strict';

const { fetchJson } = require('./http');

// Capgemini's public job search is backed by a standalone Azure-hosted API
// that returns its full global job catalog:
//   GET https://cg-jobstream-api.azurewebsites.net/api/job-search?page=N&size=M
//   → { total, count, data: [ { id, title, country_name, country_code, location, apply_job_url, description, updated_at, ... } ] }
//
// The server-side country filter is unreliable (query params are ignored);
// the normalize pipeline's US-location filter handles the drop. We paginate
// until `page * size >= total` or we hit a hard cap.

const BASE = 'https://cg-jobstream-api.azurewebsites.net/api/job-search';
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // hard cap: 10,000 rows

function stripHtmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

async function fetchCompany({ displayName }) {
  const rows = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data;
    try {
      data = await fetchJson(`${BASE}?page=${page}&size=${PAGE_SIZE}`, { retries: 1 });
    } catch {
      break;
    }
    const items = Array.isArray(data?.data) ? data.data : [];
    if (!items.length) break;
    if (page === 1 && Number.isFinite(data?.total)) total = data.total;
    rows.push(...items);
    if (page * PAGE_SIZE >= total) break;
  }

  // Pre-filter to US rows: the normalize pipeline would catch non-US anyway,
  // but Capgemini returns 6k+ global rows and we don't need to ingest all of
  // them only to throw 95% away at normalize time. Note: Capgemini uses locale
  // codes (`en-us`, `fr-fr`, …) in `country_code`, not ISO 3166.
  const usRows = rows.filter(
    (r) => r.country_code === 'en-us' || r.country_code === 'US' || /united states/i.test(r.country_name || '')
  );

  return usRows.map((r) => ({
    source: 'capgemini',
    external_id: r.id ? String(r.id) : null,
    company_name: displayName || 'Capgemini',
    job_title: stripHtmlEntities(r.title),
    location: r.location || [r.country_name].filter(Boolean).join(', '),
    apply_url: r.apply_job_url || '',
    description: stripHtmlEntities(r.description_stripped || r.description || ''),
    date_posted: r.updated_at || r.indexed_at || null,
  }));
}

module.exports = { fetchCompany, source: 'capgemini' };
