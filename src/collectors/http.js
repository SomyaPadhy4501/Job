'use strict';

const { CONFIG } = require('../config');

// Shared fetch wrapper with timeout + basic retries.
async function fetchJson(url, { retries = 2, headers = {}, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
    try {
      const init = {
        method,
        headers: { 'user-agent': 'job-aggregator/1.0', accept: 'application/json', ...headers },
        signal: ctrl.signal,
      };
      if (body != null) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        init.headers['content-type'] = init.headers['content-type'] || 'application/json';
      }
      const res = await fetch(url, init);
      clearTimeout(t);
      if (res.status === 404) {
        const err = new Error(`Not found: ${url}`);
        err.status = 404;
        throw err;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (err.status === 404) throw err; // no point retrying 404
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// Run an async worker against a list with a concurrency cap.
async function runWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await worker(items[idx], idx);
      } catch (err) {
        out[idx] = { __error: err?.message || String(err) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

module.exports = { fetchJson, runWithConcurrency };
