'use strict';

const { CONFIG } = require('./config');
const log = require('./logger');

// POST a batch of raw jobs to the main API's /admin/ingest endpoint.
// Returns { ok, received, inserted, updated, rejected } or throws on hard failure.
async function ingest(source, jobs) {
  if (!jobs || !jobs.length) return { ok: true, received: 0, inserted: 0, updated: 0, rejected: 0 };

  const headers = { 'content-type': 'application/json' };
  if (CONFIG.ingestToken) headers['x-collect-token'] = CONFIG.ingestToken;

  const res = await fetch(CONFIG.ingestUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source, jobs }),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) {
    log.error('ingest.reject', { source, status: res.status, body });
    throw new Error(`Ingest failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return body;
}

module.exports = { ingest };
