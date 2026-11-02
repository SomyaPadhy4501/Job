'use strict';

// Rule-based sponsorship classifier.
// Precedence (first match wins):
//   1. Explicit NO in description → NO.  Always strongest.
//   2. A sentence that pairs "sponsor…" with a negation no pattern could parse
//      → UNKNOWN.  The description is doubting sponsorship; neither the loose
//      YES wording below nor the company's H-1B history may overrule it.
//   3. Explicit YES in description → YES.
//   4. Company in USCIS H-1B Employer Data Hub (≥ 3 approvals last 2 FY) → YES.
//   5. Otherwise → UNKNOWN.
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
  // Capital One's level-5 roles: "Capital One will consider sponsoring a new
  // qualified applicant for employment authorization for this position." Without
  // this the JD's own yes was invisible and the row was YES only through USCIS.
  /consider(?:s|ing)? sponsor/,
];

// Only statements that the employer will not sponsor. A NO here hides the row
// by default (see deriveRestriction in clearance.js), so a weak pattern costs
// real jobs.
//
// "Must be (legally) authorized to work in the US" was here and is gone on
// purpose: an H-1B or OPT holder IS authorized to work, and heavy sponsors put
// that line in boilerplate. When the sentence goes on to say "...without
// sponsorship", the `without … sponsorship` pattern below still catches it.
//
// SPONSORSHIP allows the qualifiers postings put in front of the noun ("visa",
// "employment visa", "H-1B"). Spelling it as `(?:visa |immigration )?` missed
// "do not provide employment visa sponsorship".
const SPONSORSHIP = '(?:(?:employment|employment-based|work|visa|immigration|h-?1b)[ -]){0,2}sponsorship';

// Words allowed between "sponsorship" and its verdict, as in PayPal's "Visa
// Sponsorship through PayPal is not available for this position". Counted in
// whole words, so it cannot cross a sentence or clause ("sponsorship is
// available, but relocation is not available" stays out), and a word that is
// itself a verdict ends the run ("sponsorship is available for roles that are
// not available remotely").
const QUALIFIER = "(?: (?!(?:available|offered|provided|considered)\\b)[a-z0-9&'’-]+){0,5}";

const NO_PATTERNS = [
  /no (?:visa |immigration )?sponsorship/,
  new RegExp(`unable to (?:sponsor|(?:offer|provide) ${SPONSORSHIP})`),
  /cannot sponsor/,
  /(?:will|would|do|does|are|can) not (?:currently )?sponsor/,
  /not (?:currently )?consider(?:ing)? (?:[a-z-]+ ){0,3}sponsor/,
  /won'?t sponsor/,
  new RegExp(`(?:will|would|do|does|is|are|can) not (?:currently )?(?:offer|provide) ${SPONSORSHIP}`),
  new RegExp(`not (?:currently )?(?:offering|providing) ${SPONSORSHIP}`),
  new RegExp(`not in a position to (?:sponsor|(?:offer|provide) ${SPONSORSHIP})`),
  /not (?:be )?(?:able|eligible) (?:to|for) (?:[a-z-]+ ){0,2}sponsor/,
  new RegExp(
    `${SPONSORSHIP}:?${QUALIFIER}` +
      "(?: (?:is|are|will|would|can))? (?:not|never) (?:be )?(?:available|offered|provided|considered|possible)"
  ),
  // Structured fields: "Visa sponsorship: No", "Sponsorship available: none".
  new RegExp(`${SPONSORSHIP}(?: (?:available|offered|provided))?: ?(?:no|none|n/a)\\b`),
  new RegExp(`${SPONSORSHIP}${QUALIFIER} (?:is|are|will be) unavailable`),
  new RegExp(`${SPONSORSHIP}${QUALIFIER} (?:isn|aren|won)['’]?t (?:be )?(?:available|offered|provided|considered|possible)`),
  /without (?:the need for |requiring |needing )?(?:any )?(?:current or future |now or in the future )?(?:employer |visa |company |immigration )?sponsorship/,
  /not (?:now or in the future )?require[^.]{0,40}sponsorship/,
  /unable to (?:consider|accept)[^.]{0,80}sponsorship/,
];

