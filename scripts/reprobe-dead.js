#!/usr/bin/env node
'use strict';

// Finds where companies whose configured board went dead (404) hire now.
// Input: the `collector.fail` lines from a collect log (one JSON object per
// line: { source, slug, error }). For each "Not found" / 422 entry it tries:
//   1. every ATS with a collector, under slug variants of the company name —
//      Greenhouse requires the board's registered name to match, since short
//      slugs collide (scripts/verify-yc-ats.js has the same rule);
//   2. the company's own careers page, on a few domain guesses, reading which
//      ATS it links to (shared with scripts/discover-sponsors.js);
//   3. a Workday tenant from the company name.
// Prints the dead entries and any replacement found for each. Review, then
// edit src/config.js.
//
//   gh run view <run-id> --log | grep collector.fail | sed 's/.*collector\.fail //' > fails.jsonl
//   node scripts/reprobe-dead.js fails.jsonl

const fs = require('fs');
const { COMPANIES } = require('../src/config');
const { runWithConcurrency } = require('../src/collectors/http');
const { probeWorkday, probeCareersPage } = require('./discover-sponsors');

const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';

async function getJson(url, opts = {}) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function slugVariants(name, oldSlug) {
  const words = String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const joined = words.join('');
  const base = [joined, words.join('-'), oldSlug];
  const out = [];
  for (const b of base) out.push(b, `${b}hq`, `${b}inc`, `join${b}`, `${b}-inc`, `${b}labs`, `${b}ai`, `${b}-ai`);
  return [...new Set(out.filter((s) => s && s.length >= 3))];
}

// Each returns a jobs count when the board exists and plausibly belongs to
// `name`, else 0.
const ATS = {
  greenhouse: async (slug, name) => {
    const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
    if (!meta || !norm(meta.name).includes(norm(name).slice(0, 6))) return 0;
    const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return d?.jobs?.length || 0;
  },
  lever: async (slug) => (await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=50`))?.length || 0,
  ashby: async (slug) => (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`))?.jobs?.length || 0,
  workable: async (slug, name) => {
    const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
    return d && norm(d.name).includes(norm(name).slice(0, 6)) ? d.jobs?.length || 0 : 0;
  },
  smartrecruiters: async (slug) => (await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`))?.totalFound || 0,
  gem: async (slug) => (await getJson(`https://api.gem.com/job_board/v0/${slug}/job_posts/`))?.length || 0,
};

async function findReplacement(entry) {
  const name = entry.displayName || entry.slug;
  for (const slug of slugVariants(name, entry.slug)) {
    for (const [kind, probe] of Object.entries(ATS)) {
      if (kind === entry.source && slug === entry.slug) continue; // the dead one
      // eslint-disable-next-line no-await-in-loop
      const n = await probe(slug, name);
      if (n > 0) return { how: 'ats-probe', line: `{ source: '${kind}', slug: '${slug}', displayName: '${name.replace(/'/g, "\\'")}' }`, jobs: n };
    }
  }
  const words = String(name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const stem = words.join('');
  const domains = [...new Set([`${stem}.com`, `${stem}.ai`, `${stem}.io`, `get${stem}.com`, `try${stem}.com`, `${entry.slug}.com`])];
  const page = await probeCareersPage(domains);
  if (page && !page.manual && page.m) {
    if (page.kind === 'workday') {
      const [, tenant, wd, site] = page.m;
      return { how: `careers page ${page.careersUrl}`, line: `{ source: 'workday', slug: '${tenant}-${site.toLowerCase()}', tenant: '${tenant}', wd: '${wd}', site: '${site}', displayName: '${name.replace(/'/g, "\\'")}' }` };
    }
    if (!(page.kind === entry.source && page.m[1] === entry.slug)) {
      return { how: `careers page ${page.careersUrl}`, line: `{ source: '${page.kind}', slug: '${page.m[1]}', displayName: '${name.replace(/'/g, "\\'")}' }` };
    }
  }
  if (page && page.manual) return { how: `careers page ${page.careersUrl}`, note: `${page.kind} — extension board` };
  const wd = await probeWorkday([stem]);
  if (wd && wd.sites.length) {
    const site = wd.sites[0].site;
    return { how: 'workday robots.txt', line: `{ source: 'workday', slug: '${wd.tenant}-${site.toLowerCase()}', tenant: '${wd.tenant}', wd: '${wd.wd}', site: '${site}', displayName: '${name.replace(/'/g, "\\'")}' }` };
  }
  return null;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node scripts/reprobe-dead.js fails.jsonl');
  const fails = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((f) => /Not found|HTTP 422/.test(f.error));
  const bySlug = new Map(COMPANIES.map((c) => [`${c.source}:${c.slug}`, c]));
  const entries = fails.map((f) => ({ ...bySlug.get(`${f.source}:${f.slug}`), source: f.source, slug: f.slug }));
  process.stderr.write(`re-probing ${entries.length} dead entries…\n`);
  const results = await runWithConcurrency(entries, 4, async (e) => ({ e, r: await findReplacement(e) }));
  for (const { e, r } of results) {
    const head = `${e.source}:${e.slug} (${e.displayName || ''})`;
    if (!r) console.log(`DEAD     ${head}`);
    else if (r.line) console.log(`MOVED    ${head} -> ${r.line}  // ${r.how}${r.jobs ? `, ${r.jobs} jobs` : ''}`);
    else console.log(`EXTERNAL ${head} -> ${r.note}  // ${r.how}`);
  }
}

main().catch((e) => {
  console.error('reprobe failed:', e.message);
  process.exit(1);
});
