'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// ByteDance's own careers platform, behind both of its US employers' sites.
// Verified 2026-11-23 against what each site's pages call:
//
//   TikTok     lifeattiktok.com   → api.lifeattiktok.com   website-path: tiktok
//   ByteDance  joinbytedance.com  → jobs.bytedance.com     website-path: en
//              (jobs.bytedance.com/en now redirects to joinbytedance.com)
//
//   POST {apiBase}/config/job/filters        body {}
//     → data.city_list: [{ code: 'CT_1103355', en_name: 'San Jose',
//         parent: { en_name: 'California', parent: { code: 'CN_6',
//         en_name: 'United States of America' } } }, …]
//   POST {apiBase}/search/job/posts
//     body { keyword, limit, offset, location_code_list, recruitment_id_list,
//            job_category_id_list, subject_id_list }
//     → data: { count, job_post_list: [{ id, title, description, requirement,
//         recruit_type, job_subject, city_info }] }
//
// Public and unauthenticated: no cookie, CSRF token or request signature. The
// `website-path` header picks the site; without it the API answers 400. The
// location filter takes city codes only (the US country code matches nothing),
// so the US cities are read from the filter config first.
//
// Search rows carry the full description and qualifications, so there is no
// per-job request. The whole US catalogue is read (TikTok 1,801 postings,
// ByteDance 597 on 2026-11-23: 25 requests) and the title gates applied here.
//
// TikTok USDS Joint Venture posts on its own site (careers.tiktokusds.com, 418
// roles), whose API signs every request and loads a captcha SDK. Not collected.

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5,000 postings: a backstop, not a budget
const PAGE_CONCURRENCY = 2;
const PAGE_DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nameOf = (x) => x?.en_name || x?.i18n_name || x?.name || '';

function countryOf(city) {
  let c = city;
  while (c?.parent) c = c.parent;
  return c || null;
}

function isUS(country) {
  return country?.code === 'CN_6' || /^united states/i.test(nameOf(country));
}

function usCityCodes(cityList) {
  return (Array.isArray(cityList) ? cityList : [])
    .filter((c) => c?.code && isUS(countryOf(c)))
    .map((c) => c.code);
}

// City, state, country. `name` is Chinese on jobs.bytedance.com, so the English
// names are read first.
function locationText(city) {
  const parts = [];
  for (let c = city; c; c = c.parent) {
    const n = nameOf(c);
    if (n && n !== parts[parts.length - 1]) parts.push(/^united states/i.test(n) ? 'United States' : n);
  }
  return parts.join(', ');
}

// The search rows carry no date, but the posting id does: ByteDance ids keep
// their creation time in the top 32 bits (Unix seconds). The platform's older
// search API (CSRF cookie, same rows) still returns `publish_time`. On
// 2026-11-23 that was within an hour of the id's time for 2,373 of the 2,399 US
// postings on both sites, and within a day for all but 8: seven TikTok postings
// published 2-140 days after their creation in 2022-23, and one ByteDance
// posting from 2018 whose id is a year newer.
//
// The date is real, and most postings are old. Graduate roles stay open for
// months: of the US postings that pass the title gates (339 TikTok, 199
// ByteDance), 2 were published inside the 14-day retention window. Retention
// drops the rest, as it already does their copies on the new-grad lists.
// Sending null instead (Rippling's choice for a creation-only date) would show
// months-old postings as new, and would not keep TikTok's anyway: the lists
// link to the same lifeattiktok.com pages with their old dates, and collectAll
// deletes every stored row whose link another source dates past the window.
const EARLIEST_MS = Date.UTC(2016, 0, 1); // before the platform existed

function postedAt(id) {
  let ms;
  try {
    ms = Number(BigInt(String(id)) >> 32n) * 1000;
  } catch {
    return null;
  }
  if (!(ms >= EARLIEST_MS && ms <= Date.now() + 86_400_000)) return null;
  return new Date(ms).toISOString();
}

// Campus postings name their program: "Bachelor/Master Graduate - 2027 Start",
// "PhD Graduates - 2027 Start", "Global Frontier Tech Recruitment Program - 2027
// Grad". Their titles ("Software Engineer Graduate (…) - 2027 Start") carry no
// word normalize reads as entry level, so the program is passed as the level.
// Intern programs ("Undergraduate/Master Intern") are not.
function isGraduateProgram(p) {
  const s = nameOf(p?.job_subject);
  return /\bgrad/i.test(s) && !/intern/i.test(s);
}

// The title gate already drops interns. The recruit type also catches one whose
// title doesn't say so. A third-party associate is employed by a staffing
// vendor, not by TikTok or ByteDance.
const NOT_EMPLOYEE = /intern|third[\s-]?party/i;

