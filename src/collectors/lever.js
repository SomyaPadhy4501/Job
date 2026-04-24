'use strict';

const { fetchJson } = require('./http');

// Lever public postings API. mode=json returns parsed fields plus description HTML.
async function fetchCompany({ slug, displayName }) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const data = await fetchJson(url);
  const postings = Array.isArray(data) ? data : [];

  return postings.map((p) => {
    // Lever has several location fields; prefer the human-readable one.
    const loc =
      p.categories?.location ||
      (Array.isArray(p.categories?.allLocations) ? p.categories.allLocations.join(', ') : '') ||
      '';

    // Combine HTML body + list sections for a richer description the classifier can scan.
    const listsHtml = Array.isArray(p.lists)
      ? p.lists.map((l) => `<h3>${l.text || ''}</h3>${l.content || ''}`).join('\n')
      : '';
    const description = [p.descriptionHtml || p.description || '', listsHtml, p.additional || '']
      .filter(Boolean)
      .join('\n');

    return {
      source: 'lever',
      external_id: p.id,
      company_name: displayName || slug,
      job_title: p.text || '',
      location: loc,
      apply_url: p.hostedUrl || p.applyUrl || '',
      description,
      date_posted: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    };
  });
}

module.exports = { fetchCompany, source: 'lever' };