// Reads the description the way a person skims it: find each sentence that
// mentions sponsoring and ask whether anything near it says no. This catches
// refusals phrased in ways NO_PATTERNS don't spell out ("PayPal cannot extend
// visa sponsorship for this role"), without the false-NO risk a looser pattern
// would carry — it only withholds a YES, it never hides the row.
//
// Everything is judged inside a window around the first "sponsor", because
// stripped HTML turns a bullet list into one long run with no full stops.
const IMMIGRATION_CONTEXT =
  /visa|immigration|h-?1b|work (?:permit|authori[sz]ation|status)|employment[- ]based|green card|permanent resident|\bopt\b/;
const NEGATION = /\b(?:not|no|never|cannot|unable|unavailable|ineligible|without)\b|n['’]t\b/;
// The sentence is affirming sponsorship, so a stray "not" nearby is about
// something else ("we sponsor visas for candidates who do not hold a permit").
const AFFIRMATION =
  /\b(?:will|can|may|able to|happy to|glad to|willing to) sponsor|\bconsider(?:s|ing)? sponsor|\b(?:offer|offers|offering|provide|provides|providing) (?:\w+ ){0,2}sponsorship|sponsorship (?:is |may be |will be |can be )?(?:available|offered|provided)|\bsponsors? (?:visas?|h-?1b|work|employees|candidates)/;

function doubtsSponsorship(t) {
  for (const sentence of t.split(/[.;!?\n]/)) {
    const at = sentence.indexOf('sponsor');
    if (at < 0) continue;
    const window = sentence.slice(Math.max(0, at - 60), at + 80);
    if (NEGATION.test(window) && IMMIGRATION_CONTEXT.test(window) && !AFFIRMATION.test(window)) {
      return true;
    }
  }
  return false;
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

// Employers whose board name can't reach their USCIS petitioner name, keyed by
// normSlug(board name) → h1b-sponsors.json key. Mostly one-word brands, which
// the prefix index above skips on purpose ("Uber" → uber-technologies, 1,279
// approvals), plus names that share no leading words with the filing entity
// ("Walmart" → wal-mart-associates, "Hive" → castle-global). On 2026-11-02
// JPMorgan Chase, Walmart, Cisco, IBM, Oracle, Uber, OpenAI and the rest of
// this list all read UNKNOWN, so the board's default sponsorship = YES view hid
// every one of their jobs.
//
// Only entries where the board's company IS the petitioner. Same-word matches
// that are a different employer stay out — Harvey ≠ harvey-nash, Exa ≠
// exa-data-solutions, Lattice (HR software) ≠ lattice-semiconductor, and the
// YC startups Outset, Pure, Parker, Runway and Weave ≠ Outset Medical, Pure
// Storage, Parker Hannifin, Runway AI and Weave Communications. SpaceX, RTX and
// other defense employers are left out too: few approvals, mostly ITAR roles.
// A test checks every target exists above USCIS_THRESHOLD.
const EMPLOYER_ALIASES = {
  // Large employers
  'abbott': 'abbott-laboratories',
  'accenture': 'accenture-llp',
  'agilent': 'agilent-technologies',
  'aig': 'aig-pc-global-services',
  'amd': 'advanced-micro-devices',
  'att': 'att-services',
  'barclays': 'barclays-services',
  'bloomberg': 'bloomberg-lp',
  'boeing': 'boeing-company',
  'broadcom': 'broadcom-corporation',
  'chevron': 'chevron-corporation',
  'ciena': 'ciena-corporation',
  'cisco': 'cisco-systems',
  'citadel': 'citadel-americas-services',
  'cognizant': 'cognizant-technology-solutions-us',
  'crowe': 'crowe-llp',
  'cvs-health': 'caremark',
  'expedia-group': 'expedia',
  'fedex': 'fedex-corporate-services',
  'flextronics': 'flextronics-international-usa',
  'honeywell': 'honeywell-international',
  'hpe': 'hewlett-packard-enterprise-company',
  'ibm': 'ibm-corporation',
  'instana': 'ibm-corporation', // acquired by IBM; Getro still lists it by name
  'intuitive': 'intuitive-surgical-operations',
  'jpmorgan-chase': 'jpmorgan',
  'kla': 'kla-corporation',
  'linkedin': 'linkedin-corporation',
  'mastercard': 'mastercard-international-incorporated',
  'mckesson': 'mckesson-corporation',
  'microchip': 'microchip-technology',
  'micron': 'micron-technology',
  'ncr': 'ncr-corporation',
  'netscout': 'netscout-systems',
  'nxp': 'nxp-usa',
  'opower': 'oracle-america', // Oracle subsidiary
  'oracle': 'oracle-america',
  'prudential': 'prudential-insurance-company-america',
  'rackspace': 'rackspace-us',
  'refinitiv': 'refinitiv-us',
  'rsm': 'rsm-us-llp',
  'stryker': 'stryker-corporation',
  'tmobile': 'mobile-usa', // USCIS "T-Mobile USA"; normSlug drops the lone "t"
  'truist': 'truist-bank',
  'unisys': 'unisys-corporation',
  'unum': 'unum-group',
  'usaa': 'united-services-automobile-association',
  'vanguard': 'vanguard-group',
  'verizon': 'verizon-data-services',
  'walmart': 'wal-mart-associates',
  'yahoo': 'oath-holdings',
  'zebra': 'zebra-technologies-corporation',
  // Tech companies and startups
  'anthropic': 'anthropic-dba-anthropic',
  'attentive': 'attentive-mobile',
  'aveva': 'aveva-software',
  'blend': 'blend-labs',
  'bmc': 'bmc-software',
  'cedar': 'cedar-cares-dba-cedar',
  'chime': 'chime-financial',
  'coda': 'coda-project',
  'cresta': 'cresta-intelligence',
  'dots': 'dots-technologies',
  'faire': 'faire-wholesale',
  'finix': 'finix-payments',
  'flywire': 'flywire-corporation',
  'freenome': 'freenome-holdings',
  'glean': 'glean-technologies',
  'h1': 'h1-insights',
  'hive': 'castle-global', // Hive AI's legal name is Castle Global
  'honor': 'honor-technology',
  'imply': 'imply-data',
  'infinitus': 'infinitus-systems',
  'insulet': 'insulet-corporation',
  'kayak': 'kayak-software-corporation',
  'lob': 'lob-com',
  'motive': 'motive-technologies',
  'mutiny': 'mutiny-hq-corporation-dba-mutiny',
  'notion': 'notion-labs',
  'nuna': 'nuna-incorporated',
  'openai': 'openai-lp',
  'opendoor': 'opendoor-labs',
  'palantir': 'palantir-technologies',
  'peloton': 'peloton-interactive',
  'prosper': 'prosper-marketplace',
  'robinhood': 'robinhood-markets',
  'roblox': 'roblox-corporation',
  'sailpoint': 'sailpoint-technologies',
  'sift': 'sift-science',
  'spoton': 'spoton-transact',
  'spotify': 'spotify-usa',
  'startree': 'startree-fka-cortexdata',
  'synthego': 'synthego-corporation',
  'tempus': 'tempus-labs',
  'turing': 'turing-enterprises',
  'twitch': 'twitch-interactive',
  'uber': 'uber-technologies',
  'upstart': 'upstart-network',
  'workstream': 'workstream-technologies',
  'zipline': 'zipline-international',
  'zoom': 'zoom-video-communications',
  'zum': 'zum-services',
};

function approvalsFor(slug) {
  if (!slug) return 0;
  const exact = getH1bCache()[EMPLOYER_ALIASES[slug] || slug];
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
  // 2. The description doubts sponsorship in words the patterns can't name.
  //    Must come before the YES check: "visa sponsorship" alone is a YES
  //    pattern, so a refusal that merely mentions it would otherwise read as one.
  if (doubtsSponsorship(t)) return 'UNKNOWN';
  // 3. Explicit YES
  for (const p of YES_PATTERNS) {
    if (p.test(t)) return 'YES';
  }
  // 4. USCIS lookup — company_name drives the signal; description alone misses
  //    ~516 rows that have no description text (Workday, Microsoft, Goldman, etc.)
  for (const candidate of [companyName, ...fallbackCompanyNames]) {
    if (!candidate) continue;
    if (approvalsFor(normSlug(candidate)) >= USCIS_THRESHOLD) return 'YES';
  }
  // 5. Fall through
  return 'UNKNOWN';
}

module.exports = { classifySponsorship, approvalsFor, normSlug, EMPLOYER_ALIASES, USCIS_THRESHOLD };
