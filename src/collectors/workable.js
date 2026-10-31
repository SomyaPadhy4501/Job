'use strict';

const { fetchJson } = require('./http');

// Workable public careers widget API — unauthenticated, one request per
// employer, and it returns full description HTML with details=true:
//   https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
//
// robots.txt on apply.workable.com disallows nothing (checked 2026-10-31).
//
// Config shape:
//   { source: 'workable', slug, displayName }
//
// `slug` is the account name in the board URL (apply.workable.com/{slug}).
// Find new ones with scripts/probe-ats.js.

const API_BASE = 'https://apply.workable.com/api/v1/widget/accounts';

function formatLocation(loc) {
  if (!loc) return '';
  return [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
}

// A posting can list several offices. Prefer a US one so looksUS() sees it —
// "Paris, Île-de-France, France; New York, NY, United States" would otherwise
// read as French on the first match.
function buildLocation(j) {
  const locs = Array.isArray(j.locations) && j.locations.length
    ? j.locations
    : [{ city: j.city, region: j.state, country: j.country, countryCode: '' }];
  const us = locs.find((l) => /^us$/i.test(l.countryCode || '') || /united states/i.test(l.country || ''));
  const base = formatLocation(us || locs[0]);
  const remote = String(j.telecommuting) === 'true';
  return remote ? (base ? `${base}, Remote` : 'Remote') : base;
}

function mapPosting(j, { slug, displayName, accountName }) {
  return {
    source: 'workable',
    external_id: `${slug}:${j.shortcode}`,
    company_name: (displayName || accountName || slug).trim(),
    job_title: (j.title || '').trim(),
    location: buildLocation(j),
    apply_url: j.url || j.shortlink || `https://apply.workable.com/${encodeURIComponent(slug)}/j/${j.shortcode}`,
    description: j.description || '',
    date_posted: j.published_on || j.created_at || null,
  };
}

async function fetchCompany({ slug, displayName }) {
  if (!slug) throw new Error('workable entry missing slug');
  const data = await fetchJson(`${API_BASE}/${encodeURIComponent(slug)}?details=true`);
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs
    .filter((j) => j.shortcode && j.title)
    .map((j) => mapPosting(j, { slug, displayName, accountName: data?.name }));
}

module.exports = { fetchCompany, mapPosting, buildLocation, source: 'workable' };
