#!/usr/bin/env node
'use strict';

// One-shot discovery tool.
//
// Loads the US-hiring YC company list, then probes each company against the
// public Greenhouse / Lever / Ashby job-board APIs with a handful of slug
// variants derived from the company name, YC slug, and website domain.
//
// Output: JSON arrays of `{ source, slug, displayName }` entries — one array
// per ATS — ready to copy-paste into src/config.js::COMPANIES. Only prints
// companies that (a) aren't already registered and (b) currently have at
// least one open posting on that ATS.
//
// Runtime: ~5-10 minutes for ~1,800 YC US-hiring companies. Run manually.
//
//   node scripts/probe-yc-ats.js
//   node scripts/probe-yc-ats.js > scripts/yc-ats.out.json

const { loadUsHiringCompanies } = require('../src/collectors/yc_companies');
const { runWithConcurrency } = require('../src/collectors/http');
const { COMPANIES } = require('../src/config');

const CONCURRENCY = 8;
const REQ_TIMEOUT_MS = 10_000;

const ATS_PROBES = [
  {
    source: 'greenhouse',
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    hasJobs: (data) => Array.isArray(data?.jobs) && data.jobs.length > 0,
  },
  {
    source: 'lever',
    url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    hasJobs: (data) => Array.isArray(data) && data.length > 0,
  },
  {
    source: 'ashby',
    url: (slug) =>
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=false`,
    hasJobs: (data) => Array.isArray(data?.jobs) && data.jobs.length > 0,
  },
];

function slugVariants(company) {
  const out = new Set();
  const add = (s) => {
    if (!s) return;
    const v = String(s).toLowerCase().trim();
    if (!/^[a-z0-9\-]+$/.test(v)) return;
    if (v.length < 2 || v.length > 40) return;
    out.add(v);
  };

  if (company.slug) add(company.slug);

  const nameDash = (company.name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (nameDash) add(nameDash);

  const nameFlat = nameDash.replace(/-/g, '');
  if (nameFlat) add(nameFlat);

  if (company.website) {
    try {
      const host = new URL(company.website).hostname.replace(/^www\./, '');
      const stem = host.split('.')[0];
      add(stem);
    } catch {
      /* ignore malformed url */
    }
  }

  return [...out];
}

// Bare fetch with timeout. We can't use the shared fetchJson helper because
// it retries and logs errors loudly — for a probe that's expected to 404 a lot,
// we want fast-fail silent behavior.
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

async function probeOne(company, existingKeys) {
  const variants = slugVariants(company);
  for (const probe of ATS_PROBES) {
    for (const slug of variants) {
      const key = `${probe.source}:${slug}`;
      if (existingKeys.has(key)) return null; // already in COMPANIES, skip
      const data = await quickJson(probe.url(slug));
      if (!data) continue;
      if (!probe.hasJobs(data)) continue;
      return {
        source: probe.source,
        slug,
        displayName: company.name,
        ycBatch: company.batch,
        ycUrl: company.website,
      };
    }
  }
  return null;
}

function parseLimit() {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  if (!arg) return null;
  const n = Number(arg.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main() {
  const started = Date.now();
  process.stderr.write('loading YC companies…\n');
  const { companies: all } = await loadUsHiringCompanies();
  const limit = parseLimit();
  const companies = limit ? all.slice(0, limit) : all;
  process.stderr.write(
    `probing ${companies.length}${limit ? ` (of ${all.length})` : ''} US-hiring YC companies\n`
  );

  // Keys we already have registered — skip these entirely so the output is
  // only NEW companies to add.
  const existingKeys = new Set(
    COMPANIES.filter((c) => c.slug).map((c) => `${c.source}:${c.slug.toLowerCase()}`)
  );

  let done = 0;
  const results = await runWithConcurrency(companies, CONCURRENCY, async (c) => {
    const out = await probeOne(c, existingKeys);
    done++;
    if (done % 100 === 0) {
      process.stderr.write(`  ${done}/${companies.length}  (${Math.round((Date.now() - started) / 1000)}s)\n`);
    }
    return out;
  });

  const hits = results.filter((r) => r && !r.__error);
  // The YC feed contains duplicate entries for many companies (different batch
  // spellings — "W22" and "Winter 2022" exist as separate rows). Collapse
  // duplicates by (source, slug) before emitting.
  const seenKey = new Set();
  const byAts = { greenhouse: [], lever: [], ashby: [] };
  for (const h of hits) {
    const k = `${h.source}:${h.slug}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    byAts[h.source].push(h);
  }

  process.stderr.write(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s — greenhouse:${byAts.greenhouse.length} ` +
      `lever:${byAts.lever.length} ashby:${byAts.ashby.length}\n\n`
  );

  // Print config-ready blocks. User copies the lines they want into config.js.
  for (const source of ['greenhouse', 'lever', 'ashby']) {
    const list = byAts[source].sort((a, b) => a.displayName.localeCompare(b.displayName));
    console.log(`\n// ─── ${source} (${list.length} YC companies discovered) ───`);
    for (const h of list) {
      const name = h.displayName.replace(/'/g, "\\'");
      console.log(
        `  { source: '${source}', slug: '${h.slug}', displayName: '${name}' },` +
          ` // YC ${h.ycBatch || '?'}`
      );
    }
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
