'use strict';

const { fetchJson } = require('./http');

// Recruitee public offers API — unauthenticated, one request per employer,
// full description included:
//   https://{slug}.recruitee.com/api/offers/
//
// Config shape:
//   { source: 'recruitee', slug, displayName }
//
// `slug` is the subdomain. Employers often front the board with their own
// domain (careers.bunq.com), but the recruitee.com subdomain still answers.
// Find new ones with scripts/probe-ats.js.

function buildLocation(o) {
  const base = o.location || [o.city, o.state_name, o.country].filter(Boolean).join(', ');
  return o.remote ? (base ? `${base}, Remote` : 'Remote') : base;
}

function mapPosting(o, { slug, displayName }) {
  return {
    source: 'recruitee',
    external_id: `${slug}:${o.id}`,
    company_name: (displayName || o.company_name || slug).trim(),
    job_title: (o.title || '').trim(),
    location: buildLocation(o),
    apply_url: o.careers_url || o.careers_apply_url || '',
    // `requirements` is a separate block and is where work-authorization
    // language usually sits — dropping it would blind the restriction filter.
    description: [o.description, o.requirements].filter(Boolean).join('\n'),
    // Publish date — see gem.js on why not updated_at.
    date_posted: o.published_at || o.created_at || o.updated_at || null,
  };
}

async function fetchCompany({ slug, displayName }) {
  if (!slug) throw new Error('recruitee entry missing slug');
  const data = await fetchJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`);
  const offers = Array.isArray(data?.offers) ? data.offers : [];
  return offers
    .filter((o) => o.id && o.title && (!o.status || o.status === 'published'))
    .map((o) => mapPosting(o, { slug, displayName }));
}

module.exports = { fetchCompany, mapPosting, source: 'recruitee' };
