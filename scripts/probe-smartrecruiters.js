#!/usr/bin/env node
'use strict';

// One-shot discovery tool for employers hosted on SmartRecruiters.
//
// Driven by src/data/h1b-sponsors.json rather than a hand-written list, so it
// probes in descending order of *actual USCIS H-1B approvals*. That ordering is
// the point: it finds the employers that both sponsor heavily and are reachable
// through a public API, which is exactly the gap this board has.
//
// SmartRecruiters has no company-search endpoint (`/v1/companies?q=` 404s), so
// discovery means guessing the company identifier. Two things make that
// tractable: the identifier is case-insensitive ('BOSCHGROUP' == 'BoschGroup'),
// and the USCIS petitioner names are close to it once the corporate suffixes
// come off. Each candidate costs one request and a miss prints nothing.
//
// Output: config-ready `{ source: 'smartrecruiters', ... }` lines, ordered by
// US posting count.
//
//   node scripts/probe-smartrecruiters.js
//   node scripts/probe-smartrecruiters.js 800          # probe more sponsors
//   node scripts/probe-smartrecruiters.js > scripts/smartrecruiters-discovered.txt

const { runWithConcurrency } = require('../src/collectors/http');
const { COMPANIES } = require('../src/config');
const SPONSORS = require('../src/data/h1b-sponsors.json');

const CONCURRENCY = 8;
const REQ_TIMEOUT_MS = 12_000;
const DEFAULT_TOP_N = 400;
const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';

// Corporate and staffing-agency suffixes that appear in USCIS petitioner names
// but never in an ATS slug. Order matters — longest first, so
// 'technology-solutions-us' is stripped before 'us'.
const SUFFIXES = [
  'technology-solutions-us', 'technology-solutions', 'consultancy-svcs',
  'global-services', 'business-services', 'services-inc', 'americas', 'america',
  'us-llp', 'usa-inc', 'usa', 'llp', 'llc', 'inc', 'ltd', 'limited', 'corp',
  'corporation', 'company', 'co', 'plc', 'lp', 'pc', 'group', 'holdings',
  'technologies', 'technology', 'tech', 'systems', 'solutions', 'software',
  'labs', 'associates', 'partners', 'consulting', 'international', 'us',
];

function stripSuffixes(key) {
  let parts = key.split('-').filter(Boolean);
  let changed = true;
  while (changed && parts.length > 1) {
    changed = false;
    for (const suf of SUFFIXES) {
      const sufParts = suf.split('-');
      if (sufParts.length >= parts.length) continue;
      const tail = parts.slice(-sufParts.length).join('-');
      if (tail === suf) {
        parts = parts.slice(0, -sufParts.length);
        changed = true;
        break;
      }
    }
  }
  return parts;
}

// Slug candidates for one normalized USCIS petitioner key, most-likely first.
// Deduped, so a single-word company only costs one request.
function slugCandidates(key) {
  const core = stripSuffixes(key);
  const joined = core.join('');
  const hyphen = core.join('-');
  const out = [joined, hyphen, key.replace(/-/g, ''), key];
  if (core.length > 1) out.push(core[0]);            // 'bosch' from 'bosch-group'
  if (core.length >= 1) out.push(`${joined}group`);  // 'boschgroup' from 'bosch'
  return [...new Set(out.filter((s) => s && s.length >= 3))];
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

// A slug is a hit only if it has US postings — a board that exists but is
// entirely non-US contributes nothing to this project.
async function probeSlug(slug) {
  const res = await withTimeout(
    fetch(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings` +
        `?country=us&limit=1`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    ),
    REQ_TIMEOUT_MS,
    slug
  );
  if (!res.ok) return null;

  const data = await res.json();
  const usCount = data?.totalFound || 0;
  if (!usCount) return null;

  const name = data?.content?.[0]?.company?.name || slug;
  return { slug, usCount, name };
}

async function main() {
  const topN = Number(process.argv[2]) || DEFAULT_TOP_N;

  const knownSr = new Set(
    COMPANIES.filter((c) => c.source === 'smartrecruiters').map((c) => c.slug.toLowerCase())
  );
  // Companies we already reach some other way. Not skipped — a SmartRecruiters
  // board may carry roles their Workday tenant doesn't — but flagged, so the
  // output can be triaged by hand.
  const covered = new Set(COMPANIES.map((c) => (c.slug || '').toLowerCase()).filter(Boolean));

  const sponsors = Object.entries(SPONSORS)
    .map(([key, v]) => ({ key, approvals: v.approvals_last_2fy || 0 }))
    .sort((a, b) => b.approvals - a.approvals)
    .slice(0, topN);

  process.stderr.write(
    `probing top ${sponsors.length} USCIS sponsors for SmartRecruiters boards…\n`
  );
  const started = Date.now();

  const results = await runWithConcurrency(sponsors, CONCURRENCY, async (s) => {
    for (const cand of slugCandidates(s.key)) {
      if (knownSr.has(cand.toLowerCase())) return null; // already configured
      try {
        const hit = await probeSlug(cand);
        if (hit) return { ...hit, sponsorKey: s.key, approvals: s.approvals };
      } catch {
        /* a miss is the common case; keep trying variants */
      }
    }
    return null;
  });

  const hits = [];
  const seen = new Set();
  for (const r of results) {
    if (!r || r.__error || seen.has(r.slug.toLowerCase())) continue;
    seen.add(r.slug.toLowerCase());
    hits.push(r);
    process.stderr.write(
      `  ✓ ${r.slug} — "${r.name}" — ${r.usCount} US postings, ` +
        `${r.approvals} H-1B approvals${covered.has(r.slug.toLowerCase()) ? ' (slug already in config)' : ''}\n`
    );
  }

  process.stderr.write(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s — ${hits.length} board(s) found\n\n`
  );
  if (!hits.length) return;

  hits.sort((a, b) => b.usCount - a.usCount);

  console.log(
    `  // ─── SmartRecruiters (discovered by scripts/probe-smartrecruiters.js, verified ${new Date()
      .toISOString()
      .slice(0, 10)}) ───`
  );
  for (const h of hits) {
    const name = h.name.replace(/'/g, "\\'");
    console.log(
      `  { source: 'smartrecruiters', slug: '${h.slug}', displayName: '${name}' },` +
        ` // ${h.usCount} US postings, ${h.approvals} H-1B approvals`
    );
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
