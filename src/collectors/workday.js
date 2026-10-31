'use strict';

const { fetchJson, runWithConcurrency } = require('./http');

// Public Workday "CxS" JSON endpoints. Each company has a tenant + wd shard + site path:
//   https://{tenant}.wd{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs   (POST list)
//   https://{tenant}.wd{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job{externalPath}  (GET detail)
//
// The list returns bare postings; the detail endpoint has jobDescription HTML which we
// need for sponsorship classification. We fetch detail only for postings that look
// US-based and software/data/ML by title, to keep traffic reasonable.

const DEFAULT_MAX_LIST = 500;    // hard cap on list pagination per company
const DEFAULT_ENRICH_MAX = 80;    // hard cap on detail fetches per company
const DETAIL_CONCURRENCY = 4;

function baseUrl(company) {
  const { tenant, wd, site } = company;
  return `https://${tenant}.wd${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
}

function looksRelevantTitle(t) {
  if (!t) return false;
  const s = t.toLowerCase();
  return (
    /software|developer|\bswe\b|\bsde\b|full[- ]?stack|frontend|backend|platform|infrastructure|site reliability|\bsre\b|machine learning|\bml\b|data scientist|data engineer|ai engineer|applied scientist|research (scientist|engineer)|ios|android|security engineer|mobile engineer/.test(
      s
    )
  );
}

function looksUSLocation(loc) {
  if (!loc) return true;
  const l = loc.toLowerCase();
  if (/\b(united states|usa|u\.s\.|u\.s\.a\.)\b/.test(l)) return true;
  if (/\bremote\b/.test(l) && !/\bemea|apac|europe|asia|uk|canada|india\b/.test(l)) return true;
  // US-ish city/state tokens
  return /\b(ca|ny|wa|tx|ma|il|ga|co|nc|va|pa|nj|md|mn|mi|fl|oh|or|az|ut|tn|in|mo)\b|california|new york|washington|texas|massachusetts|illinois|georgia|colorado|north carolina|virginia|pennsylvania|new jersey|maryland|minnesota|michigan|florida|ohio|oregon|arizona|utah|tennessee|indiana|missouri|san francisco|san jose|seattle|boston|austin|chicago|atlanta|denver|portland|san diego/.test(
    l
  );
}

async function fetchPages(company, searchText, cap) {
  // Workday quirk: the `total` field is only returned on the first page; subsequent
  // pages report `total: 0`. So we capture total once and paginate until either
  // (a) we've reached total, (b) we hit the cap, or (c) we get a short page.
  const all = [];
  let offset = 0;
  const limit = 20;
  let total = Infinity;
  while (offset < cap) {
    const data = await fetchJson(`${baseUrl(company)}/jobs`, {
      method: 'POST',
      body: { appliedFacets: {}, limit, offset, searchText },
      retries: 1,
    });
    const items = Array.isArray(data?.jobPostings) ? data.jobPostings : [];
    if (offset === 0 && Number.isFinite(data?.total)) total = data.total;
    if (!items.length) break;
    all.push(...items);
    offset += items.length;
    if (items.length < limit) break;
    if (offset >= total) break;
  }
  return { items: all, total };
}

// Large tenants bury software roles: an unfiltered list is capped (NVIDIA
// reports total 2000, in no useful order) and the first 500 rows of a retailer
// or bank are mostly stores, branches and operations. Workday's searchText
// ranks by relevance, so above DEFAULT_MAX_LIST the collector switches to a
// handful of targeted searches. Similar request count, far better recall.
// Small tenants are still listed in full — a search would miss titles like
// "SRE" or "Security Engineer" that no query below names.
const SEARCHES = ['software engineer', 'software developer', 'machine learning', 'data engineer', 'data scientist', 'new grad', 'site reliability'];
const SEARCH_CAP = 100;

async function fetchList(company) {
  // One page first to learn the total. Large tenants skip the unfiltered
  // listing entirely — 25 requests of mostly non-software rows — and go
  // straight to the searches.
  const first = await fetchPages(company, '', 20);
  if (first.total > DEFAULT_MAX_LIST) return fetchBySearch(company, first.items);
  if (first.total <= first.items.length) return first.items;
  return (await fetchPages(company, '', DEFAULT_MAX_LIST)).items;
}

async function fetchBySearch(company, seed) {
  const byPath = new Map(seed.map((j) => [j.externalPath, j]));
  for (const q of company.searches || SEARCHES) {
    // eslint-disable-next-line no-await-in-loop
    const { items } = await fetchPages(company, q, SEARCH_CAP);
    for (const j of items) if (!byPath.has(j.externalPath)) byPath.set(j.externalPath, j);
  }
  return [...byPath.values()];
}

// Workday collapses multi-site postings to the placeholder "2 Locations" /
// "3 Locations" instead of naming any of them. That defeats the US filter in
// normalizeJob — measured at 307/500 Capital One postings and 209/500 Nvidia
// postings silently dropped, most of them US roles.
//
// `externalPath` still encodes the primary location ("/job/McLean-VA/..."),
// so fall back to it. Hyphens become ", " for the trailing state code so the
// result matches the "City, ST" shape normalizeLocation expects.
const MULTI_LOCATION = /^\d+\s+locations?$/i;

function locationFromPath(externalPath) {
  const seg = String(externalPath || '').split('/')[2];
  if (!seg) return '';
  const m = seg.match(/^(.*)-([A-Z]{2})$/);
  if (m) return `${m[1].replace(/-/g, ' ')}, ${m[2]}`;
  return seg.replace(/-/g, ' ');
}

function resolveLocation(j) {
  const text = (j.locationsText || '').trim();
  if (text && !MULTI_LOCATION.test(text)) return text;
  return locationFromPath(j.externalPath) || text;
}

async function fetchDetail(company, externalPath) {
  const data = await fetchJson(`${baseUrl(company)}/job${externalPath}`, { retries: 1 });
  return data?.jobPostingInfo?.jobDescription || '';
}

// "Posted 3 Days Ago" → approximate ISO date, else null.
function parsePostedOn(s) {
  if (!s) return null;
  const m = /(\d+)\s+(day|days|hour|hours|month|months)\s+ago/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const d = new Date();
  if (unit.startsWith('hour')) d.setHours(d.getHours() - n);
  else if (unit.startsWith('day')) d.setDate(d.getDate() - n);
  else if (unit.startsWith('month')) d.setMonth(d.getMonth() - n);
  return d.toISOString();
}

async function fetchCompany(company) {
  const { slug, displayName, tenant, wd, site } = company;
  if (!tenant || !wd || !site) {
    throw new Error(`Workday company "${slug}" missing tenant/wd/site`);
  }

  const list = await fetchList(company);

  // Pre-filter by title + location so we only burn detail requests on US SWE/ML/DS roles.
  const candidates = list.filter(
    (j) => looksRelevantTitle(j.title) && looksUSLocation(j.locationsText)
  );
  const enrichTargets = candidates.slice(0, DEFAULT_ENRICH_MAX);

  const descByPath = new Map();
  await runWithConcurrency(enrichTargets, DETAIL_CONCURRENCY, async (j) => {
    try {
      const desc = await fetchDetail(company, j.externalPath);
      descByPath.set(j.externalPath, desc);
    } catch {
      /* leave empty; classifier will return UNKNOWN */
    }
  });

  return list.map((j) => ({
    source: 'workday',
    external_id:
      (Array.isArray(j.bulletFields) && j.bulletFields[0]) || j.externalPath,
    company_name: displayName || slug,
    job_title: j.title || '',
    location: resolveLocation(j),
    // The CxS API returns `externalPath` like "/job/Leeds/Quality-Automation-Engineer_R00289257-1",
    // but the public URL needs the "/en-US/{site}" prefix — without it Workday
    // redirects through a resolver that eventually lands on
    // community.workday.com/invalid-url.
    apply_url: `https://${tenant}.wd${wd}.myworkdayjobs.com/en-US/${site}${j.externalPath}`,
    description: descByPath.get(j.externalPath) || '',
    date_posted: parsePostedOn(j.postedOn),
  }));
}

module.exports = { fetchCompany, source: 'workday' };
