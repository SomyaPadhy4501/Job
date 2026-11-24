#!/usr/bin/env node
'use strict';
// Employer discovery from the community new-grad lists. The lists name the
// employers that actually post entry-level software roles, and most link
// straight to the employer's job board, so an apply link is enough to configure
// the board: "acme.wd5.myworkdayjobs.com/External/job/..." is Workday tenant
// acme, shard 5, site External, with no probe needed.
//
// Reads SimplifyJobs, vanshb03, speedyapply (SWE + AI), three Zapply 2027 lists
// and jobright-ai's SWE list. Keeps US software rows (classifyRole + looksUS,
// no interns). Then, for employers no board in src/config.js covers:
//   1. ranks them by USCIS approvals (3+ is the classifier's YES threshold);
//   2. builds an entry from each collectable board their links name
//      (Zapply's redirect codes give the ATS and slug or Workday tenant), and
//      verifies non-Workday ones by running the collector and normalizeJob,
//      as probe-boards.js does ("kept" = rows a collect keeps today);
//   3. lists the Workday tenants known only by name (site unknown: run
//      probe-boards.js names) and the employers on platforms with no collector
//      (browser extension "My boards", or a new collector).
//
//   node scripts/mine-lists.js            # uses cached list files (os.tmpdir)
//   node scripts/mine-lists.js --fresh    # refetch the lists first
//
// Workday entries are printed unprobed. Review the output before pasting it
// into src/config.js, then run the tests. First run: 2026-11-23 (96 boards).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CONFIG, COMPANIES } = require('../src/config');
const { getCollector } = require('../src/collectors');
const { runWithConcurrency } = require('../src/collectors/http');
const { normalizeJob, classifyRole, inUS, looksUS } = require('../src/services/normalize');
const { approvalsFor, normSlug } = require('../src/services/classifier');
const { detectAts } = require('./discover-sponsors');

