'use strict';

const https = require('https');
const { CONFIG } = require('../config');

// Hostname-scoped TLS bypass. Used only for hosts listed in INSECURE_TLS_HOSTS —
// currently just Microsoft's misconfigured careers endpoint, which serves a
// `*.azureedge.net` cert for `gcsservices.careers.microsoft.com`. We go through
// a raw https.request for those hosts so we can set `rejectUnauthorized: false`
// without globally disabling TLS verification.
const INSECURE_TLS_HOSTS = new Set([
  'gcsservices.careers.microsoft.com',
]);

function needsInsecureTls(url) {
  try {
    return INSECURE_TLS_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function requestInsecureJson(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        rejectUnauthorized: false,
        headers: {
          'user-agent': 'job-aggregator/1.0',
          accept: 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 404) {
            const err = new Error(`Not found: ${url}`);
            err.status = 404;
            return reject(err);
          }
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.setTimeout(CONFIG.requestTimeoutMs, () => {
      req.destroy(new Error(`timeout after ${CONFIG.requestTimeoutMs}ms`));
    });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Retry-After as milliseconds: delta-seconds or an HTTP date, capped so one
// header can't stall a run. Null when absent or unreadable.
const MAX_RETRY_AFTER_MS = 30_000;
function parseRetryAfter(value) {
  if (!value) return null;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : null;
}

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
      if (needsInsecureTls(url)) {
        clearTimeout(t);
        return await requestInsecureJson(url, { method, headers: init.headers, body: init.body });
      }
      const res = await fetch(url, init);
      clearTimeout(t);
      if (res.status === 404) {
        const err = new Error(`Not found: ${url}`);
        err.status = 404;
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        if (res.status === 429) err.retryAfterMs = parseRetryAfter(res.headers?.get('retry-after'));
        throw err;
      }
      return await res.json();
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (err.status === 404) throw err; // no point retrying 404
      if (attempt < retries) {
        // A 429 asks us to slow down. The half-second retry meant for flaky
        // connections lands inside the same limit, so a rate-limited source
        // failed outright: 6 of 16 Getro networks, every run, on 2026-10-31.
        const wait = err.status === 429
          ? err.retryAfterMs ?? 2000 * 2 ** attempt
          : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, wait));
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

module.exports = { fetchJson, runWithConcurrency, parseRetryAfter };
