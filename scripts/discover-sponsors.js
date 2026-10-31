#!/usr/bin/env node
'use strict';

// Sponsor-first discovery. Walks the USCIS H-1B sponsor list (highest approval
// counts first), skips employers the board already collects, and for each of
// the rest works out where they actually post jobs:
//
//   1. Workday probe. Most large sponsors hire through Workday, and a real
//      tenant's robots.txt lists every career site it has
//      ("Sitemap: https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/siteMap.xml"),
//      while a wrong tenant/shard guess answers with an error. So a company
//      name is enough to find tenant + shard + site, which is everything
//      src/collectors/workday.js needs. Each candidate site is then confirmed
//      with one CxS list call that must return US postings.
//
//   2. Careers-page detection. Guess the employer's domain, fetch its careers
//      page once (only where its robots.txt allows), and read which ATS it
//      links to or redirects to.
//
// Output (stdout): config-ready entries for ATSes with a collector, then a list
// of careers URLs on ATSes we can't collect server-side (iCIMS, Taleo,
// SuccessFactors, Avature, Phenom, bot-walled sites) — paste those into the
// browser extension's "My boards". Progress goes to stderr.
//
//   node scripts/discover-sponsors.js                  # sponsors with ≥ 50 approvals
//   node scripts/discover-sponsors.js 20               # ≥ 20 approvals (~3.7k employers, slow)
//   node scripts/discover-sponsors.js 20 50            # one tier: 20-49 approvals
//   node scripts/discover-sponsors.js 50 > scripts/sponsors-discovered.txt
//
// Review before merging. Tenant guesses can collide (a "visa" tenant need not
// be Visa); entries whose match is weaker are marked "CHECK".

const { runWithConcurrency } = require('../src/collectors/http');
const { COMPANIES } = require('../src/config');
const { looksUS } = require('../src/services/normalize');
const SPONSORS = require('../src/data/h1b-sponsors.json');
const { stripSuffixes } = require('./ats-slugs');

const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';
const TIMEOUT_MS = 9_000;
const MAX_HTML = 2_000_000;
const WD_SHARDS = ['1', '3', '5', '12', '10', '2', '103', '108'];
// Workday rate-limits by IP across tenants; 6 keeps a long run under it.
const CONCURRENCY = 6;

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function get(url, { accept = '*/*', method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': UA, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = (await res.text()).slice(0, MAX_HTML);
    return { status: res.status, url: res.url, text, type: res.headers.get('content-type') || '' };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ─── Coverage ────────────────────────────────────────────────────────────────

// Same normalization as the USCIS keys (classifier.js normSlug).
const STOP = new Set(['the', 'and', 'or', 'of', 'for', 'in', 'to', 'a', 'an', 'at']);
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|pbc|gmbh|plc|bv|ag)\b\.?/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .join('-');
}

// A sponsor counts as covered when a configured employer's name is a token
// prefix of it: "capital-one" covers "capital-one-services". Short or generic
// first words are not allowed to cover anything on their own.
const GENERIC = new Set(['american', 'united', 'national', 'global', 'general', 'first', 'new', 'international', 'data', 'tech', 'technology', 'digital', 'systems', 'solutions', 'services', 'health', 'university', 'bank']);
function buildCovered() {
  const keys = new Set();
  for (const c of COMPANIES) {
    for (const n of [c.displayName, c.slug, c.company, c.tenant]) {
      const k = norm(n);
      if (k && k.length >= 4 && !GENERIC.has(k)) keys.add(k);
    }
  }
  return (sponsorKey) => {
    const parts = sponsorKey.split('-');
    for (let i = parts.length; i >= 1; i--) {
      if (keys.has(parts.slice(0, i).join('-'))) return true;
    }
    return keys.has(parts.join(''));
  };
}

// ─── Workday ─────────────────────────────────────────────────────────────────

// Sites that never hold public external roles worth collecting.
const WD_SKIP_SITE = /intern(?:al|ship)?s?\b|internal|talent ?community|talentcommunity|recruitads|alumni|contingent|employee|referral|research(?!.*career)|ads$|_ads|agency|vendor/i;

