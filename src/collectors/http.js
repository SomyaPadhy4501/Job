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

// Rate limits are per IP across a whole platform (every Workday tenant shares
// one limit), so one 429 means every request to that platform should wait,
// not just the one that got it. Each retrying on its own kept six tenants
// hammering the limit together: on 2026-11-24 248 of 256 Workday employers
// failed in one run. Keyed by the last two host labels (myworkdayjobs.com).
const cooldownUntil = new Map();
const MAX_COOLDOWN_MS = 60_000;
// Extra attempts for a 429 alone: with the shared pause they usually succeed.
const RATE_LIMIT_RETRIES = 4;
// Circuit breaker: after this many 429s in a row from one platform (no
// success in between), its remaining requests this run fail at once. An IP
// blocked for an hour would otherwise keep every tenant waiting until GitHub
// kills the job, losing the whole run instead of one platform.
const GIVE_UP_AFTER = 25;
const strikes = new Map();

// The first 429 from each platform is logged with what came with it, which
// tells a rate limit (Retry-After, a short wait) from a block on the runner's
// address (a WAF page, no Retry-After). Workday answered 255 of 256 employers
// with 429 on 2026-11-24 from GitHub's runners while a home connection got 200.
const noted429 = new Set();
async function noteFirst429(platform, res) {
  if (noted429.has(platform)) return;
  noted429.add(platform);
  const body = await res.text().catch(() => '');
  const headers = {};
  for (const h of ['retry-after', 'server', 'cf-ray', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-type']) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  console.warn(`[http] first 429 from ${platform}: ${JSON.stringify(headers)} ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
}

function platformOf(url) {
  try {
    return new URL(url).hostname.split('.').slice(-2).join('.');
  } catch {
    return '';
  }
}

async function waitForCooldown(platform) {
  const until = cooldownUntil.get(platform) || 0;
  const wait = until - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function startCooldown(platform, ms) {
  const until = Date.now() + Math.min(ms, MAX_COOLDOWN_MS);
  if (until > (cooldownUntil.get(platform) || 0)) cooldownUntil.set(platform, until);
}

// Shared fetch wrapper with timeout + basic retries.
async function fetchJson(url, { retries = 2, headers = {}, method = 'GET', body } = {}) {
  let lastErr;
  const platform = platformOf(url);
  let rateLimited = 0;
  for (let attempt = 0; attempt <= retries + rateLimited; attempt++) {
    if ((strikes.get(platform) || 0) >= GIVE_UP_AFTER) {
      const err = new Error(`HTTP 429 for ${url} (${platform} rate-limited this run; gave up)`);
      err.status = 429;
      throw err;
    }
    await waitForCooldown(platform);
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
        err.retryAfter = Number(res.headers.get('retry-after')) || 0;
        if (res.status === 429) await noteFirst429(platform, res);
        throw err;
      }
      const data = await res.json();
      strikes.set(platform, 0);
      return data;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (err.status === 404) throw err; // no point retrying 404
      if (err.status === 429) {
        // A 429 needs seconds, not the half-second used for transient errors.
        // Honour Retry-After when given; pause the whole platform, and allow
        // a few more attempts than other errors get.
        if (rateLimited < RATE_LIMIT_RETRIES) rateLimited++;
        strikes.set(platform, (strikes.get(platform) || 0) + 1);
        startCooldown(platform, (err.retryAfter || 5 * 2 ** Math.min(attempt, 3)) * 1000);
      } else if (attempt < retries + rateLimited) {
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

// For tests: forget cooldowns and strikes between cases.
function resetRateLimits() {
  cooldownUntil.clear();
  strikes.clear();
  noted429.clear();
}

module.exports = { fetchJson, runWithConcurrency, resetRateLimits, GIVE_UP_AFTER };
