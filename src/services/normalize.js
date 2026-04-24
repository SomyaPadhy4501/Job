'use strict';

const { classifySponsorship } = require('./classifier');

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocation(loc) {
  if (!loc) return '';
  return String(loc).replace(/\s+/g, ' ').trim();
}

// Normalize any source's date string / number to ISO 8601.
// Handles: ISO strings, "Month DD, YYYY" (Amazon), Unix epoch seconds or ms.
// Returns null if unparseable — callers treat null as "unknown date".
function parseDateToIso(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const ms = v > 1e12 ? v : v * 1000; // seconds vs ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ─── US location heuristic ─────────────────────────────────────────────────
const US_STATES = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt',
  'va','wa','wv','wi','wy','dc',
]);
const US_STATE_NAMES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
  'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
  'minnesota','mississippi','missouri','montana','nebraska','nevada',
  'new hampshire','new jersey','new mexico','new york','north carolina',
  'north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont',
  'virginia','washington','west virginia','wisconsin','wyoming',
  'district of columbia',
];
const US_CITY_MARKERS = [
  'new york','san francisco','sf ','nyc','los angeles','boston','seattle',
  'austin','chicago','atlanta','denver','miami','houston','dallas','portland',
  'san diego','san jose','palo alto','mountain view','sunnyvale','bellevue',
  'cambridge','brooklyn','minneapolis','washington, dc','washington dc',
  'redmond','bay area',
];

function looksUS(location) {
  if (!location) return true; // unknown → don't drop
  const l = location.toLowerCase();
  if (/\b(u\.?s\.?a?\.?|united states|usa)\b/.test(l)) return true;
  if (/\bremote\b/.test(l) && !/\bemea|apac|europe|asia|uk|canada|india\b/.test(l)) return true;
  for (const name of US_STATE_NAMES) if (l.includes(name)) return true;
  const tokens = l.split(/[\s,;/|()\-]+/).filter(Boolean);
  for (const tok of tokens) if (US_STATES.has(tok)) return true;
  for (const c of US_CITY_MARKERS) if (l.includes(c)) return true;
  return false;
}

// ─── Role-type classifier ──────────────────────────────────────────────────
// Order matters: most specific first. Data-eng runs BEFORE the SRE family so
// "Cloud Data Engineer" buckets as DATA_ENG, not SRE.
function classifyRole(title) {
  const t = (title || '').toLowerCase();
  if (/\b(machine learning|ml)[\s-]+engineer\b/.test(t)) return 'MLE';
  if (/\bapplied\s+(scientist|researcher)\b/.test(t)) return 'MLE';
  if (/\bresearch\s+engineer\b/.test(t)) return 'AI';
  if (/\bai\s+(engineer|research|scientist)\b/.test(t)) return 'AI';
  if (/\bresearch\s+scientist\b/.test(t)) return 'AI';
  if (/\bdata\s+scientist\b/.test(t)) return 'DS';
  if (/\bdata\s+engineer\b/.test(t)) return 'DATA_ENG';

  // DevOps / SRE / Platform / Infrastructure / Cloud family.
  if (
    /\b(site\s+reliability|reliability|sre|dev\s*ops|platform|infrastructure|systems|production|release|build)\s+(engineer|developer|specialist)\b/.test(
      t
    )
  )
    return 'SRE';
  if (
    /\bcloud\s+(engineer|developer|specialist|infrastructure|platform|ops|operations)\b/.test(
      t
    )
  )
    return 'SRE';
  // Bare-word fallbacks for titles without "engineer" suffix
  if (/\b(devops|sre|kubernetes|terraform)\b/.test(t)) return 'SRE';

  if (/\bsecurity\s+engineer\b/.test(t)) return 'SECURITY';
  if (/\b(ios|android|mobile)\s+engineer\b/.test(t)) return 'MOBILE';
  if (
    /\b(software|applications|full[-\s]?stack|front[-\s]?end|back[-\s]?end|web)\s+(engineer|developer)\b/.test(
      t
    )
  )
    return 'SWE';
  if (/\bsoftware\s+development\s+engineer\b/.test(t)) return 'SWE'; // Amazon's SDE
  if (/\b(swe|sde)\b/.test(t)) return 'SWE';
  if (/\bengineer\b/.test(t)) return 'SWE'; // generic engineer → bucket as SWE
  return 'OTHER';
}

function looksSoftware(title) {
  return classifyRole(title) !== 'OTHER';
}

// ─── Entry-level filter ────────────────────────────────────────────────────
// Interns are rejected outright — user wants full-time only.
// "II", "III", "IV", "V" as standalone tokens mean mid+ — reject.
// "Senior/Sr/Staff/Principal/Lead/Director/Manager/Head/VP" — reject.
const INTERN_REJECT = [
  /\bintern(ship)?s?\b/, /\bco-?op\b/, /\bsummer\s+20\d\d\b/,
];

// II is allowed through — at most companies "Software Engineer II" means 1-3 YOE
// which matches the user's target range. III/IV/V/VI are always senior.
const SENIOR_REJECT = [
  /\bsenior\b/, /\bsr\.?\b/, /\bstaff\b/, /\bprincipal\b/, /\bdistinguished\b/,
  /\blead\b/, /\bdirector\b/, /\bmanager\b/, /\bhead of\b/,
  /\bvp\b/, /\bvice\s+president\b/, /\barchitect\b/,
  /\s(iii|iv|v|vi)\b/i, // space + III/IV/…  (II is intentionally NOT rejected)
  /\s-\s*(iii|iv|v|vi)\b/i,
];

