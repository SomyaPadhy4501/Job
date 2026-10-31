'use strict';

// Rule-based sponsorship classifier.
// Precedence (first match wins):
//   1. Explicit NO in description → NO.  Always strongest.
//   2. Explicit YES in description → YES.
//   3. Company in USCIS H-1B Employer Data Hub (≥ 3 approvals last 2 FY) → YES.
//   4. Otherwise → UNKNOWN.
//
// No LLM / no API — pure regex + static JSON lookup.

const path = require('path');
const fs = require('fs');

const YES_PATTERNS = [
  /visa sponsorship/,
  /h-?1b sponsorship/,
  /h-?1b visa sponsorship/,
  /will sponsor(?:ship)?/,
  /sponsor(?: a)? visa/,
  /immigration sponsorship/,
];

// Only statements that the employer will not sponsor. A NO here hides the row
// by default (see deriveRestriction in clearance.js), so a weak pattern costs
// real jobs.
//
// "Must be (legally) authorized to work in the US" was here and is gone on
// purpose: an H-1B or OPT holder IS authorized to work, and heavy sponsors put
// that line in boilerplate. When the sentence goes on to say "...without
// sponsorship", the `without … sponsorship` pattern below still catches it.
const NO_PATTERNS = [
  /no (?:visa |immigration )?sponsorship/,
  /unable to sponsor/,
  /cannot sponsor/,
  /(?:will|do|does|are|can) not (?:currently )?sponsor/,
  /won'?t sponsor/,
  /do(?:es)? not (?:offer|provide) (?:visa |immigration )?sponsorship/,
  /not (?:offering|providing) (?:visa |immigration )?sponsorship/,
  /not (?:be )?(?:able|eligible) (?:to|for) (?:[a-z-]+ ){0,2}sponsor/,
  /sponsorship (?:is |will )?not (?:be )?(?:available|offered|provided|considered)/,
  /without (?:the need for |requiring |needing )?(?:any )?(?:current or future |now or in the future )?(?:employer |visa |company |immigration )?sponsorship/,
  /not (?:now or in the future )?require[^.]{0,40}sponsorship/,
  /unable to (?:consider|accept)[^.]{0,80}sponsorship/,
];

// Threshold for USCIS YES signal: ≥ 3 approved H-1B petitions in last 2 FY.
const USCIS_THRESHOLD = 3;

// Load h1b-sponsors.json once at startup (deterministic, no runtime fetch).
// Schema: { [normSlug]: { approvals_last_2fy, latest_fy } }
let _h1bCache = null;
function getH1bCache() {
  if (_h1bCache) return _h1bCache;
  const filePath = path.resolve(__dirname, '../data/h1b-sponsors.json');
  if (!fs.existsSync(filePath)) return (_h1bCache = {});
  try {
    _h1bCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    _h1bCache = {};
  }
  return _h1bCache;
}

// USCIS records the legal petitioner, which is usually the brand plus more
// words: "capital-one-services", "american-express-travel-related-services-
// company", "state-street-bank-trust-company". A posting says "Capital One".
// Exact lookup missed 582 rows at 93 such sponsors (2026-10-31), and with the
// board defaulting to sponsorship = YES those rows were hidden.
//
// So also index every leading run of 2+ words of each USCIS key, keeping the
// highest approval count among keys sharing it. Single words are deliberately
// excluded: "united" would match United Healthcare for United Airlines.
let _prefixCache = null;
function getPrefixCache() {
  if (_prefixCache) return _prefixCache;
  _prefixCache = new Map();
  for (const [key, rec] of Object.entries(getH1bCache())) {
    const parts = key.split('-');
    for (let i = 2; i < parts.length; i++) {
      const p = parts.slice(0, i).join('-');
      const n = rec.approvals_last_2fy || 0;
      if (n > (_prefixCache.get(p) || 0)) _prefixCache.set(p, n);
    }
  }
  return _prefixCache;
}

function approvalsFor(slug) {
  if (!slug) return 0;
  const exact = getH1bCache()[slug];
  if (exact) return exact.approvals_last_2fy || 0;
  return slug.includes('-') ? getPrefixCache().get(slug) || 0 : 0;
}

// Mirrors normCompany() in normalize.js — must stay in sync.
const STOPWORDS = new Set(['the', 'and', 'or', 'of', 'for', 'in', 'to', 'a', 'an', 'at']);
function normSlug(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|pbc|gmbh|plc|bv|ag)\b\.?/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .join('-');
}

// `fallbackCompanyNames` exists for sources that report the wrong employer.
// Getro is the motivating case: its portfolio records keep a startup's
// pre-acquisition name while the posting itself now lives on the acquirer's ATS,
// so 46 Adobe roles arrive labelled "Frame.io", 32 IBM roles as "Instana", 16
// Salesforce roles as "Airkit". The USCIS lookup misses every one of them and
// they land UNKNOWN despite the real employer having thousands of approvals.
// The collector derives a second candidate from the apply_url host and passes it
// here. First key that resolves wins.
function classifySponsorship(text, companyName, fallbackCompanyNames = []) {
  if (!text || typeof text !== 'string') return 'UNKNOWN';
  const t = text.toLowerCase();

  // 1. Explicit NO beats everything
  for (const p of NO_PATTERNS) {
    if (p.test(t)) return 'NO';
  }
  // 2. Explicit YES
  for (const p of YES_PATTERNS) {
    if (p.test(t)) return 'YES';
  }
  // 3. USCIS lookup — company_name drives the signal; description alone misses
  //    ~516 rows that have no description text (Workday, Microsoft, Goldman, etc.)
  for (const candidate of [companyName, ...fallbackCompanyNames]) {
    if (!candidate) continue;
    if (approvalsFor(normSlug(candidate)) >= USCIS_THRESHOLD) return 'YES';
  }
  // 4. Fall through
  return 'UNKNOWN';
}

module.exports = { classifySponsorship, approvalsFor, normSlug };
