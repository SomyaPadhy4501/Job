'use strict';

const { fetchJson, runWithConcurrency } = require('./http');
const { CONFIG } = require('../config');
const { looksSoftware, passesLevel } = require('../services/normalize');

// BambooHR public careers site — unauthenticated JSON behind the hosted
// careers page:
//   list:   https://{slug}.bamboohr.com/careers/list
//   detail: https://{slug}.bamboohr.com/careers/{id}/detail
//
// The list has title and location only; description and posting date need the
// detail call. So titles are filtered locally first (same approach as
// smartrecruiters.js) and only plausible software roles cost a second request.
// A non-existent tenant answers with a 302 to bamboohr.com, which fetchJson
// surfaces as a non-JSON error — that's the "wrong slug" signal.
//
// Config shape:
//   { source: 'bamboohr', slug, displayName, maxDetail }

const DEFAULT_MAX_DETAIL = 60;
const DETAIL_CONCURRENCY = 3;

function buildLocation(item) {
  const loc = item.atsLocation || item.location || {};
  const parts = [loc.city, loc.state || loc.province, loc.country].filter(Boolean);
  const base = parts.join(', ');
  const remote = item.isRemote || /remote/i.test(String(item.locationType || ''));
  return remote ? (base ? `${base}, Remote` : 'Remote') : base;
}

function mapPosting(item, { slug, displayName, detail }) {
  const opening = detail?.result?.jobOpening || {};
  return {
    source: 'bamboohr',
    external_id: `${slug}:${item.id}`,
    company_name: (displayName || slug).trim(),
    job_title: (item.jobOpeningName || opening.jobOpeningName || '').trim(),
    location: buildLocation({ ...item, ...opening }),
    apply_url:
      opening.jobOpeningShareUrl ||
      `https://${encodeURIComponent(slug)}.bamboohr.com/careers/${encodeURIComponent(item.id)}`,
    description: opening.description || '',
    date_posted: opening.datePosted || null,
  };
}

async function fetchCompany({ slug, displayName, maxDetail }) {
  if (!slug) throw new Error('bamboohr entry missing slug');
  const base = `https://${encodeURIComponent(slug)}.bamboohr.com/careers`;
  const data = await fetchJson(`${base}/list`, { headers: { Accept: 'application/json' } });
  const items = Array.isArray(data?.result) ? data.result : [];

  const candidates = items.filter((i) => {
    const title = String(i.jobOpeningName || '').trim();
    if (!i.id || !title) return false;
    if (CONFIG.filterSoftwareOnly && !looksSoftware(title)) return false;
    return passesLevel(title, CONFIG.entryLevelMode || 'permissive');
  });

  const toEnrich = candidates.slice(0, maxDetail || DEFAULT_MAX_DETAIL);
  const details = await runWithConcurrency(toEnrich, DETAIL_CONCURRENCY, (i) =>
    fetchJson(`${base}/${encodeURIComponent(i.id)}/detail`, {
      retries: 1,
      headers: { Accept: 'application/json' },
    })
  );

  return candidates.map((item, idx) => {
    const detail = idx < toEnrich.length && !details[idx]?.__error ? details[idx] : null;
    return mapPosting(item, { slug, displayName, detail });
  });
}

module.exports = { fetchCompany, mapPosting, buildLocation, source: 'bamboohr' };
