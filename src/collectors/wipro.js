'use strict';

const { fetchJson } = require('./http');

// Wipro runs a SAP SuccessFactors-backed recruiting portal with an in-house
// gateway at careers.wipro.com/services/recruiting/v1/jobs. It's POST-only,
// returns 10 rows per page (not tunable from the request body), and supports
// a free-text `location` param that effectively filters to the US.
//
// We pass `location: "United States"` to the endpoint — this drops the
// catalog from 11k global rows to ~663 US-located ones, which we paginate
// fully. No session/auth is needed.
//
// Response shape (per entry):
//   { response: {
//       id, unifiedStandardTitle, urlTitle, unifiedUrlTitle,
//       jobLocationCountry: ["United States"],
//       jobLocationState: [...],
//       jobLocationShort: [...],
//       sfstd_jobLocation_obj: [...],
//       unifiedStandardStart, unifiedStandardEnd,
//       custRMKMappingPicklist: [...],
//   } }

const ENDPOINT = 'https://careers.wipro.com/services/recruiting/v1/jobs';
const MAX_PAGES = 100; // hard cap; 10 rows/page × 100 = 1000 rows

function first(arr) {
  return Array.isArray(arr) && arr.length ? arr[0] : '';
}

function locationOf(r) {
  const parts = [
    first(r.sfstd_jobLocation_obj),
    first(r.jobLocationState),
    first(r.jobLocationCountry),
  ].filter(Boolean);
  return parts.join(', ');
}

function parseDateShort(s) {
  // Wipro uses M/D/YY format (e.g. "1/28/26").
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(s));
  if (!m) return null;
  let [, mo, da, yr] = m;
  yr = yr.length === 2 ? `20${yr}` : yr;
  const d = new Date(Number(yr), Number(mo) - 1, Number(da));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchPage(pageNumber) {
  const body = {
    locale: 'en_US',
    pageNumber,
    sortBy: '',
    keywords: '',
    location: 'United States',
    facetFilters: {},
    brand: '',
    skills: [],
    categoryId: 0,
    alertId: '',
    rcmCandidateId: '',
  };
  const data = await fetchJson(ENDPOINT, {
    method: 'POST',
    body,
    retries: 1,
  });
  return Array.isArray(data?.jobSearchResult) ? data.jobSearchResult : [];
}

async function fetchCompany({ displayName }) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let rows;
    try {
      rows = await fetchPage(page);
    } catch {
      break;
    }
    if (!rows.length) break;
    for (const entry of rows) {
      const r = entry.response || entry;
      if (!r?.id) continue;
      const title = r.unifiedStandardTitle || r.urlTitle || '';
      const urlTitle = r.unifiedUrlTitle || r.urlTitle || '';
      out.push({
        source: 'wipro',
        external_id: String(r.id),
        company_name: displayName || 'Wipro',
        job_title: title,
        location: locationOf(r),
        apply_url: `https://careers.wipro.com/careers/job/${r.id}/${urlTitle}`,
        description: '',
        date_posted: parseDateShort(r.unifiedStandardStart),
      });
    }
    if (rows.length < 10) break; // short page → done
  }
  return out;
}

module.exports = { fetchCompany, source: 'wipro' };
