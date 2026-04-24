'use strict';

const { fetchJson } = require('./http');

// Oracle Recruiting Cloud / Candidate Experience public endpoints.
// Companies expose a public requisitions page backed by:
//   https://{apiHost}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//
// Unlike Workday, the list response already includes a short description and
// enough metadata for filtering, so we don't need a per-job detail pass.

const FACETS_LIST =
  'LOCATIONS;WORK_LOCATIONS;WORKPLACE_TYPES;TITLES;CATEGORIES;ORGANIZATIONS;POSTING_DATES;FLEX_FIELDS';
const EXPAND =
  'requisitionList.workLocation,' +
  'requisitionList.otherWorkLocations,' +
  'requisitionList.secondaryLocations,' +
  'flexFieldsFacet.values,' +
  'requisitionList.requisitionFlexFields';
const PAGE_SIZE = 25;
const MAX_RESULTS = 500;

function listUrl(company, offset) {
  const params = new URLSearchParams({
    onlyData: 'true',
    expand: EXPAND,
    finder:
      `findReqs;siteNumber=${company.siteNumber},` +
      `facetsList=${FACETS_LIST},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`,
  });
  return `https://${company.apiHost}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?${params.toString()}`;
}

function uiBaseUrl(company) {
  return String(company.uiBaseUrl || '').replace(/\/+$/, '');
}

function normalizeLocationParts(parts) {
  const seen = new Set();
  const out = [];
  for (const raw of parts) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.join(' | ');
}

function locationName(loc) {
  if (!loc || typeof loc !== 'object') return '';
  return (
    loc.LocationName ||
    loc.locationName ||
    loc.Name ||
    loc.name ||
    loc.Location ||
    loc.location ||
    ''
  );
}

function buildLocation(req) {
  const extra = []
    .concat(Array.isArray(req.workLocation) ? req.workLocation : [])
    .concat(Array.isArray(req.otherWorkLocations) ? req.otherWorkLocations : [])
    .concat(Array.isArray(req.secondaryLocations) ? req.secondaryLocations : [])
    .map(locationName);
  return normalizeLocationParts([req.PrimaryLocation, ...extra]);
}

function buildDescription(req) {
  return [req.ShortDescriptionStr, req.ExternalResponsibilitiesStr, req.ExternalQualificationsStr]
    .filter(Boolean)
    .join('\n\n');
}

async function fetchList(company) {
  const rows = [];
  let total = Infinity;

  for (let offset = 0; offset < MAX_RESULTS; offset += PAGE_SIZE) {
    const data = await fetchJson(listUrl(company, offset), { retries: 1 });
    const item =
      Array.isArray(data?.items) && data.items.length ? data.items[0] : null;
    const pageRows = Array.isArray(item?.requisitionList) ? item.requisitionList : [];
    if (!pageRows.length) break;

    rows.push(...pageRows);
    total = Number(item?.TotalJobsCount || 0) || total;

    if (pageRows.length < PAGE_SIZE) break;
    if (rows.length >= total) break;
  }

  return rows.slice(0, MAX_RESULTS);
}

async function fetchCompany(company) {
  const { slug, displayName, apiHost, siteNumber } = company;
  if (!apiHost || !siteNumber || !uiBaseUrl(company)) {
    throw new Error(`Oracle HCM company "${slug}" missing apiHost/siteNumber/uiBaseUrl`);
  }

  const list = await fetchList(company);

  return list.map((req) => ({
    source: 'oracle_hcm',
    external_id: req.Id ? String(req.Id) : null,
    company_name: displayName || slug,
    job_title: req.Title || '',
    location: buildLocation(req),
    apply_url: `${uiBaseUrl(company)}/job/${req.Id}`,
    description: buildDescription(req),
    date_posted: req.PostedDate || null,
  }));
}

module.exports = { fetchCompany, source: 'oracle_hcm' };
