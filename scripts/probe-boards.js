#!/usr/bin/env node
'use strict';

// Greenhouse / Lever / Ashby discovery by employer name. The other probes
// leave these three out for established employers: discover-sponsors.js reads
// only Workday robots.txt and careers pages, probe-ats.js covers the smaller
// ATSes, and probe-yc-ats.js / probe-topstartups.js start from startup lists.
// So a mid-size H-1B sponsor on Greenhouse was found only if its careers page
// happened to link the board.
//
// Candidates come from either
//   sponsors [min] [max]  USCIS sponsors with min..max-1 approvals that the
//                         board doesn't already cover (discover-sponsors.js's
//                         coverage rule), highest first;
//   names <file>          one employer per line — "Name", "Name | domain" or
//                         "Name | domain | slug1,slug2" — for well-known
//                         companies whatever their USCIS key. Workday is
//                         probed too in this mode (discover-sponsors.js already
//                         swept the sponsor list for it).
//
// A board counts only if it is that employer's, because slug collisions are
// the norm (Greenhouse `xai` is "SpaceXSI"):
//   greenhouse  the board's registered name names the company, or its apply
//               links sit on the company's domain
//   ashby       the organization's name or website names the company
//   lever       the hosted page title names the company
// and it lists at least one US software posting by the pipeline's own
// classifyRole + inUS. Each surviving board is then fetched once through its
// collector and normalized, so every line carries the rows a collect would
// keep today. Weigh Workday lines by that number before adding one: a tenant
// costs dozens of requests per collect run, a Greenhouse/Ashby/Lever board one.
//
// displayName is chosen so the USCIS lookup resolves (classifier.js
// approvalsFor): "Roblox" alone misses the "roblox-corporation" key and every
// row would land UNKNOWN, so the petitioner name is used when the brand isn't
// a key itself.
//
//   node scripts/probe-boards.js sponsors 20 > boards.txt
//   node scripts/probe-boards.js names companies.txt > boards.txt
//
// Review the output before merging. Lines marked CHECK matched on name only —
// in sponsors mode that is every Greenhouse and Lever hit, and the 2026-11-02
// run's collisions were all among them or among Ashby sites matched by domain
// stem (Astera Institute for Astera Labs). CHECK-KEY means displayName came
// from a USCIS key found by prefix, which may be another employer.

const fs = require('fs');
const { runWithConcurrency } = require('../src/collectors/http');
const { COMPANIES, CONFIG } = require('../src/config');
const { classifyRole, inUS, normalizeJob, cleanCompanyName } = require('../src/services/normalize');
const { approvalsFor, normSlug } = require('../src/services/classifier');
const { getCollector } = require('../src/collectors');
const SPONSORS = require('../src/data/h1b-sponsors.json');
const { stripSuffixes } = require('./ats-slugs');
const { buildCovered, probeWorkday } = require('./discover-sponsors');

const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';
const TIMEOUT_MS = 12_000;
// Per-platform pools. Lever is the touchiest of the three.
const POOL = { greenhouse: 8, ashby: 6, lever: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { method = 'GET', body, accept = 'application/json' } = {}) {
  for (const wait of [0, 4000, 15000]) {
    if (wait) await sleep(wait);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'User-Agent': UA, Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429) continue;
      if (!res.ok) return null;
      const text = await res.text();
      return { text, url: res.url };
    } catch {
      return null;
    }
  }
  return null;
}

async function getJson(url, opts) {
  const r = await request(url, opts);
  if (!r) return null;
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

// ─── Name matching ───────────────────────────────────────────────────────────

const words = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

const NOISE = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'the', 'and', 'of', 'technologies', 'technology', 'labs', 'ai', 'hq', 'careers', 'jobs', 'us', 'usa', 'america', 'americas', 'group', 'holdings', 'pbc']);

