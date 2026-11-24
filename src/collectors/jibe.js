'use strict';

const { fetchJson } = require('./http');

// iCIMS Jibe career sites: careers.amd.com, careers.rivian.com, jobs.keysight.com
// and others. Every Jibe site serves the same public JSON search, with the full
// description in the list response, so one collector covers them all and no
// per-job request is needed:
//
//   GET {baseUrl}/api/jobs?page=1&limit=100&sortBy=posted_date&descending=true&internal=false[&keywords=…]
//   → { totalCount, jobs: [{ data: { req_id, slug, title, description,
//        qualifications, responsibilities, city, state, country_code,
//        full_location, multipleLocations, posted_date,
//        meta_data: { canonical_url } } }] }
//
// These employers' boards were found by the 2026-11-23 coverage audit: their
// new-grad postings showed up in the community lists, but they post only on
// Jibe, which nothing here read.
//
// Config: { source: 'jibe', slug, displayName, baseUrl, searches? }

const PAGE = 100;
// A catalogue above this is searched by keyword instead of listed in full:
// Costco lists ~19,000 roles, nearly all in its warehouses.
const FULL_LIST_MAX = 1500;
const MAX_PAGES = 20; // per listing or per search
const SEARCHES = ['software', 'developer', 'engineer', 'data', 'machine learning'];

function searchUrl(baseUrl, page, keywords) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(PAGE),
    sortBy: 'posted_date',
    descending: 'true',
    internal: 'false',
  });
  if (keywords) params.set('keywords', keywords);
  return `${String(baseUrl).replace(/\/+$/, '')}/api/jobs?${params.toString()}`;
}

async function fetchPages(company, keywords, firstPage) {
  const jobs = [];
  let total = Infinity;
  for (let page = 1; page <= MAX_PAGES; page++) {
    // eslint-disable-next-line no-await-in-loop
    const data = page === 1 && firstPage ? firstPage : await fetchJson(searchUrl(company.baseUrl, page, keywords), { retries: 1 });
    const items = Array.isArray(data?.jobs) ? data.jobs : [];
    if (page === 1 && Number.isFinite(data?.totalCount)) total = data.totalCount;
    if (!items.length) break;
    jobs.push(...items.map((j) => j.data || j));
    if (items.length < PAGE || page * PAGE >= total) break;
  }
  return { jobs, total };
}

// Small catalogues are listed in full: a search would miss titles like "SRE"
// that no keyword below names. Large ones run the searches, newest first.
async function fetchList(company) {
  const first = await fetchJson(searchUrl(company.baseUrl, 1, ''), { retries: 1 });
  const total = Number(first?.totalCount) || 0;
  if (total <= FULL_LIST_MAX) return (await fetchPages(company, '', first)).jobs;
  const byId = new Map();
  for (const keywords of company.searches || SEARCHES) {
    // eslint-disable-next-line no-await-in-loop
    const { jobs } = await fetchPages(company, keywords);
    for (const d of jobs) {
      const id = d.req_id || d.slug;
      if (id && !byId.has(id)) byId.set(id, d);
    }
  }
  return [...byId.values()];
}

// The API names one country per posting. A posting with several locations
// lists them in the location text instead, so normalize reads that.
function countriesOf(d) {
  if (d.multipleLocations || !d.country_code) return undefined;
  return [String(d.country_code).toUpperCase()];
}

function mapJob(d, { slug, displayName, baseUrl }) {
  const location = d.full_location || [d.city, d.state, d.country].filter(Boolean).join(', ');
  const description = [d.description, d.responsibilities, d.qualifications].filter(Boolean).join('\n');
  return {
    source: 'jibe',
    external_id: String(d.req_id || d.slug || ''),
    company_name: displayName || d.hiring_organization || slug,
    job_title: String(d.title || '').trim(),
    location,
    countries: countriesOf(d),
    // The posting's page on the employer's own careers site, not the ATS
    // login link in `apply_url`.
    apply_url: d.meta_data?.canonical_url || `${String(baseUrl).replace(/\/+$/, '')}/jobs/${d.slug}`,
    description,
    date_posted: d.posted_date || d.create_date || null,
  };
}

async function fetchCompany(company) {
  if (!company.baseUrl) throw new Error(`jibe entry "${company.slug}" missing baseUrl`);
  const jobs = await fetchList(company);
  return jobs.filter((d) => d && d.title && (d.slug || d.req_id)).map((d) => mapJob(d, company));
}

module.exports = { fetchCompany, mapJob, searchUrl, FULL_LIST_MAX, source: 'jibe' };
