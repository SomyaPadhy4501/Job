#!/usr/bin/env node
'use strict';

// Discovers US-HQ companies listed on topstartups.io that have public boards
// on Greenhouse / Lever / Ashby. Complements scripts/probe-yc-ats.js — together
// they cover "well-known startup" + "curated top startups" without touching any
// site that actively blocks scrapers.
//
// topstartups.io renders 20 cards per infinite-scroll page; each card has
// company name, website URL, industry tags, and an HQ location line. We skip
// non-US HQs (most common: Bangalore, London, Berlin, etc.) and dedupe against
// src/config.js::COMPANIES so the output is strictly new entries.
//
// Verification is built in (unlike probe-yc-ats.js, which emitted unverified
// candidates that needed a second pass): Greenhouse boards are name-matched
// against the company name via /boards/{slug}, and Lever/Ashby require slug to
// be derivable from the name or website domain.
//
// Output:
//   scripts/topstartups-ats-discovered.txt — config-ready entries
//   scripts/topstartups-ats-rejected.txt   — with reason
//
// Usage:
//   node scripts/probe-topstartups.js
//   node scripts/probe-topstartups.js --max-pages=30

const fs = require('fs');
const path = require('path');
const { runWithConcurrency } = require('../src/collectors/http');
const { COMPANIES } = require('../src/config');

const OUT_OK = path.join(__dirname, 'topstartups-ats-discovered.txt');
const OUT_BAD = path.join(__dirname, 'topstartups-ats-rejected.txt');
const LOG_FILE = path.join(__dirname, 'topstartups-ats-discovered.log');
const CONCURRENCY = 8;
const REQ_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 100;

const ATS_PROBES = [
  {
    source: 'greenhouse',
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    hasJobs: (d) => Array.isArray(d?.jobs) && d.jobs.length > 0,
  },
  {
    source: 'lever',
    url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    hasJobs: (d) => Array.isArray(d) && d.length > 0,
  },
  {
    source: 'ashby',
    url: (slug) =>
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`,
    hasJobs: (d) => Array.isArray(d?.jobs) && d.jobs.length > 0,
  },
];

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|corp|co|the|ai|io|app)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function slugVariants({ name, website }) {
  const out = new Set();
  const add = (s) => {
    if (!s) return;
    const v = String(s).toLowerCase().trim();
    if (!/^[a-z0-9\-]+$/.test(v)) return;
    if (v.length < 2 || v.length > 40) return;
    out.add(v);
  };

  const nameDash = (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (nameDash) add(nameDash);
  const nameFlat = nameDash.replace(/-/g, '');
  if (nameFlat) add(nameFlat);

  if (website) {
    try {
      const host = new URL(website).hostname.replace(/^www\./, '');
      const stem = host.split('.')[0];
      add(stem);
    } catch {}
  }
  return [...out];
}

async function quickJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'job-aggregator-probe/1.0', accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function fetchPageHtml(page) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
  try {
    const url = page <= 1 ? 'https://topstartups.io/' : `https://topstartups.io/?page=${page}`;
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(t);
    return null;
  }
}

// topstartups uses jQuery infinite scroll. We append ?page=N until we stop
// getting new cards. Each card is a Bootstrap .card.card-body with
// id="item-card-filter" followed by company-info markup. The startup-website
// anchor holds both the company name (in <h3>) and the website URL (href).
// HQ is the "📍HQ: …" line in plain text.
function parseCards(html) {
  if (!html) return [];
  const out = [];

  // Each real startup card wraps an anchor with id="startup-website-link".
  // The first "card-body" on the page is the filter form — skip anything
  // without that anchor.
  const cardRe =
    /<a[^>]+href="([^"]+)"[^>]*id="startup-website-link"[^>]*>\s*<h3[^>]*>([^<]+)<\/a>\s*<\/h3>([\s\S]*?)(?=<div class="card card-body"|<\/div>\s*<br>\s*<\/div>)/gi;
  let m;
  while ((m = cardRe.exec(html))) {
    const urlRaw = m[1].replace(/&amp;/g, '&');
    const nameRaw = m[2].trim();
    const rest = m[3];

    // Strip UTM params so the website stem we derive is clean.
    let website = '';
    try {
      const u = new URL(urlRaw);
      website = `${u.protocol}//${u.hostname}`;
    } catch {
      website = urlRaw.split('?')[0];
    }

    // HQ line lives as plain text after "📍HQ:" — capture up to the next
    // <br> or tag. Emoji is the reliable anchor.
    const hqMatch = rest.match(/📍\s*HQ:\s*([^<\n]+)/i);
    const hq = hqMatch ? hqMatch[1].trim() : '';

    out.push({ name: nameRaw, website, hq });
  }
  return out;
}

const US_STATES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
  'va','wa','wv','wi','wy','dc',
]);

function isUsHq(hq) {
  if (!hq) return false;
  const s = hq.toLowerCase();
  if (/\bu\.?s\.?a?\.?\b/i.test(hq)) return true;
  if (/\bunited states\b/i.test(hq)) return true;
  // "Brooklyn, New York" / "San Francisco, CA" — look for a trailing 2-letter
  // state code.
  const tokens = s.split(/[,\s]+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length === 2 && US_STATES.has(t)) return true;
  }
  // Match well-known US-only city spellings without state abbreviation.
  if (/\b(san francisco|new york|nyc|brooklyn|los angeles|seattle|boston|chicago|austin|denver|atlanta|miami|houston|dallas|portland|washington dc)\b/i.test(hq)) {
    return true;
  }
  return false;
}