function keep(p, employer) {
  if (!p?.id || !p.title) return false;
  if (!isUS(countryOf(p.city_info))) return false;
  if (NOT_EMPLOYEE.test(nameOf(p.recruit_type))) return false;
  if (CONFIG.filterSoftwareOnly && !looksSoftware(p.title)) return false;
  return passesLevel(p.title, CONFIG.entryLevelMode || 'permissive', employer);
}

// Pure field mapping, split out so it can be regression-tested without network.
function mapPosting(p, company) {
  const country = countryOf(p.city_info);
  const row = {
    source: 'bytedance',
    external_id: String(p.id),
    company_name: company.displayName,
    job_title: String(p.title || '').trim(),
    location: locationText(p.city_info),
    countries: country ? [isUS(country) ? 'US' : nameOf(country)] : undefined,
    apply_url: `${company.applyUrlBase}/${p.id}`,
    description: [p.description, p.requirement]
      .filter((s) => s && String(s).trim())
      .join('\n\n'),
    date_posted: postedAt(p.id),
  };
  if (isGraduateProgram(p)) row.entry_level_override = 1;
  return row;
}

// The API answers HTTP 200 with a non-zero `code` when it refuses a request.
function dataOf(res) {
  if (res?.code !== 0 || !res.data) {
    throw new Error(`API answered code ${res?.code}: ${res?.message || 'no data'}`);
  }
  return res.data;
}

function request(company, path, body) {
  return fetchJson(`${company.apiBase}${path}`, {
    method: 'POST',
    body,
    retries: 2,
    headers: { 'website-path': company.websitePath, 'accept-language': 'en-US' },
  });
}

// `post` and `delayMs` are injectable so the paging can be tested offline.
async function fetchCompany(company, { post, delayMs = PAGE_DELAY_MS } = {}) {
  const { slug, displayName, apiBase, websitePath, applyUrlBase } = company;
  if (!apiBase || !websitePath || !applyUrlBase) {
    throw new Error(`bytedance entry "${slug}" missing apiBase/websitePath/applyUrlBase`);
  }
  const call = post || ((path, body) => request(company, path, body));

  const cities = usCityCodes(dataOf(await call('/config/job/filters', {})).city_list);
  if (!cities.length) throw new Error('filter config lists no US cities (layout change or blocked)');

  const page = async (offset) => {
    const data = dataOf(
      await call('/search/job/posts', {
        recruitment_id_list: [],
        job_category_id_list: [],
        subject_id_list: [],
        location_code_list: cities,
        keyword: '',
        limit: PAGE_SIZE,
        offset,
      })
    );
    if (!Array.isArray(data.job_post_list)) throw new Error('search answer carried no job_post_list');
    return data;
  };

  // An empty first page would read as "no US jobs", which neither employer has
  // had. Fail loudly instead, as apple.js does.
  const first = await page(0);
  const count = Number(first.count) || 0;
  if (!count || !first.job_post_list.length) {
    throw new Error(`search found ${count} US postings and returned ${first.job_post_list.length}`);
  }
  if (count > PAGE_SIZE * MAX_PAGES) {
    console.warn(`[bytedance:${slug}] ${count} US postings; reading the first ${PAGE_SIZE * MAX_PAGES}`);
  }

  // Step by what the first page returned, in case the API caps the page lower.
  const step = first.job_post_list.length;
  const offsets = [];
  for (let o = step; o < Math.min(count, PAGE_SIZE * MAX_PAGES); o += step) offsets.push(o);
  const rest = await runWithConcurrency(offsets, PAGE_CONCURRENCY, async (offset) => {
    if (delayMs) await sleep(delayMs);
    return (await page(offset)).job_post_list;
  });
  const failed = rest.filter((r) => !Array.isArray(r)).length;
  if (failed) {
    console.warn(`[bytedance:${slug}] ${failed} of ${offsets.length + 1} pages failed; kept the rest`);
  }

  // Offset paging over a live index can repeat a posting across pages.
  const byId = new Map();
  for (const p of [first.job_post_list, ...rest.filter(Array.isArray)].flat()) {
    if (p?.id && !byId.has(String(p.id))) byId.set(String(p.id), p);
  }

  // Two postings were listed on both sites on 2026-11-23, and both were years
  // old. A shared one would come through once under each employer.
  return [...byId.values()].filter((p) => keep(p, displayName)).map((p) => mapPosting(p, company));
}

module.exports = {
  fetchCompany,
  mapPosting,
  postedAt,
  usCityCodes,
  locationText,
  isGraduateProgram,
  source: 'bytedance',
};
