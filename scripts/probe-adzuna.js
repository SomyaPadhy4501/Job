#!/usr/bin/env node
'use strict';

// One-shot coverage check for the Adzuna entries in src/config.js.
//
// The Adzuna API needs a key and its website refuses automated requests, so the
// entries added 2026-10-31 were chosen from the USCIS sponsor list without
// seeing what Adzuna holds for them. This asks once per entry — the same
// `company` filter and first default query the collector uses — and reports how
// many of the newest 50 survive matchesCompany, plus the employer names Adzuna
// returned. Drop an entry that comes back "no match"; if the names show a
// different spelling, fix its `company`.
//
// Costs one request per entry (~19) against the 2,500/month cap, spaced like the
// collector so the 25/minute limit holds.
//
//   ADZUNA_APP_ID=... ADZUNA_APP_KEY=... node scripts/probe-adzuna.js

const { fetchJson } = require('../src/collectors/http');
const { buildUrl, matchesCompany } = require('../src/collectors/adzuna');
const { COMPANIES } = require('../src/config');

const GAP_MS = 2600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) {
    console.error('Set ADZUNA_APP_ID and ADZUNA_APP_KEY first.');
    process.exit(1);
  }

  const entries = COMPANIES.filter((c) => c.source === 'adzuna');
  for (const [i, c] of entries.entries()) {
    if (i > 0) await sleep(GAP_MS);
    const url = buildUrl(
      { country: 'us', page: 1, what: 'software engineer', company: c.company, resultsPerPage: 50, maxDaysOld: 30 },
      { id, key }
    );
    try {
      const data = await fetchJson(url, { retries: 0 });
      const results = Array.isArray(data?.results) ? data.results : [];
      const kept = results.filter((r) => matchesCompany(r, c.company)).length;
      const names = [...new Set(results.map((r) => r.company?.display_name).filter(Boolean))].slice(0, 4);
      const verdict = kept ? `${kept} of ${results.length} match` : 'no match';
      console.log(`${c.slug.padEnd(12)} ${verdict.padEnd(18)} total ${data?.count ?? '?'}  ${names.join(' | ')}`);
    } catch (err) {
      console.log(`${c.slug.padEnd(12)} error: ${err.message}`);
    }
  }
})();
