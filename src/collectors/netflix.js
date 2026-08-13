'use strict';

const { fetchEightfold } = require('./eightfold');

// Netflix's public career site is powered by Eightfold AI, so the paging and
// description-enrichment logic lives in src/collectors/eightfold.js and this
// module only supplies what's specific to Netflix: the vanity API host (the
// tenant is not reachable at netflix.eightfold.ai) and the L-level hook below.
//
// The `netflix` source name is kept rather than folding these rows into
// `eightfold` so existing rows keep their provenance.

const API_BASE = 'https://explore.jobs.netflix.net/api/apply/v2/jobs';
const DOMAIN = 'netflix.com';

// Netflix uses L-levels in titles (e.g., "Software Engineer L4/L5, ..."). We
// reject L6+ outright and use L-levels as a stronger signal than the title
// regex for entry/mid flags.
function netflixLevelSignal(title) {
  const m = (title || '').match(/\bL(\d)(?:\/L?(\d))?/i);
  if (!m) return { reject: false };
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (hi >= 6) return { reject: true };
  // L3 = entry, L4 = early-mid — treat L3 or L3/L4 as entry, L4/L5 as mid.
  if (lo === 3) return { reject: false, entry: 1 };
  if (lo === 4) return { reject: false, mid: 1 };
  return { reject: false }; // L5 alone: let normalize decide
}

async function fetchCompany(company) {
  return fetchEightfold({
    ...company,
    source: 'netflix',
    displayName: company.displayName || 'Netflix',
    apiBase: API_BASE,
    domain: DOMAIN,
    levelSignal: netflixLevelSignal,
  });
}

module.exports = { fetchCompany, source: 'netflix' };
