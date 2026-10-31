#!/usr/bin/env node
'use strict';

// One-shot discovery for employers on Workable, Recruitee, Pinpoint, Gem and
// BambooHR — the per-company ATS feeds briansjobsearch.com's platform list
// pointed at that this board didn't consume yet.
//
// None of these platforms has a company-search endpoint, so discovery means
// guessing the slug. Candidates come from two lists:
//   - src/data/h1b-sponsors.json, in descending USCIS approval order — so a hit
//     is an employer that demonstrably sponsors;
//   - the YC US-hiring feed (src/collectors/yc_companies.js) — startups are the
//     main users of these smaller ATSes.
//
// A hit must have at least one US posting AND its own text must name the
// company (see namesCompany) — slug collisions are the common case. Still
// review the output before merging, as with scripts/verify-yc-ats.js.
//
//   node scripts/probe-ats.js                    # top 500 sponsors + YC
//   node scripts/probe-ats.js 1000 workable,gem  # more sponsors, some platforms
//   node scripts/probe-ats.js > scripts/ats-discovered.txt

const { runWithConcurrency } = require('../src/collectors/http');
const { loadUsHiringCompanies, slugName } = require('../src/collectors/yc_companies');
const { COMPANIES } = require('../src/config');
const { looksUS } = require('../src/services/normalize');
const SPONSORS = require('../src/data/h1b-sponsors.json');
const { slugCandidates, stripSuffixes } = require('./ats-slugs');
const workable = require('../src/collectors/workable');
const recruitee = require('../src/collectors/recruitee');
const pinpoint = require('../src/collectors/pinpoint');
const gem = require('../src/collectors/gem');
const bamboohr = require('../src/collectors/bamboohr');

const CONCURRENCY = 12;
// Workable rate-limits bursts (see getJson), so it gets its own lower ceiling.
const WORKABLE_CONCURRENCY = 3;
const REQ_TIMEOUT_MS = 10_000;
const DEFAULT_TOP_N = 500;
const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One retry ladder for 429s. Workable rate-limits a burst of probe traffic and
// answers with an HTML 429 — without this, every board after the limit trips
// reads as "no board", and the first run found zero Workable boards that way.
async function getJson(url) {
  for (const wait of [0, 3000, 10000]) {
    if (wait) await sleep(wait);
    const r = await getJsonOnce(url);
    if (r !== RATE_LIMITED) return r;
  }
  return null;
}

const RATE_LIMITED = Symbol('rate-limited');

async function getJsonOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    // redirect: 'manual' — BambooHR answers an unknown tenant with a 302 to
    // its marketing site, which must read as a miss, not as a page to parse.
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (res.status === 429) return RATE_LIMITED;
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') || '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Each probe returns { total, us, name } or null. `us` is counted with the
// same looksUS() the collect pipeline uses, applied to the collector's own
// location formatting — so the count predicts what a collect would keep.
const PLATFORMS = {
  workable: async (slug) => {
    const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`);
    const jobs = Array.isArray(d?.jobs) ? d.jobs : null;
    if (!jobs) return null;
    const us = jobs.filter((j) => looksUS(workable.buildLocation(j))).length;
    return { total: jobs.length, us, name: d.name || '', text: `${d.name || ''} ${d.description || ''}` };
  },
  recruitee: async (slug) => {
    const d = await getJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`);
    const offers = Array.isArray(d?.offers) ? d.offers : null;
    if (!offers) return null;
    const us = offers.filter((o) => looksUS(recruitee.mapPosting(o, { slug }).location)).length;
    return {
      total: offers.length,
      us,
      name: offers[0]?.company_name || '',
      text: offers.slice(0, 3).map((o) => `${o.company_name} ${o.description}`).join(' '),
    };
  },
  pinpoint: async (slug) => {
    const d = await getJson(`https://${encodeURIComponent(slug)}.pinpointhq.com/postings.json`);
    const rows = Array.isArray(d?.data) ? d.data : null;
    if (!rows) return null;
    // Unclaimed subdomains serve Pinpoint's demo board instead of a 404 — the
    // first run "found" ~20 employers (TransUnion, NTT, HTC…) that were all
    // this same "Head of DEI - Belfast / US / UK" listing.
    if (rows.some((p) => /^head of dei - belfast$/i.test(String(p.title || '').trim()))) return null;
    const us = rows.filter((p) => looksUS(pinpoint.mapPosting(p, { slug }).location)).length;
    return { total: rows.length, us, name: '', text: rows.slice(0, 3).map((p) => p.description).join(' ') };
  },
  gem: async (slug) => {
    const d = await getJson(`https://api.gem.com/job_board/v0/${encodeURIComponent(slug)}/job_posts/`);
    if (!Array.isArray(d)) return null;
    const us = d.filter((j) => looksUS(gem.mapPosting(j, { slug }).location)).length;
    return { total: d.length, us, name: '', text: d.slice(0, 3).map((j) => j.content_plain || j.content).join(' ') };
  },
  bamboohr: async (slug) => {
    const d = await getJson(`https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`);
    const rows = Array.isArray(d?.result) ? d.result : null;
    if (!rows) return null;
    const us = rows.filter((i) => looksUS(bamboohr.buildLocation(i))).length;
    if (!us) return { total: rows.length, us, name: '', text: '' };
    // The list carries no employer text; one detail call supplies it.
    const det = await getJson(
      `https://${encodeURIComponent(slug)}.bamboohr.com/careers/${encodeURIComponent(rows[0].id)}/detail`
    );
    const op = det?.result?.jobOpening || {};
    return { total: rows.length, us, name: '', text: `${op.description || ''} ${op.jobOpeningShareUrl || ''}` };
  },
};

