#!/usr/bin/env node
'use strict';

// One-shot discovery tool for Getro-powered VC portfolio job boards.
//
// A Getro board's numeric network id is what src/collectors/getro.js needs, and
// it is not derivable from the hostname. This resolves it: fetch the board's
// /jobs page, read `props.pageProps.network.id` out of the server-rendered
// __NEXT_DATA__ blob, then confirm the search API actually returns US rows for
// that id before emitting anything.
//
// Two-step verification matters because the failure modes are different:
// a non-Getro board (many VC boards run on Consider instead) has no
// __NEXT_DATA__ network object at all, while a stale/incorrect id returns an
// Elasticsearch index_not_found_exception from the API.
//
// Output: config-ready `{ source: 'getro', ... }` lines for src/config.js.
//
//   node scripts/probe-getro.js
//   node scripts/probe-getro.js jobs.somefirm.com another.getro.com
//   node scripts/probe-getro.js > scripts/getro-discovered.txt

const { runWithConcurrency } = require('../src/collectors/http');
const { COMPANIES } = require('../src/config');

const CONCURRENCY = 6;
const REQ_TIMEOUT_MS = 25_000;
const UA = 'job-aggregator (+https://github.com/SomyaPadhy4501/Job)';

// Candidate hostnames. Getro is the most common host for VC portfolio boards
// but far from the only one, so most of these are expected to miss — a miss
// costs one request and prints nothing. Weighted toward US/SF-focused firms,
// which is where this board's coverage gap is.
const CANDIDATES = [
  // verified Getro as of 2026-08-13
  'jobs.craftventures.com', 'jobs.uncorkcapital.com', 'jobs.leadedge.com',
  'jobs.generalcatalyst.com', 'jobs.khoslaventures.com',
  // large multi-stage US funds
  'jobs.sequoiacap.com', 'jobs.accel.com', 'jobs.greylock.com', 'jobs.bvp.com',
  'jobs.lsvp.com', 'jobs.ivp.com', 'jobs.nea.com', 'jobs.thrivecap.com',
  'jobs.foundersfund.com', 'jobs.8vc.com', 'jobs.menlovc.com', 'jobs.crv.com',
  'jobs.matrixpartners.com', 'jobs.redpoint.com', 'jobs.battery.com',
  'jobs.insightpartners.com', 'jobs.iconiqcapital.com', 'jobs.tcv.com',
  'jobs.sapphireventures.com', 'jobs.scalevp.com', 'jobs.emergencecapital.com',
  'jobs.summitpartners.com', 'jobs.coatue.com', 'jobs.altimeter.com',
  // seed / early stage, SF-heavy
  'jobs.initialized.com', 'jobs.firstround.com', 'jobs.trueventures.com',
  'jobs.foundationcap.com', 'jobs.wing.vc', 'jobs.amplifypartners.com',
  'jobs.decibel.vc', 'jobs.unusual.vc', 'jobs.boldstart.vc',
  'jobs.susaventures.com', 'jobs.felicis.com', 'jobs.signalfire.com',
  'jobs.mayfield.com', 'jobs.homebrew.co', 'jobs.bond.co',
  'jobs.consnetwork.com', 'jobs.pearvc.com', 'jobs.sozo.vc',
  'jobs.freestyle.vc', 'jobs.defyvc.com', 'jobs.costanoa.vc',
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)),
  ]);
}

async function fetchText(url) {
  const res = await withTimeout(
    fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    }),
    REQ_TIMEOUT_MS,
    url
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Step 1 — resolve hostname → { networkId, name }.
async function resolveNetwork(host) {
  const html = await fetchText(`https://${host}/jobs`);
  const m = html.match(/id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('not a Getro board (no __NEXT_DATA__)');

  const network = JSON.parse(m[1])?.props?.pageProps?.network;
  if (!network?.id) throw new Error('no network id in __NEXT_DATA__');
  return { networkId: network.id, name: network.name || host, slug: network.slug || host };
}

// Step 2 — confirm the API answers for that id, and report how many US rows it
// holds so the output can be prioritized by volume.
async function verifyNetwork(networkId) {
  const res = await withTimeout(
    fetch(`https://api.getro.com/api/v2/collections/${networkId}/search/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        hitsPerPage: 20,
        page: 0,
        filters: { searchable_locations: ['United States'] },
      }),
    }),
    REQ_TIMEOUT_MS,
    `api/${networkId}`
  );
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);

  const data = await res.json();
  const jobs = data?.results?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('API returned no US jobs');
  return { usCount: data.results.count || jobs.length };
}

async function main() {
  const args = process.argv.slice(2);
  const hosts = args.length ? args : CANDIDATES;

  const known = new Set(
    COMPANIES.filter((c) => c.source === 'getro').map((c) => String(c.networkId))
  );

  process.stderr.write(`probing ${hosts.length} candidate board(s)…\n`);
  const started = Date.now();

  const results = await runWithConcurrency(hosts, CONCURRENCY, async (host) => {
    try {
      const net = await resolveNetwork(host);
      const { usCount } = await verifyNetwork(net.networkId);
      return { host, ...net, usCount };
    } catch (err) {
      return { host, __skip: err.message || String(err) };
    }
  });

  const hits = [];
  for (const r of results) {
    if (!r || r.__error) {
      process.stderr.write(`  ✗ ${r?.host || '?'} — ${r?.__error}\n`);
      continue;
    }
    if (r.__skip) {
      process.stderr.write(`  ✗ ${r.host} — ${r.__skip}\n`);
      continue;
    }
    const dupe = known.has(String(r.networkId));
    process.stderr.write(
      `  ✓ ${r.host} — network ${r.networkId} "${r.name}" — ${r.usCount} US rows` +
        `${dupe ? ' (already in config)' : ''}\n`
    );
    if (!dupe) hits.push(r);
  }

  process.stderr.write(
    `\ndone in ${Math.round((Date.now() - started) / 1000)}s — ` +
      `${hits.length} new Getro network(s)\n\n`
  );

  if (!hits.length) return;

  // Biggest first: US row count is the best available proxy for how much this
  // network will actually contribute.
  hits.sort((a, b) => b.usCount - a.usCount);

  console.log(`  // ─── Getro VC portfolio boards (verified ${new Date().toISOString().slice(0, 10)}) ───`);
  for (const h of hits) {
    const name = h.name.replace(/'/g, "\\'");
    console.log(
      `  { source: 'getro', slug: '${h.slug}', networkId: ${h.networkId}, ` +
        `boardHost: '${h.host}', displayName: '${name}' }, // ${h.usCount} US rows`
    );
  }
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
