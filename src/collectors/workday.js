'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// Public Workday "CxS" JSON endpoints. Each company has a tenant + wd shard + site path:
//   https://{tenant}.wd{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs   (POST list)
//   https://{tenant}.wd{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}  (GET detail)
//   where externalPath is "/job/{location}/{title}_{req}" as the list returns it.
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

// `externalPath` already begins with "/job/" ("/job/Austin-Texas/Software-
// Engineer_R0137"), so it is appended to the site root as-is. This used to
// insert another "/job", which asked Workday for ".../job/job/..." and got
// HTTP 406 from every tenant (checked live against PayPal and Nvidia). The
// caller swallows detail errors, so every Workday row arrived with an empty
// description and sponsorship came from USCIS history alone — PayPal's "Visa
// Sponsorship ... is not available" line was never read.
function detailUrl(company, externalPath) {
  return `${baseUrl(company)}${externalPath}`;
}

async function fetchDetail(company, externalPath) {
  const data = await fetchJson(detailUrl(company, externalPath), { retries: 1 });
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

// Which postings get a detail request. Beyond the title + US filters, apply the
// same software and level gates normalize applies, so none of the per-run budget
// is spent on a "Director" or "Senior Manager" posting that is dropped right
// after (a third of Capital One's candidates were). Newest first, so when the cap
// bites it is the oldest rows that go without — and those keep the description
// they got when they were new (see upsertJob).
function pickCandidates(list) {
  return list
    .filter(
      (j) =>
        looksRelevantTitle(j.title) &&
        // The resolved location, not locationsText: multi-site postings show
        // only "2 Locations", which matched no US pattern, so they never got a
        // description — PayPal's US Android and DevOps roles among them, whose
        // "Visa Sponsorship through PayPal is not available" went unread.
        looksUSLocation(resolveLocation(j)) &&
        (!CONFIG.filterSoftwareOnly || looksSoftware(j.title)) &&
        passesLevel(j.title, CONFIG.entryLevelMode || 'permissive')
    )
    .sort((a, b) => postedAgeDays(a.postedOn) - postedAgeDays(b.postedOn));
}

// Workday words recency as "Posted Today", "Posted Yesterday", "Posted 5 Days
// Ago" and "Posted 30+ Days Ago". parsePostedOn() only reads the "N … ago" forms,
// so sorting on it would have ranked the newest postings as the oldest.
function postedAgeDays(s) {
  const t = String(s || '').toLowerCase();
  if (/today|just posted/.test(t)) return 0;
  if (/yesterday/.test(t)) return 1;
  const m = /(\d+)\+?\s+(hour|day|week|month)/.exec(t);
  if (!m) return 9999;
  const n = Number(m[1]);
  return m[2] === 'hour' ? 0 : m[2] === 'day' ? n : m[2] === 'week' ? n * 7 : n * 30;
}

async function fetchCompany(company) {
  const { slug, displayName, tenant, wd, site } = company;
  if (!tenant || !wd || !site) {
    throw new Error(`Workday company "${slug}" missing tenant/wd/site`);
  }

  const list = await fetchList(company);

  const candidates = pickCandidates(list);
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

module.exports = { fetchCompany, detailUrl, pickCandidates, postedAgeDays, source: 'workday' };
