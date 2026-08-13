#!/usr/bin/env node
'use strict';

// One-shot discovery tool for employers hosted on Rippling's ATS.
//
// Same approach as scripts/probe-smartrecruiters.js: walk
// src/data/h1b-sponsors.json in descending USCIS-approval order and probe slug
// variants, so the search is ordered by how much each employer actually
// sponsors. Rippling board slugs are lowercase and have no search endpoint.
//
// Also re-probes companies already configured on ANOTHER ATS. That's deliberate
// and is how this collector was motivated: Opendoor's `greenhouse/opendoor`
// entry now 404s because they migrated to Rippling, and the config entry had
// been silently contributing nothing. A hit flagged "(configured on <source>)"
// is a migration to check, not a duplicate to discard.
//
//   node scripts/probe-rippling.js
//   node scripts/probe-rippling.js 800
//   node scripts/probe-rippling.js > scripts/rippling-discovered.txt

const { runWithConcurrency } = require('../src/collectors/http');
const { COMPANIES } = require('../src/config');
const SPONSORS = require('../src/data/h1b-sponsors.json');

const CONCURRENCY = 8;
const REQ_TIMEOUT_MS = 12_000;
const DEFAULT_TOP_N = 400;
const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';

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
      if (parts.slice(-sufParts.length).join('-') === suf) {
        parts = parts.slice(0, -sufParts.length);
        changed = true;
        break;
      }
    }
  }
  return parts;
}

function slugCandidates(key) {
  const core = stripSuffixes(key);
  const out = [core.join(''), core.join('-'), key.replace(/-/g, ''), key];
  if (core.length > 1) out.push(core[0]);
  return [...new Set(out.filter((s) => s && s.length >= 3))];
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

// Resolving the board is not enough to identify the employer, and this is the
// probe's main hazard. Short generic slugs collide constantly: probing the top
// 3,000 sponsors returned `wsp` (the engineering firm, 194 approvals) as
// "Waldorf School of the Peninsula", `ace` (108 approvals) as "American College
// of Education", `sas` (68) as "Strategic Association Solutions", `paramount`
// (68) as a debt-recovery company and `archer` (134) as "Archer Review". Eight
// of eleven hits checked by hand were the wrong company.
//
// Accepting those would attribute an unrelated employer's postings to a big
// sponsor's approval count — wrong jobs on the board AND a wrong YES. So one
// detail fetch resolves companyName, and the caller prints it for comparison.
// Always eyeball the name before merging a line.
async function probeSlug(slug) {
  const res = await withTimeout(
    fetch(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    }),
    REQ_TIMEOUT_MS,
    slug
  );
  if (!res.ok) return null;

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  let companyName = '';
  try {
    const detailRes = await withTimeout(
      fetch(
        `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs/${
          data[0].uuid
        }`,
        { headers: { 'User-Agent': UA, Accept: 'application/json' } }
      ),
      REQ_TIMEOUT_MS,
      `${slug}/detail`
    );
    if (detailRes.ok) companyName = (await detailRes.json())?.companyName || '';
  } catch {
    /* identity is advisory — still report the board */
  }

  return { slug, count: data.length, companyName };
}

// Rough agreement check between the USCIS petitioner name and the name the
// board reports. Only used to mark a line for review, never to filter.
function namesLookRelated(sponsorKey, companyName) {
  if (!companyName) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(sponsorKey);
  const b = norm(companyName);
  if (!a || !b) return false;
  return a.startsWith(b.slice(0, 6)) || b.startsWith(a.slice(0, 6));
}

async function main() {
  const topN = Number(process.argv[2]) || DEFAULT_TOP_N;

  const knownRippling = new Set(
    COMPANIES.filter((c) => c.source === 'rippling').map((c) => String(c.slug).toLowerCase())
  );
  // slug -> the source it's already configured under, so migrations stand out.
  const configuredElsewhere = new Map(
    COMPANIES.filter((c) => c.slug).map((c) => [String(c.slug).toLowerCase(), c.source])
  );

  const sponsors = Object.entries(SPONSORS)
    .map(([key, v]) => ({ key, approvals: v.approvals_last_2fy || 0 }))
    .sort((a, b) => b.approvals - a.approvals)
    .slice(0, topN);

  process.stderr.write(`probing top ${sponsors.length} USCIS sponsors for Rippling boards…\n`);
  const started = Date.now();

  const results = await runWithConcurrency(sponsors, CONCURRENCY, async (s) => {
    for (const cand of slugCandidates(s.key)) {
      if (knownRippling.has(cand.toLowerCase())) return null;
      try {
        const hit = await probeSlug(cand);
        if (hit) return { ...hit, sponsorKey: s.key, approvals: s.approvals };
      } catch {
        /* misses are the common case */
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
    const other = configuredElsewhere.get(r.slug.toLowerCase());
    r.suspect = !namesLookRelated(r.sponsorKey, r.companyName);
    process.stderr.write(
      `  ${r.suspect ? '?' : '✓'} ${r.slug} — "${r.companyName || 'unknown'}" — ` +
        `${r.count} postings, ${r.approvals} H-1B approvals (USCIS: ${r.sponsorKey})` +
        `${other ? ` [configured on ${other} — possible migration]` : ''}` +
        `${r.suspect ? '  <-- NAME MISMATCH, verify before adding' : ''}\n`
    );
  }

  process.stderr.write(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s — ${hits.length} board(s) found\n\n`
  );
  if (!hits.length) return;

  hits.sort((a, b) => b.count - a.count);

  console.log(
    `  // ─── Rippling (discovered by scripts/probe-rippling.js, verified ${new Date()
      .toISOString()
      .slice(0, 10)}) ───`
  );
  for (const h of hits) {
    const name = (h.companyName || h.slug).replace(/'/g, "\\'");
    const line =
      `  { source: 'rippling', slug: '${h.slug}', displayName: '${name}' },` +
      ` // ${h.count} postings, ${h.approvals} H-1B approvals`;
    // Commented out rather than omitted: a mismatch is usually a collision, but
    // occasionally it's a legitimate rename or subsidiary, so it stays visible.
    console.log(h.suspect ? `  // MISMATCH (USCIS "${h.sponsorKey}") — verify:\n  //${line}` : line);
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
