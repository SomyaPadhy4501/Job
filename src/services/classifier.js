'use strict';

// Rule-based sponsorship classifier.
// Precedence (first match wins):
//   1. Explicit refusal in description          → NO.  Always strongest.
//   2. Explicit offer in description            → YES.
//   3. "Must be authorized to work" on its own  → NO.
//   4. Sponsorship mentioned without a negation → YES.
//   5. Company in USCIS H-1B Employer Data Hub (≥ 3 approvals last 2 FY) → YES.
//   6. Otherwise → UNKNOWN.
//
// Patterns run per sentence against normalizeForMatch() text, so stray markup
// ("sponsorship is <strong>not</strong> available") and typographic apostrophes
// ("we’re not able to sponsor") can't split a phrase. Every phrasing below is
// from the live corpus (2026-10-26) unless noted.
//
// No LLM / no API — pure regex + static JSON lookup.

const path = require('path');
const fs = require('fs');
const { normalizeForMatch } = require('./clearance');

// 1. Refusals. The old list caught only "no sponsorship", "unable/cannot
// sponsor" and "do(es) not offer/provide sponsorship", so the common phrasings
// below fell through to tier 4 and came back YES on the words "visa
// sponsorship" — the most costly error for a candidate who needs a visa.
// Gaps stop at commas so "does not offer relocation, but we sponsor visas"
// isn't read as a refusal.
const NO_PATTERNS = [
  /\bno (?:[\w-]+ ){0,2}sponsorship\b/,                      // "no visa sponsorship"
  /\b(?:unable|not able|n't able) to\b[^.,]{0,50}\bsponsor/, // "unable to provide employment visa sponsorship"
  /\b(?:cannot|can't|do not|don't|does not|doesn't|will not|won't|is not|isn't|are not|aren't)(?: currently| presently)? (?:sponsor|sponsoring\b|(?:offer|provid|support)\w*\b[^.,]{0,40}\bsponsor)/,
  /\b(?:not eligible|ineligible) for\b[^.,]{0,40}\bsponsorship\b/, // "not eligible for employment-based sponsorship"
  /\bsponsorship\b[^.,]{0,40}?\b(?:not (?:be )?(?:available|offered|provided|possible|supported)|unavailable)\b/,
  /\bsponsorship\s*(?:available|offered|provided)?\s*:\s*(?:no|none|not available)\b/, // "visa sponsorship: no"
  /\b(?:not|never|must not|do not|don't|does not|cannot|will not)(?: now or in the future| currently)? require\b[^.]{0,40}\bsponsorship\b/,
  // "authorized to work ... without the need for visa sponsorship". Anchored on
  // "to work" so Amazon's export-control boilerplate ("... export laws without
  // sponsorship for an export license") stays out, and "with or without
  // sponsorship" — which states no restriction at all — is excluded.
  /\b(?:authorized|eligible|permitted|able) to work\b[^.]{0,100}?(?<!with or )\bwithout\b[^.]{0,60}?\bsponsor(?!ship for an? export)/,
  /\b(?:permanent|unrestricted) (?:us )?work authorization\b/,
  /\bauthorized to work for any employer\b/,
];

// Hedges, not refusals: "we aren't able to successfully sponsor visas for
// every role and every candidate" follows "we do sponsor visas" in 21 live
// postings; "we can't guarantee sponsorship for every role" is the same idea.
// Firecrawl scopes its refusal to one group — "we also support h-1b transfers
// ... we're not able to sponsor new h-1b visas for candidates outside the us".
// A sentence like these never counts as a refusal.
const HEDGE = new RegExp([
  /\b(?:every|all) (?:roles?|candidates?|positions?|cases?)\b/.source,
  /\bguarantee/.source,
  /\bfor (?:candidates?|applicants?|people|individuals?) (?:who are |currently )?(?:based |located |living |residing )?(?:outside|abroad)\b/.source,
].join('|'));

// 2. Offers. These outrank tier 3, so "must be authorized to work in the US. We
// sponsor H-1B, O-1 ..." reads as YES instead of NO.
const YES_PATTERNS = [
  /\bwe (?:do |can |will |gladly |happily |proudly |also |currently )?sponsor\b[^.]{0,60}\b(?:visas?|h-?1-?b|o-?1|green cards?|immigration|employment|international|work permits?)/,
  /(?<!not |n't |never )\b(?:happy|glad|able|willing|open) to sponsor\b/,
  /\b(?:offer|provid|support)\w*\b[^.,]{0,30}\bvisa sponsorship\b/,
  /\bvisa sponsorship (?:is )?(?:available|offered|provided)\b/,
];

// 3. Ambiguous on its own (an OPT holder is authorized to work) but usually
// written by employers who don't sponsor, so it ranks below an explicit offer.
// "with or without sponsorship" says the opposite and is excluded.
const AUTHORIZED_ONLY = [
  /\bmust be (?:legally |currently )?authorized to work\b/,
];
const WITH_OR_WITHOUT = /\bwith or without\b[^.]{0,30}\bsponsorship\b/;

// 4. Bare mentions — the original YES list, unchanged.
const MENTION_PATTERNS = [
  /visa sponsorship/,
  /h-?1b sponsorship/,
  /h-?1b visa sponsorship/,
  /will sponsor(?:ship)?/,
  /sponsor(?: a)? visa/,
];

function anySentence(sentences, patterns, unless) {
  return sentences.some((s) => !(unless && unless.test(s)) && patterns.some((p) => p.test(s)));
}

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

// Employers whose H-1B petitions are filed under a different name from the one
// job boards show, keyed by normSlug(board name) → h1b-sponsors.json key.
// Without these, Capital One, Cisco, Oracle, JPMorgan Chase and Walmart read
// UNKNOWN on every source despite thousands of approvals — ~1,600 recent rows
// in the 2026-10-26 snapshot. Kept here rather than in refresh-h1b-data.js's
// SYNONYMS so a data refresh can't drop them; a test checks every target
// exists. SpaceX and RTX are left out on purpose: a handful of approvals, and
// their roles are mostly ITAR-restricted.
const EMPLOYER_ALIASES = {
  'amd': 'advanced-micro-devices',
  'barclays': 'barclays-services',
  'bloomberg': 'bloomberg-lp',
  'boeing': 'boeing-company',
  'broadcom': 'broadcom-corporation',
  'capital-one': 'capital-one-services',
  'citadel': 'citadel-americas-services',
  'citadel-securities': 'citadel-securities-americas-services',
  'cisco': 'cisco-systems',
  'cvs-health': 'caremark',
  'expedia-group': 'expedia',
  'fedex': 'fedex-corporate-services',
  'hpe': 'hewlett-packard-enterprise-company',
  'hpe-simplivity': 'hewlett-packard-enterprise-company',
  'ibm': 'ibm-corporation',
  'instana': 'ibm-corporation', // acquired by IBM; Getro still lists it by name
  'jpmorgan-chase': 'jpmorgan',
  'mastercard': 'mastercard-international-incorporated',
  'openai': 'openai-lp',
  'opower': 'oracle-america', // Oracle subsidiary
  'oracle': 'oracle-america',
  'state-street': 'state-street-bank-trust-company',
  'tmobile': 'mobile-usa', // USCIS "T-Mobile USA"; normSlug drops the lone "t"
  'usaa': 'united-services-automobile-association',
  'verizon': 'verizon-data-services',
  'walmart': 'wal-mart-associates',
  'yahoo': 'oath-holdings',
};

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
  // Apostrophes first: normalizeForMatch blanks unknown entities, which would
  // turn a double-encoded Greenhouse "can&#39;t sponsor" into "can t sponsor".
  const sentences = normalizeForMatch(text.replace(/&#0*39;|&#x27;|&apos;|&[lr]squo;/gi, "'"))
    .replace(/[‘’]/g, "'")
    .split(/[.!?;•]+/);

  // 1. Explicit NO beats everything
  if (anySentence(sentences, NO_PATTERNS, HEDGE)) return 'NO';
  // 2. Explicit YES
  if (anySentence(sentences, YES_PATTERNS)) return 'YES';
  // 3. Work authorization required, sponsorship not offered
  if (anySentence(sentences, AUTHORIZED_ONLY, WITH_OR_WITHOUT)) return 'NO';
  // 4. Sponsorship mentioned
  if (anySentence(sentences, MENTION_PATTERNS)) return 'YES';
  // 5. USCIS lookup — company_name drives the signal; description alone misses
  //    ~516 rows that have no description text (Workday, Microsoft, Goldman, etc.)
  const cache = getH1bCache();
  for (const candidate of [companyName, ...fallbackCompanyNames]) {
    if (!candidate) continue;
    const slug = normSlug(candidate);
    const record = cache[slug] || cache[EMPLOYER_ALIASES[slug]];
    if (record && record.approvals_last_2fy >= USCIS_THRESHOLD) {
      return 'YES';
    }
  }
  // 6. Fall through
  return 'UNKNOWN';
}

module.exports = { classifySponsorship, EMPLOYER_ALIASES, USCIS_THRESHOLD };
