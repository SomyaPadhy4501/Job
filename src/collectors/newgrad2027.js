'use strict';

const { fetchJson } = require('./http');

// Community-maintained new-grad 2027 listings (MIT-licensed), a single JSON file
// on GitHub. Gives us coverage of big-tech career sites we can't reach via their
// own APIs (Google, Apple, Meta, Tesla, TikTok, ByteDance, etc.).
// Repo: https://github.com/vanshb03/New-Grad-2027
const DATA_URL =
  'https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json';

// The repo already labels sponsorship — we map it to our YES/NO/UNKNOWN and
// mark it as an override so the classifier doesn't second-guess it.
const SPONSOR_MAP = {
  'Offers Sponsorship': 'YES',
  'Does Not Offer Sponsorship': 'NO',
  'U.S. Citizenship is Required': 'NO',
};

async function fetchCompany({ displayName }) {
  const data = await fetchJson(DATA_URL);
  const rows = Array.isArray(data) ? data : [];

  const out = [];
  for (const d of rows) {
    if (!d.active || !d.is_visible) continue;
    const location = Array.isArray(d.locations)
      ? d.locations.join(', ')
      : d.locations || '';
    out.push({
      source: 'newgrad2027',
      external_id: d.id,
      company_name: (d.company_name || displayName || '').trim(),
      job_title: (d.title || '').trim(),
      location,
      apply_url: d.url || '',
      description: '',
      date_posted: d.date_posted ? new Date(d.date_posted * 1000).toISOString() : null,
      // Pre-labeled — take precedence over the rule-based classifier.
      sponsorship_override: SPONSOR_MAP[d.sponsorship],
      // Every row in this source is a new-grad posting by construction.
      entry_level_override: 1,
    });
  }
  return out;
}

module.exports = { fetchCompany, source: 'newgrad2027' };
