#!/usr/bin/env node
'use strict';
// Workday employer discovery from Common Crawl. Every Workday employer's
// careers site lives at <tenant>.wd<N>.myworkdayjobs.com/<site>, and Common
// Crawl's URL index lists the ones the web links to (one month: ~1,800
// tenants). So the real tenant, shard and site come from the crawl instead of
// being guessed from a company name, as discover-sponsors.js does; a tenant
// that isn't the company name ("fmr", "cat") is still found.
//
// Each tenant not already in src/config.js is matched to the USCIS sponsor list
// (src/data/h1b-sponsors.json) through the same name-to-tenant guesses
// discover-sponsors.js uses. A match on the full name ("tmobile" ↔ T-Mobile
// USA) is printed as is; a match on the first word only ("american" ↔ American
// Airlines) is marked CHECK. Employers covered by another board, the Playwright
// scraper, or the mine-lists.js skip lists are left out.
//
//   node scripts/discover-workday.js                  # latest 3 crawls, ≥ 3 approvals
//   node scripts/discover-workday.js --crawls 6 --min 20
//   node scripts/discover-workday.js --verify         # one search per site, from this machine
//   node scripts/discover-workday.js --fresh          # ignore cached index pages
//
// --verify asks each new site for "software engineer" postings, one request a
// second, and stops at the first 429/403 (Workday rate-limits by address).
// Review the output before pasting entries into src/config.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { COMPANIES } = require('../src/config');
const { looksUS } = require('../src/services/normalize');
const { send, runWithConcurrency } = require('../src/collectors/http');
const SPONSORS = require('../src/data/h1b-sponsors.json');
const { candidatesFor, buildCovered, display, GENERIC, WD_SKIP_SITE } = require('./discover-sponsors');
const { SCRAPER, SKIP, SKIP_NAME } = require('./mine-lists');
const { stripSuffixes } = require('./ats-slugs');