function parseWorkdaySites(robots, tenant, wd) {
  const sites = [];
  const disallowed = new Set(
    [...robots.matchAll(/^Disallow:\s*\/([^/\s]+)\//gim)].map((m) => m[1].toLowerCase())
  );
  const re = new RegExp(`https://${tenant}\\.wd${wd}\\.myworkdayjobs\\.com/(?:[a-z]{2}-[A-Z]{2}/)?([^/\\s]+)/siteMap\\.xml`, 'gi');
  for (const m of robots.matchAll(re)) {
    const site = m[1];
    if (disallowed.has(site.toLowerCase()) || WD_SKIP_SITE.test(site)) continue;
    if (!sites.includes(site)) sites.push(site);
  }
  return sites;
}

async function workdaySiteStats(tenant, wd, site) {
  const r = await get(`https://${tenant}.wd${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`, {
    method: 'POST',
    accept: 'application/json',
    body: { appliedFacets: {}, limit: 20, offset: 0, searchText: '' },
  });
  if (!r || r.status !== 200) return null;
  try {
    const d = JSON.parse(r.text);
    const posts = Array.isArray(d.jobPostings) ? d.jobPostings : [];
    return { total: d.total || 0, usOnPage: posts.filter((p) => looksUS(p.locationsText || '')).length };
  } catch {
    return null;
  }
}

async function probeWorkday(tenants) {
  for (const tenant of tenants) {
    for (const wd of WD_SHARDS) {
      // eslint-disable-next-line no-await-in-loop
      const r = await get(`https://${tenant}.wd${wd}.myworkdayjobs.com/robots.txt`, { accept: 'text/plain' });
      if (!r || r.status !== 200 || !/^Sitemap:/im.test(r.text)) continue;
      const sites = parseWorkdaySites(r.text, tenant, wd).slice(0, 4);
      const kept = [];
      for (const site of sites) {
        // eslint-disable-next-line no-await-in-loop
        const s = await workdaySiteStats(tenant, wd, site);
        if (s && s.total > 0 && s.usOnPage > 0) kept.push({ site, ...s });
      }
      // The tenant exists on this shard; no other shard will have it.
      return kept.length ? { tenant, wd, sites: kept } : { tenant, wd, sites: [] };
    }
  }
  return null;
}

// ─── Careers-page detection ──────────────────────────────────────────────────

// Order matters: the first platform found in the final URL wins, then in HTML.
const ATS = [
  { kind: 'workday', re: /https?:\/\/([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/ },
  { kind: 'greenhouse', re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i },
  { kind: 'greenhouse', re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i },
  { kind: 'lever', re: /jobs\.lever\.co\/([a-z0-9_.-]+)/i },
  { kind: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i },
  { kind: 'smartrecruiters', re: /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/ },
  { kind: 'workable', re: /apply\.workable\.com\/([a-z0-9_-]+)/i },
  { kind: 'recruitee', re: /([a-z0-9-]+)\.recruitee\.com/i },
  { kind: 'gem', re: /jobs\.gem\.com\/([a-z0-9_-]+)/i },
  { kind: 'rippling', re: /ats\.rippling\.com\/([a-z0-9_-]+)/i },
  { kind: 'bamboohr', re: /([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/i },
  // No server-side collector — extension list.
  { kind: 'eightfold', re: /([a-z0-9-]+)\.eightfold\.ai/i, manual: true },
  { kind: 'oracle_hcm', re: /([a-z0-9-]+\.fa\.[a-z0-9]+\.oraclecloud\.com)/i, manual: true },
  { kind: 'icims', re: /([a-z0-9-]+)\.icims\.com/i, manual: true },
  { kind: 'taleo', re: /([a-z0-9-]+)\.taleo\.net/i, manual: true },
  { kind: 'successfactors', re: /(career\d*\.successfactors\.(?:com|eu)|[a-z0-9-]+\.jobs2web\.com)/i, manual: true },
  { kind: 'avature', re: /([a-z0-9-]+)\.avature\.net/i, manual: true },
  { kind: 'phenom', re: /(cdn\.phenompeople\.com|phenom(?:people)?\.com\/)/i, manual: true },
  { kind: 'jobvite', re: /jobs\.jobvite\.com\/([a-z0-9_-]+)/i, manual: true },
];
const IGNORE_SLUG = new Set(['embed', 'v1', 'js', 'api', 'static', 'assets', 'job_board', 'jobs', 'careers', 'www']);

// Minimal robots.txt check for one path, User-agent: * group only.
async function robotsAllows(origin, path) {
  const r = await get(`${origin}/robots.txt`, { accept: 'text/plain' });
  if (!r || r.status !== 200) return true;
  let inStar = false;
  const dis = [];
  for (const raw of r.text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, k, v] = m;
    if (/^user-agent$/i.test(k)) inStar = v.trim() === '*';
    else if (inStar && /^disallow$/i.test(k) && v.trim()) dis.push(v.trim());
  }
  return !dis.some((d) => d === '/' || path.startsWith(d));
}

function detectAts(finalUrl, html) {
  for (const hay of [finalUrl, html]) {
    for (const a of ATS) {
      const m = String(hay || '').match(a.re);
      if (!m) continue;
      if (a.kind !== 'workday' && m[1] && IGNORE_SLUG.has(m[1].toLowerCase())) continue;
      return { kind: a.kind, manual: !!a.manual, m };
    }
  }
  return null;
}

async function probeCareersPage(domains) {
  for (const d of domains) {
    for (const url of [`https://www.${d}/careers`, `https://careers.${d}/`, `https://jobs.${d}/`, `https://www.${d}/jobs`]) {
      const u = new URL(url);
      // eslint-disable-next-line no-await-in-loop
      if (!(await robotsAllows(u.origin, u.pathname))) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await get(url, { accept: 'text/html' });
      if (!r || r.status >= 400) continue;
      const hit = detectAts(r.url, r.text);
      if (hit) return { ...hit, careersUrl: r.url };
      // A careers page that exists but names no known ATS — still worth
      // listing for the extension if it's clearly a jobs page.
      if (/<title>[^<]*(career|job)/i.test(r.text)) return { kind: 'unknown', manual: true, careersUrl: r.url };
    }
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function candidatesFor(key) {
  const core = stripSuffixes(key);
  const joined = core.join('');
  // USCIS names carry trailing words the brand doesn't ("capital-one-services",
  // "bloomberg-lp"), so try token prefixes longest-first: capitaloneservices,
  // capitalone, then the first word alone if it's distinctive enough.
  const prefixes = [];
  for (let i = core.length; i >= 1; i--) {
    const p = core.slice(0, i).join('');
    if (i === 1 && core.length > 1 && core[0].length < 5) continue;
    if (p.length >= 3) prefixes.push(p);
  }
  const uniq = [...new Set(prefixes)].slice(0, 3);
  return { core, joined, tenants: uniq, domains: uniq.map((p) => `${p}.com`) };
}

function display(core) {
  return core.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

async function main() {
  const minApprovals = Number(process.argv[2]) || 50;
  // Optional upper bound, to probe one tier at a time: `… 20 50` = 20-49.
  const maxApprovals = Number(process.argv[3]) || Infinity;
  const isCovered = buildCovered();
  const knownTenants = new Set(COMPANIES.filter((c) => c.source === 'workday').map((c) => c.tenant));

  const gap = Object.entries(SPONSORS)
    .map(([key, v]) => ({ key, approvals: v.approvals_last_2fy || 0 }))
    .filter((s) => s.approvals >= minApprovals && s.approvals < maxApprovals && !isCovered(s.key))
    .sort((a, b) => b.approvals - a.approvals);

  process.stderr.write(`${gap.length} uncovered sponsors with ≥ ${minApprovals} approvals — probing…\n`);
  const started = Date.now();
  let done = 0;

  const results = await runWithConcurrency(gap, CONCURRENCY, async (s) => {
    const c = candidatesFor(s.key);
    const out = { ...s, ...c, name: display(c.core) };
    const wd = await probeWorkday(c.tenants.filter((t) => !knownTenants.has(t)));
    if (wd && wd.sites.length) out.workday = wd;
    else out.page = await probeCareersPage(c.domains);
    done++;
    if (done % 50 === 0) process.stderr.write(`  ${done}/${gap.length} (${Math.round((Date.now() - started) / 1000)}s)\n`);
    return out;
  });

  const auto = [];
  const manual = [];
  for (const r of results) {
    if (!r || r.__error) continue;
    const tag = `${r.approvals} H-1B approvals (${r.key})`;
    if (r.workday) {
      const strong = r.workday.tenant === r.joined;
      for (const s of r.workday.sites.slice(0, 3)) {
        auto.push({
          line: `  { source: 'workday', slug: '${r.workday.tenant}-${s.site.toLowerCase()}', tenant: '${r.workday.tenant}', wd: '${r.workday.wd}', site: '${s.site}', displayName: '${r.name.replace(/'/g, "\\'")}' },`,
          note: `${s.total} postings, ${tag}${strong ? '' : ' — CHECK tenant match'}`,
          approvals: r.approvals,
        });
      }
      continue;
    }
    const p = r.page;
    if (!p) continue;
    if (p.manual) {
      manual.push({ url: p.careersUrl, note: `${r.name} — ${p.kind}, ${tag}`, approvals: r.approvals });
      continue;
    }
    if (p.kind === 'workday') {
      const [, tenant, wd, site] = p.m;
      auto.push({
        line: `  { source: 'workday', slug: '${tenant}-${site.toLowerCase()}', tenant: '${tenant}', wd: '${wd}', site: '${site}', displayName: '${r.name.replace(/'/g, "\\'")}' },`,
        note: `linked from ${p.careersUrl}, ${tag}`,
        approvals: r.approvals,
      });
    } else {
      auto.push({
        line: `  { source: '${p.kind}', slug: '${p.m[1]}', displayName: '${r.name.replace(/'/g, "\\'")}' },`,
        note: `linked from ${p.careersUrl}, ${tag}`,
        approvals: r.approvals,
      });
    }
  }

  process.stderr.write(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s — ${auto.length} collector entries, ${manual.length} extension boards\n`
  );

  console.log(`  // ─── Sponsor discovery (scripts/discover-sponsors.js, ${new Date().toISOString().slice(0, 10)}) ───`);
  for (const a of auto.sort((x, y) => y.approvals - x.approvals)) console.log(`${a.line} // ${a.note}`);
  console.log('\n# Extension "My boards" — sponsors on ATSes without a server-side collector');
  for (const m of manual.sort((x, y) => y.approvals - x.approvals)) console.log(`${m.url}  # ${m.note}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('discover failed:', e);
    process.exit(1);
  });
}

module.exports = { parseWorkdaySites, detectAts, candidatesFor, buildCovered };
