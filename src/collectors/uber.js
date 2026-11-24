'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel, levelRank } = require('../services/normalize');

// Uber careers moved in late 2026. www.uber.com/…/careers/list now redirects to
// jobs.uber.com (a Next.js site behind a Cloudflare challenge), and the old
// search RPC answers 404 {"code":"ERR_MISSING_HANDLER"} for
// /api/loadSearchJobsResults. The postings themselves live in Uber's Oracle
// Recruiting Cloud tenant (site "UberCareers"), whose Candidate Experience REST
// API is public and unchallenged — the same API src/collectors/oracle_hcm.js
// reads. Requisition ids are the ids jobs.uber.com uses (/en/jobs/{id}/), so
// rows keep the external_id they had before the move. Verified 2026-11-24:
// 848 open requisitions worldwide, 413 with a US location.
//
//   List:   recruitingCEJobRequisitions?finder=findReqs;siteNumber=UberCareers,
//           locationId=<US>,limit=200,offset=N,sortBy=POSTING_DATES_DESC
//     → items[0] = { TotalJobsCount, requisitionList: [{ Id, Title,
//       PostedDate, PrimaryLocation, PrimaryLocationCountry,
//       secondaryLocations: [{ Name, CountryCode }] }] }
//     The list carries no description (ShortDescriptionStr is empty).
//   Detail: recruitingCEJobRequisitionDetails?finder=ById;Id="N",siteNumber=…
//     → items[0] = { ExternalDescriptionStr, ExternalResponsibilitiesStr,
//       ExternalQualificationsStr, ExternalPostedStartDate, … } (HTML)
//
// The old API's `level` field (3 entry, 4 mid, 5+ senior) has no counterpart
// here (JobLevel and JobGrade are null), so level comes from the title and the
// description like every other source.

const API = 'https://iaziqy.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest';
const SITE = 'UberCareers';
// The "United States" node of the site's location facet (locationsFacet).
const US_LOCATION_ID = '300000000484560';
const APPLY_BASE = 'https://jobs.uber.com/en/jobs';

const PAGE_SIZE = 200; // the API accepts 200; 413 US rows is three pages
const MAX_PAGES = 10; // 2,000 US rows, several times what Uber has open

