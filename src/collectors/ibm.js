'use strict';

const { fetchJson } = require('./http');
const { looksSoftware } = require('../services/normalize');

// IBM's careers search (ibm.com/careers/search) is an Elasticsearch front end:
// the page POSTs a query body to www-api.ibm.com/search/api/v2 with
// appId "careers", scope "careers2". Anonymous, no cookies. careers.ibm.com's
// own job pages answer plain requests with an empty 202 (a bot check), so
// everything here comes from the search API, which also carries the full text.
//
// Field mapping (worked out 2026-11-24 from the page's searchEmbeddedData
// config and by requesting fields one at a time; `_source` is whitelisted and
// one unknown name rejects the whole request with a 400):
//   field_text_01     jobId (number); url is careers.ibm.com/careers/JobDetail?jobId=N
//   field_keyword_05  country name ("United States"): the page's Location facet
//   field_keyword_21  city list (["Raleigh","Austin"]); absent on some jobs
//   field_keyword_19  one "CITY, US" string, or "Multiple Cities"
//   field_keyword_17  "Hybrid" | "Remote" | ""
//   field_keyword_18  "Professional" | "Entry Level" | "Internship"
//   field_keyword_08  career area ("Software Engineering", "Data & Analytics", …)
//   field_keyword_23  skills list
//   dcdate            "Date posted" as the job page shows it (YYYY-MM-DD).
//                     `effectivedate` is older on reposted jobs; not used.
//   description       a ~250-char teaser; `body` is the full posting text.
//
// One listing pass instead of keyword searches: the country filter runs
// server-side and the whole recent US set is ~1,100 jobs (11 pages), so
// listing it all is fewer requests than nine overlapping searches and misses
// nothing they would find. Titles are judged here (same classifier normalize
// uses) and only the jobs that pass get their `body` fetched, in batches by id.

const ENDPOINT = 'https://www-api.ibm.com/search/api/v2';
const PAGE_SIZE = 100; // the API rejects size > 100
const MAX_PAGES = 20; // 2,000-row cap; the US set was ~1,100 on 2026-11-24
const RECENT_DAYS = 30; // retention keeps 14; the margin absorbs clock and zone slop
const BODY_BATCH = 50;

const LIST_FIELDS = [
  '_id', 'title', 'url', 'dcdate',
  'field_text_01', 'field_keyword_05', 'field_keyword_08', 'field_keyword_17',
  'field_keyword_18', 'field_keyword_19', 'field_keyword_21',
];

function baseBody() {
  return { appId: 'careers', scopes: ['careers2'], lang: 'zz', localeSelector: {}, p: 1 };
}

function listBody(page) {
  return {
    ...baseBody(),
    query: {
      bool: {
        filter: [
          { terms: { field_keyword_05: ['United States'] } },
          { range: { dcdate: { gte: `now-${RECENT_DAYS}d/d` } } },
        ],
        // Internships are rejected downstream anyway, and IBM's ("Associate
        // Project Manager Apprentice", "Spring Co-op …") don't all say so.
        must_not: [{ terms: { field_keyword_18: ['Internship'] } }],
      },
    },
    size: PAGE_SIZE,
    from: page * PAGE_SIZE,
    sort: [{ dcdate: 'desc' }],
    _source: LIST_FIELDS,
  };
}

function bodyLookup(ids) {
  return {
    ...baseBody(),
    query: { bool: { filter: [{ terms: { field_text_01: ids.map(Number) } }] } },
    size: ids.length,
    from: 0,
    _source: ['_id', 'field_text_01', 'body'],
  };
}

function post(body) {
  return fetchJson(ENDPOINT, { method: 'POST', body, retries: 2 });
}

function jobIdOf(src) {
  if (src.field_text_01 != null && src.field_text_01 !== '') return String(src.field_text_01);
  const m = /[?&]jobId=(\d+)/.exec(src.url || '');
  return m ? m[1] : null;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

// "Raleigh, Austin, United States", as the job page writes it. The API has no
// state field, so the country name is what lets the row read as US. Some city
// names arrive in capitals ("POUGHKEEPSIE") beside mixed-case ones.
function locationOf(src) {
  let cities = (Array.isArray(src.field_keyword_21) ? src.field_keyword_21 : [src.field_keyword_21])
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .map((c) => (/[a-z]/.test(c) ? c : titleCase(c)));
  if (!cities.length) {
    const single = String(src.field_keyword_19 || '').trim();
    if (single && !/^multiple cities$/i.test(single)) {
      cities = [titleCase(single.replace(/,\s*US$/i, ''))];
    }
  }
  if (!cities.length && src.field_keyword_17 === 'Remote') cities = ['Remote'];
  return [...cities, src.field_keyword_05 || 'United States'].join(', ');
}

function mapHit(hit, displayName) {
  const src = hit?._source || {};
  const id = jobIdOf(src);
  if (!id || !src.title) return null;
  const row = {
    source: 'ibm',
    external_id: id,
    company_name: displayName || 'IBM',
    job_title: String(src.title).trim(),
    location: locationOf(src),
    // Only US jobs are requested; saying so outranks parsing the location.
    countries: ['US'],
    apply_url: src.url || `https://careers.ibm.com/careers/JobDetail?jobId=${id}`,
    description: '',
    date_posted: src.dcdate || null,
  };
  if (src.field_keyword_18 === 'Entry Level') row.entry_level_override = 1;
  return row;
}

async function listUS() {
  const hits = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let data;
    try {
      data = await post(listBody(page));
    } catch (err) {
      // A failed first page is a failed company; a later one keeps what was read.
      if (page === 0) throw err;
      break;
    }
    const batch = data?.hits?.hits || [];
    hits.push(...batch);
    const total = Number(data?.hits?.total?.value ?? data?.hits?.total ?? 0);
    if (batch.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= total) break;
  }
  return hits;
}

// Fills `description` from `body`, sequentially in batches. A failed batch
// leaves those rows without text rather than failing the company.
async function addDescriptions(rows) {
  for (let i = 0; i < rows.length; i += BODY_BATCH) {
    const chunk = rows.slice(i, i + BODY_BATCH);
    let data;
    try {
      data = await post(bodyLookup(chunk.map((r) => r.external_id)));
    } catch {
      continue;
    }
    const byId = new Map();
    for (const h of data?.hits?.hits || []) {
      const id = jobIdOf(h?._source || {});
      if (id && typeof h._source.body === 'string') byId.set(id, h._source.body);
    }
    for (const r of chunk) if (byId.has(r.external_id)) r.description = byId.get(r.external_id);
  }
}

async function fetchCompany({ displayName } = {}) {
  const hits = await listUS();
  const byId = new Map();
  for (const h of hits) {
    const row = mapHit(h, displayName);
    if (row && !byId.has(row.external_id)) byId.set(row.external_id, row);
  }
  // Rows that can't pass the software filter later aren't worth a body fetch
  // or a database row.
  const kept = [...byId.values()].filter((r) => looksSoftware(r.job_title, 'ibm'));
  await addDescriptions(kept);
  return kept;
}

module.exports = {
  fetchCompany,
  source: 'ibm',
  // for tests
  mapHit,
  locationOf,
  listBody,
  bodyLookup,
};
