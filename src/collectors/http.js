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