const CACHE = path.join(os.tmpdir(), 'job-mine-lists');
const LISTS = [
  ['speedy-swe', 'speedy', 'https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/NEW_GRAD_USA.md'],
  ['speedy-ai', 'speedy', 'https://raw.githubusercontent.com/speedyapply/2027-AI-College-Jobs/main/NEW_GRAD_USA.md'],
  ['simplify', 'ghjson', 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'],
  ['vanshb03', 'ghjson', 'https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json'],
  ['zapply-newgrad', 'zapply', 'https://raw.githubusercontent.com/zapplyjobs/New-Grad-Jobs-2027/main/README.md'],
  ['zapply-swe', 'zapply', 'https://raw.githubusercontent.com/zapplyjobs/New-Grad-Software-Engineering-Jobs-2027/main/README.md'],
  ['zapply-visa', 'zapply', 'https://raw.githubusercontent.com/zapplyjobs/Visa-Sponsored-Jobs-2027/main/README.md'],
  ['jobright-swe', 'jobright', 'https://raw.githubusercontent.com/jobright-ai/2026-Software-Engineer-New-Grad/master/README.md'],
];

// Employers the Playwright scraper covers; they are not in COMPANIES.
const SCRAPER = ['google', 'meta', 'microsoft', 'apple', 'deloitte', 'cisco', 'cognizant', 'wayfair'];
// Not this board's target, or ruled out before (see the notes in config.js
// and EXCLUDED_EMPLOYERS in clearance.js).
const SKIP_NAME = /universit|\bcollege\b(?! board)|school|hospital|medical (center|college)|clinic|children|health(care)? system|medstar|county|city of|state of|commonwealth|department of|\blaw\b|\bllp\b/i;
const SKIP = new Set([
  'xai', 'netflix', 'capgemini', // EXCLUDED_EMPLOYERS
  'pnc-financial-services', // its US software postings all refuse sponsorship
  'leidos', 'booz-allen', 'booz-allen-hamilton', 'general-dynamics-information-technology', 'keylogic', 'rei-systems', 'rand-corporation', // clearance-bound
  'sidley-austin', 'ernst-young', 'opower', // law firm; no collectable board; Oracle
  '9to9-software-solutions', 'diversified-services-network', 'nucleusteq', 'isoftstone', // staffing
  'astera-institute', // its board name collides with Astera Labs
]);
const WD_SKIP_SITE = /confidential|internal|sourced|employee|alumni|contingent|executive/i;
const COLLECTABLE = new Set(['workday', 'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'recruitee', 'gem', 'rippling', 'bamboohr', 'oracle_hcm', 'eightfold']);

const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').trim();
const cells = (line) => line.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
const isCont = (s) => !s || /^(↳|&#8627;|⤷)$/.test(s);

const PARSE = {
  // | <a href="site"><strong>Co</strong></a> | Title | City, ST | $ | <a href="APPLY"><img alt="Apply"></a> | 3d |
  speedy(md, list, out) {
    let last = '';
    for (const line of md.split('\n')) {
      if (!line.startsWith('|') || !line.includes('alt="Apply"')) continue;
      const c = cells(line);
      const company = isCont(strip(c[0])) ? last : strip(c[0]);
      last = company;
      const apply = c.find((x) => x.includes('alt="Apply"')) || '';
      out.push({ list, company, title: strip(c[1]), location: strip(c[2]), url: (apply.match(/href="([^"]+)"/) || [])[1] || '', site: (c[0].match(/href="([^"]+)"/) || [])[1] || '' });
    }
  },
  // Simplify / vanshb03 listings.json (the ghlistings schema).
  ghjson(json, list, out) {
    for (const d of JSON.parse(json)) {
      if (!d.active || d.is_visible === false) continue;
      const location = Array.isArray(d.locations) ? d.locations.join(', ') : d.locations || '';
      out.push({ list, company: (d.company_name || '').trim(), title: (d.title || '').trim(), location, url: d.url || '', site: '' });
    }
  },
  // | **Co** | Title | City | 14m | … | [Apply](https://zapply.jobs/l/d/workday-acme-external-R123?s=…) |
  zapply(md, list, out) {
    let last = '';
    for (const line of md.split('\n')) {
      if (!line.startsWith('|') || !line.includes('zapply.jobs/l/')) continue;
      const c = cells(line);
      const company = isCont(strip(c[0])) ? last : strip(c[0]);
      last = company;
      out.push({ list, company, title: strip(c[1]), location: strip(c[2]), url: '', site: '', code: (line.match(/zapply\.jobs\/l\/[a-z]+\/([^?)\s]+)/) || [])[1] || '' });
    }
  },
  // | **[Co](site)** | **[Title](https://jobright.ai/jobs/info/…)** | City, ST, United States | … |
  jobright(md, list, out) {
    let last = '';
    for (const line of md.split('\n')) {
      if (!line.startsWith('|') || !line.includes('jobright.ai/jobs/info')) continue;
      const c = cells(line);
      const m = c[0].match(/\[([^\]]+)\]\(([^)]*)\)/);
      const name = m ? m[1].trim() : strip(c[0]);
      const company = isCont(name) ? last : name;
      last = company;
      const t = c[1].match(/\[([^\]]+)\]/);
      out.push({ list, company, title: t ? t[1].trim() : strip(c[1]), location: strip(c[2]), url: '', site: m ? m[2] : '' });
    }
  },
};

