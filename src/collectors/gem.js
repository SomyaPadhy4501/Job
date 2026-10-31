'use strict';

const { fetchJson } = require('./http');

// Gem public job board API — unauthenticated, one request per employer, full
// description included. Same shape as Greenhouse's board API (Gem's ATS grew
// out of a Greenhouse integration):
//   https://api.gem.com/job_board/v0/{slug}/job_posts/
//
// Config shape:
//   { source: 'gem', slug, displayName }
//
// `slug` is the path segment in jobs.gem.com/{slug}.

function buildLocation(j) {
  const names = Array.isArray(j.offices) && j.offices.length
    ? j.offices.map((o) => o.location?.name || o.name).filter(Boolean)
    : [];
  const base = names.length ? names.join('; ') : j.location?.name || '';
  return j.location_type === 'remote' && !/remote/i.test(base)
    ? (base ? `${base}, Remote` : 'Remote')
    : base;
}

function mapPosting(j, { slug, displayName }) {
  return {
    source: 'gem',
    external_id: `${slug}:${j.id}`,
    company_name: (displayName || slug).trim(),
    job_title: (j.title || '').trim(),
    location: buildLocation(j),
    apply_url: j.absolute_url || '',
    description: j.content || j.content_plain || '',
    date_posted: j.first_published_at || j.created_at || null,
  };
}

async function fetchCompany({ slug, displayName }) {
  if (!slug) throw new Error('gem entry missing slug');
  const data = await fetchJson(`https://api.gem.com/job_board/v0/${encodeURIComponent(slug)}/job_posts/`);
  const posts = Array.isArray(data) ? data : [];
  return posts
    .filter((j) => j.id && j.title && j.absolute_url)
    .map((j) => mapPosting(j, { slug, displayName }));
}

module.exports = { fetchCompany, mapPosting, source: 'gem' };