// Slug collisions are the norm, not the exception: on the first run
// `bamboohr:walmart` was a 5-posting board unrelated to Walmart, and
// `bamboohr:applied` was not Applied Materials. A hit is kept only when the
// board's own text names the company — every word of the core name, with
// punctuation ignored.
function namesCompany(text, label) {
  const norm = (x) => String(x || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9]+/g, ' ');
  const hay = ` ${norm(text)} `;
  const core = label.startsWith('yc:') ? norm(label.slice(3)) : stripSuffixes(label).join(' ');
  const words = core.split(/\s+/).filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => hay.includes(` ${w} `));
}

async function main() {
  const topN = Number(process.argv[2]) || DEFAULT_TOP_N;
  const only = (process.argv[3] || '').split(',').filter(Boolean);
  const platforms = Object.keys(PLATFORMS).filter((p) => !only.length || only.includes(p));

  const known = new Set(COMPANIES.map((c) => `${c.source}:${String(c.slug || '').toLowerCase()}`));

  // Candidate list: [{ label, slugs[], approvals }]
  const candidates = Object.entries(SPONSORS)
    .map(([key, v]) => ({ label: key, slugs: slugCandidates(key), approvals: v.approvals_last_2fy || 0 }))
    .sort((a, b) => b.approvals - a.approvals)
    .slice(0, topN);

  try {
    const yc = await loadUsHiringCompanies();
    const ycList = yc?.companies || [];
    for (const c of ycList) {
      const name = c?.name;
      if (!name) continue;
      const joined = slugName(name);
      const hyphen = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const slugs = [...new Set([c.slug, joined, hyphen].filter((s) => s && s.length >= 3))];
      candidates.push({ label: `yc:${name}`, slugs, approvals: 0 });
    }
  } catch (err) {
    process.stderr.write(`YC feed unavailable (${err.message}) — sponsors only\n`);
  }

  const tasks = [];
  for (const c of candidates) for (const p of platforms) tasks.push({ c, p });
  process.stderr.write(
    `probing ${candidates.length} companies × ${platforms.length} platforms (${tasks.length} tasks)…\n`
  );
  const started = Date.now();

  const probeOne = async ({ c, p }) => {
    for (const slug of c.slugs) {
      if (known.has(`${p}:${slug.toLowerCase()}`)) return null;
      // eslint-disable-next-line no-await-in-loop
      const hit = await PLATFORMS[p](slug);
      if (hit && hit.us > 0 && namesCompany(`${hit.name} ${hit.text}`, c.label)) {
        const { text, ...rest } = hit;
        return { platform: p, slug, ...rest, label: c.label, approvals: c.approvals };
      }
    }
    return null;
  };
  const results = [
    ...(await runWithConcurrency(tasks.filter((t) => t.p !== 'workable'), CONCURRENCY, probeOne)),
    ...(await runWithConcurrency(tasks.filter((t) => t.p === 'workable'), WORKABLE_CONCURRENCY, probeOne)),
  ];

  const seen = new Set();
  const hits = [];
  for (const r of results) {
    if (!r || r.__error) continue;
    const k = `${r.platform}:${r.slug.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    hits.push(r);
  }
  hits.sort((a, b) => a.platform.localeCompare(b.platform) || b.us - a.us);

  process.stderr.write(`\ndone in ${Math.round((Date.now() - started) / 1000)}s — ${hits.length} board(s)\n\n`);
  let current = '';
  for (const h of hits) {
    if (h.platform !== current) {
      current = h.platform;
      console.log(`\n  // ─── ${h.platform} (scripts/probe-ats.js, ${new Date().toISOString().slice(0, 10)}) ───`);
    }
    const display = (h.name || h.label.replace(/^yc:/, '')).replace(/'/g, "\\'");
    const why = h.approvals ? `${h.approvals} H-1B approvals` : h.label.startsWith('yc:') ? 'YC' : '';
    console.log(
      `  { source: '${h.platform}', slug: '${h.slug}', displayName: '${display}' },` +
        ` // ${h.us}/${h.total} US, ${why}, matched from "${h.label}"`
    );
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