// src/config.js also loads this script's own output (cadence 'wide'); compare
// against the hand-configured boards only, or a rerun would drop them all.
const CONFIGURED = COMPANIES.filter((c) => c.cadence !== 'wide');
const CC = 'https://index.commoncrawl.org';
const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';
const CACHE = path.join(os.tmpdir(), 'job-discover-workday');
const WD_URL = /^https?:\/\/([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([A-Za-z0-9_-]+)(?=[/?#]|$)/;
// Locale prefixes ("/es/...", "/fr-CA/...") and paths with no site in them.
const NOT_SITE = /^([a-z]{2}(-[a-z]{2})?|job|details|wday|robots|favicon|sitemap)$/i;
const NOT_RECRUITING = /nonrecruit|faculty|broadbean|confidential/i;

function parseWorkdayUrl(url) {
  const m = String(url || '').match(WD_URL);
  if (!m || NOT_SITE.test(m[3]) || NOT_RECRUITING.test(m[3])) return null;
  return { tenant: m[1], wd: m[2], site: m[3] };
}

// tenant → { tenant, wd, sites: [{ site, urls }] } with the most-linked site first.
function collectTenants(urls) {
  const byTenant = new Map();
  for (const url of urls) {
    const p = parseWorkdayUrl(url);
    if (!p || WD_SKIP_SITE.test(p.site)) continue;
    if (!byTenant.has(p.tenant)) byTenant.set(p.tenant, { tenant: p.tenant, wd: p.wd, sites: new Map() });
    const t = byTenant.get(p.tenant);
    // Site names are case-insensitive on Workday; keep the first spelling seen.
    const key = p.site.toLowerCase();
    const s = t.sites.get(key) || { site: p.site, urls: 0 };
    s.urls++;
    t.sites.set(key, s);
  }
  return [...byTenant.values()]
    .map((t) => ({ ...t, sites: [...t.sites.values()].sort((a, b) => b.urls - a.urls) }))
    .filter((t) => t.sites.length);
}

// tenant guess → the sponsor it most likely is. A guess equal to the whole name
// (suffixes stripped) beats a first-words prefix, then more approvals win.
function sponsorIndex(sponsors) {
  const idx = new Map();
  for (const [key, v] of Object.entries(sponsors)) {
    const approvals = v.approvals_last_2fy || 0;
    const { joined, tenants } = candidatesFor(key);
    for (const t of tenants) {
      const strong = t === joined && !GENERIC.has(t);
      const prev = idx.get(t);
      if (prev && (prev.strong > strong || (prev.strong === strong && prev.approvals >= approvals))) continue;
      idx.set(t, { key, approvals, strong });
    }
  }
  return idx;
}

// Sponsors that are out of scope are dropped before indexing, so a tenant a
// university would claim ("quintavo") can still match the airline of that name.
function eligible(key, approvals, minApprovals, covered) {
  if (approvals < minApprovals || covered(key)) return false;
  const core = stripSuffixes(key);
  return !(SKIP.has(key) || SKIP.has(core.join('-')) || SCRAPER.includes(core.join('')) || SCRAPER.includes(core[0]) || SKIP_NAME.test(key.replace(/-/g, ' ')));
}

function matchTenants(tenants, { sponsors = SPONSORS, companies = CONFIGURED, minApprovals = 3 } = {}) {
  const covered = buildCovered(companies);
  const idx = sponsorIndex(Object.fromEntries(Object.entries(sponsors).filter(([key, v]) => eligible(key, v.approvals_last_2fy || 0, minApprovals, covered))));
  const known = new Set(companies.filter((c) => c.source === 'workday').map((c) => c.tenant));
  const out = [];
  const rest = [];
  for (const t of tenants) {
    if (known.has(t.tenant)) continue;
    const s = idx.get(t.tenant);
    if (!s) { rest.push(t); continue; }
    out.push({ ...t, sponsor: s.key, approvals: s.approvals, strong: s.strong, displayName: display(stripSuffixes(s.key)) });
  }
  out.sort((a, b) => b.strong - a.strong || b.approvals - a.approvals);
  return { matched: out, unmatched: rest.length, rest };
}

// ─── Common Crawl ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) });
      if (res.ok) return await res.text();
      if (i >= tries || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i >= tries) throw new Error(`${err.message} for ${url}`);
    }
    await sleep(5_000 * i);
  }
}

async function crawlUrls(crawlId, { fresh, cached }) {
  const api = `${CC}/${crawlId}-index?url=*.myworkdayjobs.com&output=json&fl=url`;
  const pages = cached
    ? fs.readdirSync(CACHE).filter((f) => f.startsWith(`${crawlId}-`)).reduce((n, f) => Math.max(n, Number(f.split('-').pop().split('.')[0]) + 1), 0)
    : JSON.parse(await getText(`${api}&showNumPages=true`)).pages;
  const urls = [];
  let failed = 0;
  for (let p = 0; p < pages; p++) {
    const file = path.join(CACHE, `${crawlId}-${p}.jsonl`);
    let text;
    if (!fresh && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    else if (cached) { failed++; continue; } else {
      try {
        text = await getText(`${api}&page=${p}`);
        fs.writeFileSync(file, text);
      } catch (err) {
        failed++;
        process.stderr.write(`  ${crawlId} page ${p}: ${err.message}\n`);
        continue;
      }
      await sleep(1_000);
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { urls.push(JSON.parse(line).url); } catch { /* truncated line */ }
    }
  }
  return { urls, pages, failed };
}

// ─── Verify ──────────────────────────────────────────────────────────────────

async function call(url, body) {
  const res = await send(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  // A 403 in JSON is one tenant's own refusal ("permission denied" for a
  // private site); a 429, or a 403/503 web page, is Workday refusing this machine.
  const json = /json/i.test(res.headers.get('content-type') || '');
  if (res.status === 429 || ([403, 503].includes(res.status) && !json)) return { blocked: res.status };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  try {
    return { data: await res.json() };
  } catch {
    return { error: 'non-JSON answer' };
  }
}

// One "software engineer" search, then the first hit's detail, whose
// hiringOrganization names the employer ("fmr" → Fidelity Investments …).
async function inspect({ tenant, wd, site }) {
  const base = `https://${tenant}.wd${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
  const list = await call(`${base}/jobs`, { appliedFacets: {}, limit: 20, offset: 0, searchText: 'software engineer' });
  if (!list.data) return list;
  const posts = Array.isArray(list.data.jobPostings) ? list.data.jobPostings : [];
  const out = { total: list.data.total || 0, us: posts.filter((j) => looksUS(j.locationsText || '')).length, name: '' };
  if (posts[0]) {
    await sleep(500);
    const detail = await call(`${base}${posts[0].externalPath}`);
    if (detail.blocked) return detail;
    out.name = String(detail.data?.hiringOrganization?.name || '').trim();
  }
  return out;
}

// The employer's legal name, cleaned the way USCIS keys are, as a display name:
// "Fidelity Investments Institutional Operations Company LLC" → "Fidelity
// Investments Institutional Operations".
function nameFrom(legal) {
  const key = String(legal || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s-]/g, ' ').trim().split(/[\s-]+/).filter(Boolean).join('-');
  return key ? display(stripSuffixes(key)) : '';
}

// Which checked employers go into the data file: live software hits, and not
// ruled out the way mine-lists.js rules employers out (universities,
// hospitals, government, law firms, clearance-bound) or already covered by a
// board on another platform (Qualcomm's PCSX site, say), which would show
// every opening twice.
function keepDiscovered(row, covered = buildCovered(CONFIGURED)) {
  if (!(row.softwareHits > 0)) return false;
  const name = row.legalName || row.displayName || '';
  const key = String(name).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s-]/g, ' ').trim().split(/[\s-]+/).filter(Boolean).join('-');
  const core = stripSuffixes(key);
  if (SKIP_NAME.test(name) || SKIP.has(key) || SKIP.has(core.join('-')) || SCRAPER.includes(core[0])) return false;
  return !covered(key);
}

async function verifyAll(list, concurrency) {
  let blocked = null;
  let done = 0;
  await runWithConcurrency(list, concurrency, async (t) => {
    if (blocked) return;
    try {
      t.check = await inspect({ tenant: t.tenant, wd: t.wd, site: t.sites[0].site });
    } catch (err) {
      t.check = { error: err.message.slice(0, 60) };
    }
    if (t.check.blocked && !blocked) blocked = `${t.tenant}: ${t.check.blocked}`;
    if (++done % 100 === 0) process.stderr.write(`  verified ${done}/${list.length}\n`);
    await sleep(1_000);
  });
  return blocked;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : def;
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function argStr(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

async function main() {
  const crawls = arg('--crawls', 3);
  const minApprovals = arg('--min', 3);
  const fresh = process.argv.includes('--fresh');
  const cached = process.argv.includes('--cached');
  const all = process.argv.includes('--all');
  const writeTo = argStr('--write');
  fs.mkdirSync(CACHE, { recursive: true });

  const ids = JSON.parse(await getText(`${CC}/collinfo.json`)).slice(0, crawls).map((c) => c.id);
  const urls = [];
  for (const id of ids) {
    const r = await crawlUrls(id, { fresh, cached });
    process.stderr.write(`${id}: ${r.urls.length} Workday URLs from ${r.pages - r.failed}/${r.pages} index pages\n`);
    urls.push(...r.urls);
  }

  const tenants = collectTenants(urls);
  const { matched, unmatched, rest } = matchTenants(tenants, { minApprovals });
  const known = tenants.filter((t) => CONFIGURED.some((c) => c.source === 'workday' && c.tenant === t.tenant)).length;
  console.log(`# ${tenants.length} Workday employers in ${ids.join(', ')}: ${known} already configured, ${matched.length} new H-1B sponsors (${minApprovals}+ approvals), ${unmatched} not matched to an eligible sponsor`);

  const targets = all ? [...matched, ...rest] : matched;
  if (process.argv.includes('--verify') || writeTo) {
    const blocked = await verifyAll(targets, arg('--concurrency', 3));
    if (blocked) console.log(`# Verify stopped early, Workday blocked this machine (${blocked})`);
  }

  if (writeTo) {
    const rows = targets
      .filter((t) => t.check && !t.check.blocked && !t.check.error)
      .map((t) => ({
        tenant: t.tenant,
        wd: t.wd,
        site: t.sites[0].site,
        displayName: nameFrom(t.check.name) || t.displayName || t.tenant,
        legalName: t.check.name || undefined,
        sponsor: t.sponsor,
        approvals: t.approvals,
        softwareHits: t.check.total,
        usOnFirstPage: t.check.us,
      }))
      .filter((r) => keepDiscovered(r))
      .sort((a, b) => a.tenant.localeCompare(b.tenant));
    const checked = targets.filter((t) => t.check).length;
    fs.writeFileSync(writeTo, `${JSON.stringify({ generatedAt: new Date().toISOString(), crawls: ids, companies: rows }, null, 1)}\n`);
    console.log(`# Wrote ${rows.length} live Workday employers (${rows.filter((r) => r.softwareHits > 0).length} with software hits) of ${checked} checked to ${writeTo}`);
    return;
  }

  for (const strong of [true, false]) {
    const group = matched.filter((m) => m.strong === strong);
    if (!group.length) continue;
    console.log(strong ? '\n# Config entries (tenant is the sponsor\'s name)' : '\n# CHECK: tenant matches only the first word(s) of the sponsor\'s name');
    for (const m of group) {
      const site = m.sites[0].site;
      const fields = `source: 'workday', slug: '${m.tenant}-${site.toLowerCase()}', tenant: '${m.tenant}', wd: '${m.wd}', site: '${q(site)}', displayName: '${q(m.displayName)}'`;
      const others = m.sites.slice(1, 4).map((s) => s.site);
      const c = m.check;
      const checked = !c ? '' : c.blocked ? '' : c.error ? `, ${c.error}` : `, ${c.total} "software engineer" postings (${c.us}/20 US)`;
      console.log(`  { ${fields} },  // ${m.approvals} approvals (${m.sponsor}), ${m.sites[0].urls} crawled URLs${checked}${others.length ? `; other sites: ${others.join(', ')}` : ''}`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('discover-workday failed:', err);
    process.exit(1);
  });
}

module.exports = { parseWorkdayUrl, collectTenants, sponsorIndex, matchTenants, inspect, nameFrom, keepDiscovered };