async function load(name, url, fresh) {
  const file = path.join(CACHE, name);
  if (!fresh && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': 'job-aggregator/1.0' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

function boardKey(c) {
  return c.source === 'workday' ? `workday|${c.tenant}|${String(c.site).toLowerCase()}` : `${c.source}|${String(c.slug || '').toLowerCase()}`;
}

function coverage() {
  const names = new Set(SCRAPER);
  for (const c of COMPANIES) {
    for (const n of [c.displayName, c.company, c.slug, c.tenant]) {
      const k = normSlug(n);
      if (k && k.length >= 3) { names.add(k); names.add(k.replace(/-/g, '')); }
    }
  }
  const boards = new Set(COMPANIES.map(boardKey));
  const coveredName = (name) => {
    const parts = normSlug(name).split('-').filter(Boolean);
    for (let i = parts.length; i >= 1; i--) {
      const p = parts.slice(0, i).join('-');
      if (p.length >= 3 && names.has(p)) return true;
    }
    return names.has(parts.join(''));
  };
  return { boards, coveredName };
}

function boardOf(url) {
  if (!url) return null;
  const hit = detectAts(url, '');
  if (hit && hit.kind === 'workday') return { kind: 'workday', tenant: hit.m[1], wd: hit.m[2], site: hit.m[3], url };
  if (hit) return { kind: hit.kind, slug: hit.m[1], url };
  try { return { kind: 'other', slug: new URL(url).hostname.replace(/^www\./, ''), url }; } catch { return null; }
}

function employers(rows) {
  const { boards, coveredName } = coverage();
  const byName = new Map();
  for (const r of rows) {
    if (!r.company || /\bintern(ship)?s?\b|co-?op/i.test(r.title)) continue;
    if (classifyRole(r.title) === 'OTHER' || !looksUS(r.location)) continue;
    const name = normSlug(r.company);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { name, company: r.company, rows: 0, lists: new Set(), boards: new Map(), codes: new Map(), sites: new Set(), onBoard: false });
    const e = byName.get(name);
    e.rows++;
    e.lists.add(r.list);
    const b = boardOf(r.url);
    if (b) {
      const k = b.kind === 'workday' ? `workday|${b.tenant}|${b.site.toLowerCase()}` : `${b.kind}|${String(b.slug).toLowerCase()}`;
      if (boards.has(k)) e.onBoard = true;
      const prev = e.boards.get(k);
      e.boards.set(k, { ...(prev || b), n: (prev ? prev.n : 0) + 1 });
    }
    if (r.code) { const k = r.code.split('-').slice(0, 2).join('-'); e.codes.set(k, (e.codes.get(k) || 0) + 1); }
    if (r.site) e.sites.add(r.site.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
  }
  return [...byName.values()].map((e) => ({ ...e, approvals: approvalsFor(e.name), covered: coveredName(e.company) || e.onBoard }));
}

function oracleSite(board) {
  const m = String(board.url).match(/\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

function candidates(list) {
  const have = new Set(COMPANIES.map(boardKey));
  const out = new Map();
  const workdayByName = [];
  const manual = [];
  for (const e of list) {
    if (e.covered || e.approvals < 3 || SKIP.has(e.name) || SKIP_NAME.test(e.company)) continue;
    const add = (c) => {
      const k = boardKey(c);
      if (!have.has(k) && !out.has(k)) out.set(k, { ...c, displayName: e.company, approvals: e.approvals });
    };
    let collectable = false;
    for (const b of e.boards.values()) {
      if (!COLLECTABLE.has(b.kind)) continue;
      if (b.kind === 'workday') {
        if (WD_SKIP_SITE.test(b.site)) continue;
        add({ source: 'workday', slug: `${b.tenant}-${b.site.toLowerCase()}`, tenant: b.tenant, wd: b.wd, site: b.site, links: b.n });
      } else if (b.kind === 'oracle_hcm') {
        const site = oracleSite(b);
        if (!site) continue;
        add({ source: 'oracle_hcm', slug: e.name, apiHost: b.slug, siteNumber: site, uiBaseUrl: `https://${b.slug}/hcmUI/CandidateExperience/en/sites/${site}`, links: b.n });
      } else if (b.kind === 'eightfold') {
        add({ source: 'eightfold', slug: b.slug, apiBase: `https://${b.slug}.eightfold.ai/api/apply/v2/jobs`, domain: [...e.sites][0] || `${b.slug}.com`, links: b.n });
      } else {
        add({ source: b.kind, slug: b.slug, links: b.n });
      }
      collectable = true;
    }
    for (const [code, n] of e.codes) {
      const [kind, slug] = code.split('-');
      if (['greenhouse', 'lever', 'ashby'].includes(kind) && slug) { add({ source: kind, slug, links: n, fromZapply: true }); collectable = true; }
      else if (kind === 'workday' && slug && ![...e.boards.values()].some((b) => b.kind === 'workday')) workdayByName.push(`${e.company} (${e.approvals} approvals): tenant "${slug}"`);
    }
    if (!collectable && ![...e.codes.keys()].some((k) => k.startsWith('workday'))) {
      const hint = [...e.boards.values()].map((b) => `${b.kind}:${b.slug || b.tenant}`).join(' ') || ([...e.sites][0] ? `site ${[...e.sites][0]}` : '');
      manual.push(`${e.company} (${e.approvals} approvals, ${e.rows} list rows) ${hint}`);
    }
  }
  return { list: [...out.values()], workdayByName, manual };
}

async function verify(c) {
  if (c.source === 'workday') return null;
  try {
    const raw = await getCollector(c.source).fetchCompany({ ...c });
    const keys = new Set();
    let usSoftware = 0;
    for (const r of raw) {
      if (classifyRole(r.job_title, r.source) !== 'OTHER' && inUS(r.location, r.countries)) usSoftware++;
      const n = normalizeJob(r, { filterUSOnly: CONFIG.filterUSOnly, filterSoftwareOnly: CONFIG.filterSoftwareOnly, entryLevelMode: CONFIG.entryLevelMode, retentionDays: CONFIG.retentionDays });
      if (n) keys.add(n.dedupe_key);
    }
    return { fetched: raw.length, usSoftware, kept: keys.size };
  } catch (err) {
    return { error: err.message.slice(0, 100) };
  }
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const FIELDS = { workday: ['slug', 'tenant', 'wd', 'site'], oracle_hcm: ['slug', 'apiHost', 'siteNumber', 'uiBaseUrl'], eightfold: ['slug', 'apiBase', 'domain'] };

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const fresh = process.argv.includes('--fresh');
  const rows = [];
  for (const [name, kind, url] of LISTS) {
    try {
      const before = rows.length;
      PARSE[kind](await load(name, url, fresh), name, rows);
      process.stderr.write(`${name}: ${rows.length - before} rows\n`);
    } catch (err) {
      process.stderr.write(`${name}: FAILED ${err.message}\n`);
    }
  }

  const all = employers(rows);
  const uncovered = all.filter((e) => !e.covered);
  console.log(`# ${all.reduce((s, e) => s + e.rows, 0)} US software rows from ${all.length} employers; ${uncovered.length} with no board`);
  for (const [lo, hi] of [[100, Infinity], [20, 100], [3, 20], [0, 3]]) {
    const t = uncovered.filter((e) => e.approvals >= lo && e.approvals < hi);
    console.log(`#   ${lo}${hi === Infinity ? '+' : `-${hi - 1}`} approvals: ${t.length} employers, ${t.reduce((s, e) => s + e.rows, 0)} rows`);
  }

  const { list, workdayByName, manual } = candidates(uncovered);
  process.stderr.write(`${list.length} candidate boards; verifying ${list.filter((c) => c.source !== 'workday').length}…\n`);
  const checked = await runWithConcurrency(list, 4, async (c) => ({ c, v: await verify(c) }));
  checked.sort((a, b) => (a.c.source === 'workday') - (b.c.source === 'workday') || a.c.source.localeCompare(b.c.source) || ((b.v && b.v.kept) || 0) - ((a.v && a.v.kept) || 0) || b.c.approvals - a.c.approvals);
  console.log('\n# Config entries');
  for (const { c, v } of checked) {
    const fields = ['source', ...(FIELDS[c.source] || ['slug']), 'displayName'].map((k) => `${k}: '${q(c[k])}'`).join(', ');
    const note = !v
      ? `${c.links} list link(s), ${c.approvals} approvals; unprobed`
      : v.error ? `ERROR ${v.error}` : `${v.kept} kept, ${v.usSoftware} US software of ${v.fetched}, ${c.approvals} approvals${c.fromZapply ? ', slug from Zapply' : ''}`;
    console.log(`  { ${fields} },  // ${note}`);
  }
  console.log(`\n# Workday tenants known only by name (find the site with probe-boards.js names):\n#   ${workdayByName.join('\n#   ') || 'none'}`);
  console.log(`\n# No server-side collector (browser extension "My boards", or a new collector):\n#   ${manual.join('\n#   ') || 'none'}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('mine-lists failed:', err);
    process.exit(1);
  });
}

module.exports = { PARSE, boardOf };