const ENTRY_POSITIVE = [
  /\bnew\s+grad(uate)?\b/, /\bnew\s+college\s+grad(uate)?\b/,
  /\b(early[\s-]career|early\s+in\s+career)\b/, /\buniversity\s+(hire|grad|program|student)\b/,
  /\bentry[\s-]level\b/, /\bassociate\b/, /\bjunior\b/, /\bjr\.?\b/,
  /\b(engineer|developer|scientist)\s+(i|1)\b/i,
  /\bgraduate\s+(engineer|developer)\b/,
];

// Explicit mid-level (1-3 YOE) signals. Used to stamp an is_mid_level flag so
// the UI can show a "mid" pill and users can filter by level.
const MID_POSITIVE = [
  /\b(engineer|developer|scientist)\s+(ii|2)\b/i,
  /\bmid[\s-]?(level|career)\b/,
  /\b(1|2)\s*-\s*(2|3|4)\s+years?\b/i,
];

function looksIntern(title) {
  const t = (title || '').toLowerCase();
  return INTERN_REJECT.some((r) => r.test(t));
}

function looksSeniorReject(title) {
  const t = (title || '').toLowerCase();
  return SENIOR_REJECT.some((r) => r.test(t));
}

function looksExplicitEntry(title) {
  const t = (title || '').toLowerCase();
  return ENTRY_POSITIVE.some((r) => r.test(t));
}

function looksMidLevel(title) {
  const t = (title || '').toLowerCase();
  return MID_POSITIVE.some((r) => r.test(t));
}

function passesLevel(title, mode) {
  // Always drop internships — user is looking for full-time roles.
  if (looksIntern(title)) return false;
  if (mode === 'off') return true;
  if (looksSeniorReject(title)) return false;
  if (mode === 'strict') return looksExplicitEntry(title);
  return true; // 'permissive'
}

// Dedupe key has to survive cosmetic drift between sources for the same role:
//   Google LLC (Workday) vs Google (ghlistings)
//   San Francisco, CA, USA vs San Francisco, CA vs SF, CA
//   Software Engineer (Remote) vs Software Engineer
// We strip corporate suffixes from the company, parenthetical modifiers + common
// qualifiers from the title, and country suffixes from the location before
// slugifying. Errs on the aggressive side — catching real duplicates matters
// more than preserving marginal distinctions. apply_url is used as a secondary
// dedupe check in upsertJob to catch anything this misses.
function normCompany(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|pbc|gmbh|plc|bv|ag)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(remote|hybrid|onsite|on-site|us|usa|united states|full[\s-]?time|ft|contract|w2|h1b)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function normLocation(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(united states|usa|us|u\.s\.a\.|u\.s\.)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function buildDedupeKey(company, title, location) {
  return `${normCompany(company)}|${normTitle(title)}|${normLocation(location)}`;
}

// Main entry. Returns a DB-ready row or null if filtered out.
function normalizeJob(raw, { filterUSOnly, filterSoftwareOnly, entryLevelMode } = {}) {
  const company_name = (raw.company_name || '').trim();
  const job_title = (raw.job_title || '').trim();
  const location = normalizeLocation(raw.location);
  const apply_url = (raw.apply_url || '').trim();
  const description = stripHtml(raw.description || '');
  const date_posted = parseDateToIso(raw.date_posted);

  if (!company_name || !job_title || !apply_url) return null;

  const role_type = classifyRole(job_title);
  if (filterSoftwareOnly && role_type === 'OTHER') return null;
  if (filterUSOnly && !looksUS(location)) return null;
  if (!passesLevel(job_title, entryLevelMode || 'permissive')) return null;

  // A source can supply a pre-labeled sponsorship (e.g. the New-Grad-2027 repo
  // tags every posting). Trust it over the rule-based classifier when present.
  const sponsorship =
    raw.sponsorship_override && ['YES', 'NO', 'UNKNOWN'].includes(raw.sponsorship_override)
      ? raw.sponsorship_override
      : classifySponsorship(`${job_title}\n${description}`);

  // Same for entry-level: a curated new-grad source can force the flag.
  const is_entry_level =
    raw.entry_level_override != null
      ? raw.entry_level_override ? 1 : 0
      : looksExplicitEntry(job_title) ? 1 : 0;

  // Mid-level stamp: Uber supplies this via its authoritative level field.
  // Otherwise fall back to title-based detection. Don't double-stamp if entry.
  let is_mid_level = 0;
  if (!is_entry_level) {
    if (raw.mid_level_override != null) is_mid_level = raw.mid_level_override ? 1 : 0;
    else if (looksMidLevel(job_title)) is_mid_level = 1;
  }

  return {
    dedupe_key: buildDedupeKey(company_name, job_title, location),
    source: raw.source,
    external_id: raw.external_id ? String(raw.external_id) : null,
    company_name,
    job_title,
    location,
    apply_url,
    description: description.slice(0, 20_000),
    date_posted,
    sponsorship,
    role_type,
    is_entry_level,
    is_mid_level,
  };
}

module.exports = {
  normalizeJob,
  stripHtml,
  buildDedupeKey,
  looksUS,
  looksSoftware,
  classifyRole,
  looksIntern,
  looksSeniorReject,
  looksExplicitEntry,
  looksMidLevel,
  passesLevel,
};