// The text starts with the core name's first word and contains every other
// distinctive word — "Meta Materials" still names "meta" (hence CHECK), but
// "Snapdocs" doesn't name "snap" and "Acme for Meta" doesn't name "meta".
// Joined forms are compared too, for "HighTouch" against "hightouch".
function namesCompany(text, core) {
  const hay = words(text).filter((w) => !NOISE.has(w));
  const want = core.filter((w) => !NOISE.has(w));
  if (!want.length || !hay.length) return false;
  if (hay.join('') === want.join('')) return true;
  return hay[0] === want[0] && want.every((w) => hay.includes(w));
}

const hostOf = (d) => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
const domainStem = (d) => hostOf(d).split('.')[0];
// Equal hosts, or one a subdomain of the other. Comparing stems alone let
// magic.company pass for magic.dev.
function sameSite(a, b) {
  const x = hostOf(a);
  const y = hostOf(b);
  return !!x && !!y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

// ─── Platforms ───────────────────────────────────────────────────────────────

const usSoftware = (rows) => rows.filter((r) => classifyRole(r.title) !== 'OTHER' && inUS(r.location)).length;

const PLATFORMS = {
  greenhouse: async (slug, c) => {
    const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`);
    if (!meta || typeof meta.name !== 'string') return null;
    const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`);
    const jobs = Array.isArray(d?.jobs) ? d.jobs : [];
    const hosts = jobs.slice(0, 20).map((j) => { try { return new URL(j.absolute_url).hostname; } catch { return ''; } });
    const onDomain = c.domain && hosts.some((h) => h === c.domain || h.endsWith(`.${c.domain}`));
    return {
      name: meta.name,
      verified: onDomain ? 'domain' : namesCompany(meta.name, c.core) ? 'name' : '',
      total: jobs.length,
      usSw: usSoftware(jobs.map((j) => ({ title: j.title, location: j.location?.name || '' }))),
    };
  },
  ashby: async (slug, c) => {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
    if (!Array.isArray(d?.jobs)) return null;
    const org = await getJson('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiOrganizationFromHostedJobsPageName', {
      method: 'POST',
      body: {
        operationName: 'ApiOrganizationFromHostedJobsPageName',
        variables: { organizationHostedJobsPageName: slug, searchContext: 'JobBoard' },
        query: 'query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!, $searchContext: OrganizationSearchContext) { organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName, searchContext: $searchContext) { name publicWebsite } }',
      },
    });
    const o = org?.data?.organization || {};
    // Without a known domain (sponsors mode) only the website's stem can be
    // compared, which is a name match in disguise — astera.org has stem
    // "astera" just like Astera Labs — so it counts as 'name'.
    const onDomain = c.domain && sameSite(o.publicWebsite, c.domain);
    const stemMatch = !c.domain && domainStem(o.publicWebsite) === c.core.join('');
    return {
      name: o.name || '',
      website: o.publicWebsite || '',
      verified: onDomain ? 'domain' : stemMatch || namesCompany(o.name, c.core) ? 'name' : '',
      total: d.jobs.length,
      usSw: usSoftware(d.jobs.map((j) => ({ title: j.title, location: j.location || '' }))),
    };
  },
  lever: async (slug, c) => {
    const d = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    if (!Array.isArray(d)) return null;
    const page = await request(`https://jobs.lever.co/${encodeURIComponent(slug)}`, { accept: 'text/html' });
    const title = ((page?.text || '').match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const logoHref = ((page?.text || '').match(/class="main-header-logo"[^>]*href="([^"]+)"/) || [])[1] || '';
    const onDomain = c.domain && sameSite(logoHref, c.domain);
    return {
      name: title.trim(),
      verified: onDomain ? 'domain' : namesCompany(title, c.core) ? 'name' : '',
      total: d.length,
      usSw: usSoftware(d.map((p) => ({
        title: p.text,
        location: p.categories?.location || (p.categories?.allLocations || []).join(', '),
      }))),
    };
  },
};

// ─── Candidates ──────────────────────────────────────────────────────────────

function titleCase(ws) {
  return ws.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function sponsorCandidates(min, max) {
  const isCovered = buildCovered();
  return Object.entries(SPONSORS)
    .map(([key, v]) => ({ key, approvals: v.approvals_last_2fy || 0 }))
    .filter((s) => s.approvals >= min && s.approvals < max && !isCovered(s.key))
    .sort((a, b) => b.approvals - a.approvals)
    .map((s) => {
      const core = stripSuffixes(s.key);
      const joined = core.join('');
      const slugs = [joined, core.join('-')];
      if (core.length > 1 && core[0].length >= 5) slugs.push(core[0]);
      return { label: s.key, core, slugs: [...new Set(slugs)].filter((x) => x.length >= 3), domain: '', key: s.key, approvals: s.approvals };
    });
}

// The best-resolving USCIS key for a brand: itself, else the highest-approval
// key that is the brand plus corporate suffixes ("roblox" → "roblox-corporation").
// Suffixes include words like "consulting", so a key found this way can still
// be another employer ("sierra-consulting" for Sierra the AI company) — the
// output marks it CHECK-KEY for review.
function sponsorKeyFor(name) {
  const k = normSlug(name);
  if (!k) return null;
  if (SPONSORS[k]) return k;
  let best = null;
  for (const [key, v] of Object.entries(SPONSORS)) {
    if (!key.startsWith(`${k}-`) || stripSuffixes(key).join('-') !== k) continue;
    if (!best || v.approvals_last_2fy > SPONSORS[best].approvals_last_2fy) best = key;
  }
  return best;
}

function nameCandidates(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [name, domain = '', extra = ''] = line.split('|').map((s) => s.trim());
    const core = words(name).filter((w) => w !== 'inc');
    const joined = core.join('');
    const stem = domainStem(domain);
    const slugs = [joined, core.join('-'), stem, `${joined}hq`, `${joined}inc`, `join${joined}`];
    if (!/ai$/.test(joined)) slugs.push(`${joined}ai`);
    slugs.push(...extra.split(',').map((s) => s.trim()).filter(Boolean));
    const key = sponsorKeyFor(name);
    out.push({
      label: name,
      core,
      slugs: [...new Set(slugs)].filter((x) => x && x.length >= 2),
      domain: domain.replace(/^www\./, ''),
      key,
      approvals: key ? SPONSORS[key].approvals_last_2fy || 0 : 0,
    });
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

// The board's own name unless another candidate is what the USCIS lookup
// resolves (3 approvals is the classifier's YES threshold). Board names carry
// legal suffixes ("Atomic Industries, Inc."), so those are trimmed first.
function pickDisplayName(c, boardName) {
  const pretty = String(boardName || '').replace(/,?\s+(inc|llc|ltd|corp)\.?$/i, '').trim();
  const fromKey = c.key ? titleCase(c.key.split('-')) : '';
  const options = [pretty, c.label && !c.label.includes('-') ? c.label : '', fromKey].filter(Boolean);
  let best = options[0];
  let bestN = approvalsFor(normSlug(cleanCompanyName(best)));
  for (const o of options.slice(1)) {
    const n = approvalsFor(normSlug(cleanCompanyName(o)));
    if (n >= 3 && n > bestN) [best, bestN] = [o, n];
  }
  // A key found by prefix in names mode may be a different employer.
  const checkKey = best === fromKey && c.key !== normSlug(c.label) && c.key !== normSlug(pretty);
  return { displayName: best, approvals: bestN, checkKey };
}

async function keptRows(entry) {
  const collector = getCollector(entry.source);
  try {
    const raw = await collector.fetchCompany(entry);
    const keys = new Set();
    for (const r of raw) {
      const n = normalizeJob(r, {
        filterUSOnly: CONFIG.filterUSOnly,
        filterSoftwareOnly: CONFIG.filterSoftwareOnly,
        entryLevelMode: CONFIG.entryLevelMode,
        retentionDays: CONFIG.retentionDays,
      });
      if (n) keys.add(n.dedupe_key);
    }
    return { fetched: raw.length, kept: keys.size };
  } catch (e) {
    return { fetched: 0, kept: 0, error: e.message };
  }
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  let candidates;
  if (mode === 'sponsors') candidates = sponsorCandidates(Number(a) || 50, Number(b) || Infinity);
  else if (mode === 'names' && a) candidates = nameCandidates(a);
  else throw new Error('usage: probe-boards.js sponsors [min] [max] | names <file>');

  const known = new Set(COMPANIES.map((c) => `${c.source}:${String(c.slug || '').toLowerCase()}`));
  const knownNames = new Set(COMPANIES.map((c) => words(c.displayName).join('')));
  process.stderr.write(`${candidates.length} candidates × ${Object.keys(PLATFORMS).length} platforms…\n`);
  const started = Date.now();

  const hits = [];
  await Promise.all(Object.entries(PLATFORMS).map(([platform, probe]) =>
    runWithConcurrency(candidates, POOL[platform], async (c, i) => {
      for (const slug of c.slugs) {
        if (known.has(`${platform}:${slug.toLowerCase()}`)) return;
        // eslint-disable-next-line no-await-in-loop
        const r = await probe(slug, c);
        if (!r) continue;
        if (r.verified && r.usSw > 0) hits.push({ platform, slug, c, ...r });
        else if (r.verified) process.stderr.write(`  no US software: ${platform}:${slug} "${r.name}" (${r.total} postings)\n`);
        // A board exists under this slug — it either is the company or a
        // collision; either way the remaining variants are longer shots.
        if (r.verified) return;
      }
      if (platform === 'greenhouse' && (i + 1) % 200 === 0) {
        process.stderr.write(`  ${i + 1}/${candidates.length} (${Math.round((Date.now() - started) / 1000)}s)\n`);
      }
    })
  ));

  // Workday: names mode only, and only tenants the board doesn't have.
  if (mode === 'names') {
    const tenants = new Set(COMPANIES.filter((c) => c.source === 'workday').map((c) => c.tenant));
    await runWithConcurrency(candidates, 4, async (c) => {
      const guesses = [...new Set([c.core.join(''), domainStem(c.domain)])].filter((t) => t && !tenants.has(t));
      const wd = guesses.length ? await probeWorkday(guesses) : null;
      for (const s of wd?.sites?.slice(0, 2) || []) {
        hits.push({ platform: 'workday', slug: `${wd.tenant}-${s.site.toLowerCase()}`, c, tenant: wd.tenant, wd: wd.wd, site: s.site, name: '', verified: wd.tenant === c.core.join('') || wd.tenant === domainStem(c.domain) ? 'tenant' : '', total: s.total, usSw: s.usOnPage });
      }
    });
  }

  process.stderr.write(`${hits.length} verified boards in ${Math.round((Date.now() - started) / 1000)}s — collecting each once…\n`);
  const lines = await runWithConcurrency(hits, 4, async (h) => {
    const { displayName, approvals, checkKey } = pickDisplayName(h.c, h.name || titleCase(h.c.core));
    const entry = h.platform === 'workday'
      ? { source: 'workday', slug: h.slug, tenant: h.tenant, wd: h.wd, site: h.site, displayName }
      : { source: h.platform, slug: h.slug, displayName };
    const k = await keptRows(entry);
    const dup = knownNames.has(words(displayName).join('')) || knownNames.has(h.c.core.join(''));
    const fields = Object.entries(entry).map(([key, v]) => `${key}: '${q(v)}'`).join(', ');
    return {
      approvals,
      kept: k.kept,
      platform: h.platform,
      line: `  { ${fields} },  // ${k.kept} kept, ${h.usSw} US software of ${h.total}, ${approvals} H-1B approvals`
        + ` — ${h.verified} match "${h.name || h.c.label}"${h.website ? ` ${h.website}` : ''} for "${h.c.label}"`
        + `${h.verified === 'name' ? ' CHECK' : ''}${checkKey ? ' CHECK-KEY' : ''}${dup ? ' ALREADY-CONFIGURED-ELSEWHERE' : ''}${k.error ? ` ERROR ${k.error}` : ''}`,
    };
  });
  lines.sort((x, y) => x.platform.localeCompare(y.platform) || y.kept - x.kept || y.approvals - x.approvals);
  for (const l of lines) console.log(l.line);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('probe failed:', e);
    process.exit(1);
  });
}

module.exports = { namesCompany, sponsorKeyFor };
