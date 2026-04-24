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

async function fetchList(company) {
  // Workday quirk: the `total` field is only returned on the first page; subsequent
  // pages report `total: 0`. So we capture total once and paginate until either
  // (a) we've reached total, (b) we hit our hard cap, or (c) we get a short page.
  const all = [];
  let offset = 0;
  const limit = 20;
  let total = Infinity;
  while (offset < DEFAULT_MAX_LIST) {
    const data = await fetchJson(`${baseUrl(company)}/jobs`, {
      method: 'POST',
      body: { appliedFacets: {}, limit, offset, searchText: '' },
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
  return all;
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
    location: j.locationsText || '',
    apply_url: `https://${tenant}.wd${wd}.myworkdayjobs.com${j.externalPath}`,
    description: descByPath.get(j.externalPath) || '',
    date_posted: parsePostedOn(j.postedOn),
  }));
}

module.exports = { fetchCompany, source: 'workday' };