// One description request per candidate that survives the title gates and is
// inside the retention window. Overridable from the config entry.
const DEFAULTS = { pageDelayMs: 300, detailMax: 250, detailConcurrency: 2 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listUrl(offset) {
  const params = new URLSearchParams({
    onlyData: 'true',
    expand: 'requisitionList.secondaryLocations',
    finder:
      `findReqs;siteNumber=${SITE},locationId=${US_LOCATION_ID},` +
      `limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`,
  });
  return `${API}/recruitingCEJobRequisitions?${params}`;
}

function detailUrl(id) {
  const params = new URLSearchParams({
    onlyData: 'true',
    expand: 'all',
    finder: `ById;Id="${id}",siteNumber=${SITE}`,
  });
  return `${API}/recruitingCEJobRequisitionDetails?${params}`;
}

// items[0] of a list response, or null when the shape is not the one above.
function listPageOf(data) {
  const item = Array.isArray(data?.items) && data.items.length ? data.items[0] : null;
  if (!item || !Array.isArray(item.requisitionList)) return null;
  return { total: Number(item.TotalJobsCount) || 0, rows: item.requisitionList };
}

// Every location the requisition names, US offices first, as
// [{ name, country }]. Primary first within each group.
function locationsOf(req) {
  const all = [
    { name: req.PrimaryLocation, country: req.PrimaryLocationCountry },
    ...(Array.isArray(req.secondaryLocations) ? req.secondaryLocations : []).map((l) => ({
      name: l?.Name,
      country: l?.CountryCode,
    })),
  ].filter((l) => l.name && String(l.name).trim());
  const seen = new Set();
  const unique = all.filter((l) => {
    const k = String(l.name).trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...unique.filter((l) => l.country === 'US'), ...unique.filter((l) => l.country !== 'US')];
}

// Sections in reading order; the qualifications carry the experience,
// clearance and sponsorship wording. HTML is left for normalize's stripHtml.
function buildDescription(detail) {
  if (!detail) return '';
  return [
    detail.ExternalDescriptionStr,
    detail.ExternalResponsibilitiesStr,
    detail.ExternalQualificationsStr,
  ]
    .filter((s) => s && String(s).trim())
    .join('\n\n');
}

// Pure field mapping, split out so it can be regression-tested without network.
function mapRequisition(req, detail, displayName) {
  const locs = locationsOf(req);
  const countries = [...new Set(locs.map((l) => l.country).filter(Boolean))];
  return {
    source: 'uber',
    external_id: String(req.Id),
    company_name: displayName || 'Uber',
    job_title: req.Title || '',
    location: locs.map((l) => String(l.name).trim()).join('; '),
    // ISO country codes per office: inUS() trusts these over the joined text.
    countries: countries.length ? countries : undefined,
    apply_url: `${APPLY_BASE}/${req.Id}/`,
    description: buildDescription(detail),
    // The detail's timestamp is exact; the list's PostedDate is a day.
    date_posted: detail?.ExternalPostedStartDate || req.PostedDate || null,
  };
}

async function fetchList({ pageDelayMs }) {
  const byId = new Map();
  let total = Infinity;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(pageDelayMs);
    let parsed;
    try {
      parsed = listPageOf(await fetchJson(listUrl(page * PAGE_SIZE), { retries: 1 }));
      // Uber always has US openings. An empty or unrecognised first page means
      // the tenant, site or location id changed; fail the run rather than
      // report "Uber: 0 jobs" as a success, which is how the 2026 site move
      // went unnoticed.
      if (page === 0 && (!parsed || !parsed.rows.length)) {
        throw new Error(
          'Oracle UberCareers list returned no US requisitions (site, location id or API shape changed)'
        );
      }
    } catch (err) {
      if (page === 0) throw err;
      console.warn(`[uber] list page ${page + 1} failed (${byId.size} rows kept) — ${err.message}`);
      break;
    }
    if (!parsed || !parsed.rows.length) break;
    for (const r of parsed.rows) if (r?.Id && r.Title && !byId.has(String(r.Id))) byId.set(String(r.Id), r);
    if (parsed.total) total = parsed.total;
    if (parsed.rows.length < PAGE_SIZE || byId.size >= total) break;
  }
  return [...byId.values()];
}

async function fetchDetail(id) {
  const data = await fetchJson(detailUrl(id), { retries: 1 });
  return Array.isArray(data?.items) && data.items.length ? data.items[0] : null;
}

function withinRetention(postedDate) {
  const days = CONFIG.retentionDays;
  if (!days || !postedDate) return true;
  const t = new Date(postedDate).getTime();
  return Number.isNaN(t) || Date.now() - t <= (days + 1) * 24 * 60 * 60 * 1000;
}

async function fetchCompany(company = {}) {
  const opts = {
    pageDelayMs: company.pageDelayMs ?? DEFAULTS.pageDelayMs,
    detailMax: company.detailMax ?? DEFAULTS.detailMax,
    detailConcurrency: company.detailConcurrency ?? DEFAULTS.detailConcurrency,
  };
  const list = await fetchList(opts);

  // Same gates normalize applies, moved ahead of the per-job requests.
  const candidates = list
    .filter((r) => withinRetention(r.PostedDate))
    .filter((r) => !CONFIG.filterSoftwareOnly || looksSoftware(r.Title, 'uber'))
    .filter((r) => passesLevel(r.Title, CONFIG.entryLevelMode || 'permissive'))
    .sort(
      (a, b) =>
        levelRank(a.Title) - levelRank(b.Title) ||
        String(b.PostedDate || '').localeCompare(String(a.PostedDate || ''))
    );

  const toEnrich = candidates.slice(0, opts.detailMax);
  const details = await runWithConcurrency(toEnrich, opts.detailConcurrency, async (r) => {
    await sleep(opts.pageDelayMs);
    return fetchDetail(r.Id);
  });

  return candidates.map((r, i) => {
    const d = i < details.length && details[i] && !details[i].__error ? details[i] : null;
    return mapRequisition(r, d, company.displayName);
  });
}

module.exports = {
  fetchCompany,
  mapRequisition,
  buildDescription,
  listPageOf,
  locationsOf,
  listUrl,
  detailUrl,
  source: 'uber',
};
