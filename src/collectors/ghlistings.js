'use strict';

const { fetchJson } = require('./http');

// Generic collector for community-maintained GitHub JSON lists (vanshb03/New-Grad-2027,
// SimplifyJobs/New-Grad-Positions, and others with the same schema). The URL is
// supplied per company config entry, so adding a new list is just a config line.
// These sources give us coverage of Google / Apple / Meta / Microsoft and other
// big-tech career sites that don't expose usable public JSON APIs.
//
// Schema (shared by both repos): { company_name, title, url, locations[], date_posted,
// sponsorship, active, is_visible, id }. sponsorship is pre-labeled and takes
// precedence over our rule-based classifier.

const SPONSOR_MAP = {
  'Offers Sponsorship': 'YES',
  'Does Not Offer Sponsorship': 'NO',
  'U.S. Citizenship is Required': 'NO',
};

async function fetchCompany({ url, slug, displayName }) {
  if (!url) throw new Error(`ghlistings entry "${slug}" missing url`);

  const data = await fetchJson(url);
  const rows = Array.isArray(data) ? data : [];

  const out = [];
  for (const d of rows) {
    if (!d.active) continue;
    if (d.is_visible === false) continue;

    const location = Array.isArray(d.locations)
      ? d.locations.join(', ')
      : d.locations || '';

    out.push({
      source: 'ghlistings',
      // Namespace the id so the two lists can't collide on external_id.
      external_id: `${slug}:${d.id || ''}`,
      company_name: (d.company_name || '').trim(),
      job_title: (d.title || '').trim(),
      location,
      apply_url: d.url || '',
      description: '',
      date_posted: d.date_posted ? d.date_posted * 1000 : null, // seconds → ms; parseDateToIso handles it
      sponsorship_override: SPONSOR_MAP[d.sponsorship],
      entry_level_override: 1,
    });
  }
  return out;
}

module.exports = { fetchCompany, source: 'ghlistings' };
