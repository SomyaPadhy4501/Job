'use strict';

const { fetchJson } = require('./http');

// Pinpoint public postings feed — unauthenticated, one request per employer:
//   https://{slug}.pinpointhq.com/postings.json
//
// The feed carries no posting date, so these rows rely on the first-seen stamp
// in upsertJob (same as Workday / Microsoft). Location has no country field —
// only city / province — so US rows read "Austin, Texas" and looksUS() decides.
//
// Config shape:
//   { source: 'pinpoint', slug, displayName }

function buildLocation(p) {
  const loc = p.location || {};
  const base = [loc.city, loc.province].filter(Boolean).join(', ') || loc.name || '';
  return p.workplace_type === 'remote' ? (base ? `${base}, Remote` : 'Remote') : base;
}

function mapPosting(p, { slug, displayName }) {
  return {
    source: 'pinpoint',
    external_id: `${slug}:${p.id}`,
    company_name: (displayName || slug).trim(),
    job_title: (p.title || '').trim(),
    location: buildLocation(p),
    apply_url: p.url || '',
    // The posting body is split across several rich-text fields; requirements
    // live in skills_knowledge_expertise.
    description: [p.description, p.key_responsibilities, p.skills_knowledge_expertise, p.benefits]
      .filter(Boolean)
      .join('\n'),
    date_posted: null,
  };
}

async function fetchCompany({ slug, displayName }) {
  if (!slug) throw new Error('pinpoint entry missing slug');
  const data = await fetchJson(`https://${encodeURIComponent(slug)}.pinpointhq.com/postings.json`);
  const postings = Array.isArray(data?.data) ? data.data : [];
  return postings
    .filter((p) => p.id && p.title && p.url)
    .map((p) => mapPosting(p, { slug, displayName }));
}

module.exports = { fetchCompany, mapPosting, source: 'pinpoint' };
