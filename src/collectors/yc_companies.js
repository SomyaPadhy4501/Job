'use strict';

const { fetchJson } = require('./http');

// Fetches the maintained YC company feed (akshaybhalotia/yc_company_scraper),
// filters to US-based + currently hiring, and exposes a normalized-name lookup.
// Used by hn_hiring to drop non-YC comments and by scripts/probe-yc-ats.js to
// discover YC companies on Greenhouse/Lever/Ashby.
//
// The underlying data is Algolia's YC index, mirrored daily.

const FEED_URL =
  'https://raw.githubusercontent.com/akshaybhalotia/yc_company_scraper/main/data/yc_essential_data.json';

// Regions whose presence in `regions[]` marks the company as US-adjacent.
// "America / Canada" includes Canadian-only companies; we also require the
// explicit "United States of America" tag to keep CA-only out.
const US_REGION = 'United States of America';

let cache = null;

function slugName(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

async function loadUsHiringCompanies() {
  if (cache) return cache;

  const data = await fetchJson(FEED_URL, { retries: 2 });
  const arr = Array.isArray(data) ? data : [];

  const companies = arr.filter(
    (c) => c.isHiring && Array.isArray(c.regions) && c.regions.includes(US_REGION)
  );

  // Index by normalized name. We do THREE passes with priority so that a
  // primary-name match always wins over a slug/former_name match — otherwise
  // "Sage" would get matched to some YC company whose former_name was "Sage"
  // even when a primary-name-"Sage" YC company exists.
  //
  //   pass 1: c.name          (highest priority)
  //   pass 2: c.slug          (only if not already set)
  //   pass 3: c.former_names  (only if not already set)
  const byName = new Map();
  const add = (key, company) => {
    const k = slugName(key);
    if (!k || byName.has(k)) return;
    byName.set(k, company);
  };

  for (const c of companies) add(c.name, c);
  for (const c of companies) if (c.slug) add(c.slug, c);
  for (const c of companies) {
    if (Array.isArray(c.former_names)) {
      for (const fn of c.former_names) add(fn, c);
    }
  }

  cache = { companies, byName, slugName };
  return cache;
}

function resetCache() {
  cache = null;
}

module.exports = { loadUsHiringCompanies, slugName, resetCache, FEED_URL };
