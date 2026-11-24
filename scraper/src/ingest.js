'use strict';

const { CONFIG } = require('./config');
const log = require('./logger');

// POST a batch of raw jobs to the main API's /admin/ingest endpoint.
// Returns { ok, received, inserted, updated, rejected } or throws on hard failure.
async function ingest(source, jobs) {
  if (!jobs || !jobs.length) return { ok: true, received: 0, inserted: 0, updated: 0, rejected: 0 };

  const headers = { 'content-type': 'application/json' };
  if (CONFIG.ingestToken) headers['x-collect-token'] = CONFIG.ingestToken;

  // Ingest is an upsert, so one retry after a network error or a 5xx (a Vercel
  // cold start, a Neon hiccup) is safe. The timeout stops a hung request from
  // holding the job until GitHub kills it.
  const post = () =>
    fetch(CONFIG.ingestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source, jobs }),
      signal: AbortSignal.timeout(120_000),
    });
  let res;
  try {
    res = await post();
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    log.warn('ingest.retry', { source, error: err.message });
    await new Promise((r) => setTimeout(r, 10_000));
    res = await post();
  }

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