async function verifyGreenhouse(slug, companyName) {
  const meta = await quickJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`
  );
  if (!meta || !meta.name) return { ok: false, reason: 'no-meta' };
  const boardNorm = normName(meta.name);
  const compNorm = normName(companyName);
  if (boardNorm === compNorm) return { ok: true, boardName: meta.name };
  const GENERIC = /^(careers?|jobs?|hiring|team|recruiting|hr|board)$/i;
  const tokens = meta.name.trim().split(/\s+/);
  if (tokens.length >= 2) {
    const firstNorm = normName(tokens[0]);
    const restAllGeneric = tokens.slice(1).every((t) => GENERIC.test(t));
    if (restAllGeneric && firstNorm === compNorm) return { ok: true, boardName: meta.name };
  }
  return { ok: false, reason: `name-mismatch: "${meta.name}" vs "${companyName}"` };
}

// Lever/Ashby: provenance check only (we already tried variants derived from
// name + website, so the slug must match one of them).
function verifyProvenance(slug, company) {
  const variants = new Set(slugVariants(company));
  if (variants.has(slug.toLowerCase())) return { ok: true };
  return { ok: false, reason: `slug "${slug}" not derivable from "${company.name}"` };
}

async function probeOne(company, existingKeys) {
  const variants = slugVariants(company);
  for (const probe of ATS_PROBES) {
    for (const slug of variants) {
      const key = `${probe.source}:${slug}`;
      if (existingKeys.has(key)) return { skipped: 'already-registered' };
      const data = await quickJson(probe.url(slug));
      if (!data || !probe.hasJobs(data)) continue;

      // Verify before returning
      let verdict;
      if (probe.source === 'greenhouse') {
        verdict = await verifyGreenhouse(slug, company.name);
      } else {
        verdict = verifyProvenance(slug, company);
      }
      if (!verdict.ok) {
        return { hit: { source: probe.source, slug, company, rejected: verdict.reason } };
      }
      return { hit: { source: probe.source, slug, company, verified: true } };
    }
  }
  return null;
}

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w[\w-]*)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function main() {
  const args = parseArgs();
  const maxPages = Number(args['max-pages']) || DEFAULT_MAX_PAGES;

  const logLines = [];
  const log = (s) => {
    logLines.push(s);
    process.stderr.write(s + '\n');
  };

  log(`scraping topstartups.io up to ${maxPages} pages…`);

  const seenCompanies = new Map(); // normName → { name, website, hq }
  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchPageHtml(page);
    if (!html) {
      log(`page ${page}: fetch failed, stopping`);
      break;
    }
    const cards = parseCards(html);
    if (cards.length === 0) {
      log(`page ${page}: 0 cards, stopping`);
      break;
    }
    let added = 0;
    for (const c of cards) {
      const key = normName(c.name);
      if (!key || seenCompanies.has(key)) continue;
      seenCompanies.set(key, c);
      added++;
    }
    log(`page ${page}: ${cards.length} cards, ${added} new (total ${seenCompanies.size})`);
    if (added === 0) {
      log(`page ${page}: all duplicates, stopping`);
      break;
    }
  }

  const all = [...seenCompanies.values()];
  const usOnly = all.filter((c) => isUsHq(c.hq));
  log(`\n${all.length} total companies, ${usOnly.length} US-HQ`);

  const existingKeys = new Set(
    COMPANIES.filter((c) => c.slug).map((c) => `${c.source}:${c.slug.toLowerCase()}`)
  );

  const started = Date.now();
  let done = 0;
  const results = await runWithConcurrency(usOnly, CONCURRENCY, async (c) => {
    const r = await probeOne(c, existingKeys);
    done++;
    if (done % 50 === 0) {
      log(`  probe ${done}/${usOnly.length} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
    return r;
  });

  const verified = [];
  const rejected = [];
  const skipped = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    if (r.skipped) {
      skipped.push(usOnly[i]);
      continue;
    }
    if (r.hit?.verified) verified.push(r.hit);
    else if (r.hit?.rejected) rejected.push(r.hit);
  }

  log(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s — ` +
      `verified:${verified.length} rejected:${rejected.length} already-in-config:${skipped.length}`
  );

  // Emit config-ready grouped by source
  const lines = [];
  for (const source of ['greenhouse', 'lever', 'ashby']) {
    const list = verified
      .filter((h) => h.source === source)
      .sort((a, b) => a.company.name.localeCompare(b.company.name));
    lines.push(`\n// ─── ${source} (${list.length} verified topstartups.io companies) ───`);
    for (const h of list) {
      const name = h.company.name.replace(/'/g, "\\'");
      const hq = h.company.hq.replace(/'/g, "\\'");
      lines.push(
        `  { source: '${source}', slug: '${h.slug}', displayName: '${name}' }, // topstartups; HQ: ${hq}`
      );
    }
  }
  fs.writeFileSync(OUT_OK, lines.join('\n') + '\n');

  const badLines = rejected
    .sort((a, b) => a.source.localeCompare(b.source) || a.slug.localeCompare(b.slug))
    .map((h) => `[${h.source}] ${h.slug} (${h.company.name}) — ${h.rejected}`);
  fs.writeFileSync(OUT_BAD, badLines.join('\n') + '\n');

  fs.writeFileSync(LOG_FILE, logLines.join('\n') + '\n');

  log(`\nverified -> ${path.relative(process.cwd(), OUT_OK)}`);
  log(`rejected -> ${path.relative(process.cwd(), OUT_BAD)}`);
  log(`log      -> ${path.relative(process.cwd(), LOG_FILE)}`);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
