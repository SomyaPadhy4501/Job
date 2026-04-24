'use strict';

const { classifySponsorship } = require('./classifier');
const { classifyCategory } = require('./category');

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

// Any of these markers in a location string marks the row as non-US — they
// override the "bare remote → US" heuristic and the US_STATES `ca` fallback
// (which would otherwise match both California and Canada). Kept broad: it's
// cheaper to let a few borderline US rows through than to leak foreign ones.
const FOREIGN_MARKERS =
  /\b(worldwide|global|anywhere|emea|apac|latam|eu|europe|european|asia|asian|india|uk|united kingdom|ireland|scotland|wales|germany|deutschland|france|spain|portugal|netherlands|belgium|poland|czech|romania|hungary|denmark|norway|sweden|finland|switzerland|austria|canada|canadian|ontario|toronto|montreal|quebec|vancouver|calgary|british columbia|alberta|manitoba|brazil|mexico|argentina|chile|colombia|peru|australia|japan|singapore|israel|nigeria|egypt|china|turkey|dubai|uae|united arab emirates|saudi|qatar|bahrain|new zealand|south africa|thailand|vietnam|philippines|indonesia|malaysia|pakistan|bangladesh|berlin|london|paris|amsterdam|sydney|melbourne|bangalore|bengaluru|hyderabad|delhi|mumbai|chennai|pune|tokyo|seoul|tel aviv|bogota|santiago|buenos aires|taipei|hong kong|madrid|rome|athens|oslo|stockholm|copenhagen|helsinki|zurich|geneva|brussels|prague|budapest|warsaw|bucharest|lisbon|istanbul)\b/i;

function looksUS(location) {
  if (!location) return true; // unknown → don't drop
  const l = location.toLowerCase();

  // Explicit US → pass.
  if (/\b(u\.?s\.?a?\.?|united states)\b/.test(l)) return true;

  // Explicit non-US country/region/city → reject. This runs BEFORE the remote
  // check so "Remote, United Arab Emirates" doesn't slip through via the
  // bare `\bremote\b` match, and BEFORE the US_STATES tokenization so
  // "Vancouver, BC, CA" doesn't register California via the `ca` token.
  if (FOREIGN_MARKERS.test(l)) return false;

  // Pure "remote" with no foreign marker → assume US for a US-centric board.
  if (/\bremote\b/.test(l)) return true;

  // US state or city mentions.
  for (const name of US_STATE_NAMES) if (l.includes(name)) return true;
  const tokens = l.split(/[\s,;/|()\-]+/).filter(Boolean);
  for (const tok of tokens) if (US_STATES.has(tok)) return true;
  for (const c of US_CITY_MARKERS) if (l.includes(c)) return true;

  return false;
}

// ─── Role-type classifier ──────────────────────────────────────────────────
// Computer-science roles only: SWE, MLE, AI, DS, DATA_ENG, SRE, SECURITY,
// MOBILE. Everything else → OTHER (which the collect pipeline drops by
// default via `FILTER_SOFTWARE=true`).
//
// Strategy:
//   1. Early reject for titles that include a non-CS engineering discipline
//      (electrical, mechanical, aerospace, …) or an adjacent-but-not-CS role
//      (sales engineer, test engineer without "software", hardware, etc.).
//   2. Whitelist for each CS role — strict phrase matches, no bare "engineer"
//      fallback. If nothing matches → OTHER.
//
// The old classifier's bare `\bengineer\b → SWE` fallback was catching
// electrical/industrial/propulsion/chief engineer roles as "software".

// Hardware / physical-discipline cue words. If any of these appear in the
// title WITHOUT a compensating software cue (see HAS_SOFTWARE_CUE below),
// the role is hardware/physical engineering, not CS. Catches "Hardware
// Reliability Engineer", "Hardware Platform Engineer", "RF Engineer",
// "Silicon Design Engineer", etc., where the keywords "reliability" /
// "platform" / "engineer" might otherwise trigger a CS match.
const HARDWARE_CUE =
  /\b(hardware|firmware|asic|chip|silicon|physical[-\s]?design|\brf\b|radio[-\s]?frequency|antenna|photonic|microwave|fiber|laser|analog\s+design)\b/i;

// Software/CS cue words. Presence of any of these on a title that ALSO has a
// hardware cue means the role is software *for* hardware (e.g. embedded
// software engineer, FPGA software engineer) — keep it.
const HAS_SOFTWARE_CUE =
  /\b(software|\bml\b|machine\s+learning|\bai\b|artificial\s+intelligence|\bsde\b|\bswe\b|site\s+reliability|\bsre\b|devops|simulation|algorithm|compiler|embedded\s+software|data\s+(?:engineer|scientist)|programmer|backend|frontend|full[-\s]?stack)\b/i;

// Non-CS engineering disciplines as the prefix to "engineer/developer".
// Catches "Electrical Engineer", "Propulsion Engineer", "Industrial Engineer",
// "Aerospace Engineer", etc.
const NON_CS_DISCIPLINE =
  /\b(electrical|mechanical|industrial|civil|chemical|aerospace|aeronautical|astronautical|propulsion|manufacturing|optical|structural|materials|nuclear|environmental|petroleum|biomedical|biochemical|thermal|acoustic|hydraulic|pneumatic|fluid|combustion|automotive|avionics|power|electronics?|instrumentation|flight|marine|ocean|welding|geotechnical|mining|agricultural|food|textile|paper)\s+(engineer|developer|specialist|scientist|technician)/i;

// "Title starts with a non-CS discipline" — catches "Propulsion Test
// Infrastructure Engineer" etc. where the discipline prefix gives the role
// away even when the rest of the title contains CS-ish words.
const STARTS_NON_CS_DISCIPLINE =
  /^\s*(electrical|mechanical|industrial|civil|chemical|aerospace|aeronautical|astronautical|propulsion|manufacturing|optical|structural|materials|nuclear|environmental|petroleum|biomedical|biochemical|thermal|acoustic|hydraulic|combustion|automotive|avionics|instrumentation|flight)\b/i;

// "Research Engineer, Mechanical" / "Research Scientist - Chemistry" / etc.
// A research title followed by a physical-science suffix. Strong non-CS
// signal — reject outright.
const RESEARCH_DISCIPLINE_SUFFIX =
  /\bresearch\s+(?:engineer|scientist)\s*[,\-]\s*(mechanical|electrical|industrial|civil|chemical|aerospace|aeronautical|propulsion|manufacturing|structural|materials|nuclear|biomedical|thermal|hydraulic|acoustic|automotive|avionics|power|optical|chemistry|physics|biology|biochemistry|neuroscience)\b/i;

// Adjacent-to-software roles that share keywords but aren't CS work.
const ADJACENT_NON_CS =
  /\b(quality|test(?!\s+automation)|process|project|program(?!ing|mer)|field|sales|pre[-\s]?sales|solutions|customer(?:\s+success)?|technical\s+support|service|safety|traffic|facilities|controls|integration|supply\s+chain|deployment|chief)\s+(engineer|architect|specialist|manager|analyst)\b/i;

// Business/finance analyst-adjacent titles that occasionally include
// "engineer" or "scientist". Reject.
const NON_CS_OTHER =
  /\b(business\s+(?:analyst|developer)|marketing|growth(?:\s+manager)?|finance|accountant|recruiter|hr|legal|counsel|paralegal|graphic\s+designer|ux\s+(?:designer|researcher(?!.*\bml\b))|content|writer|copywriter|operations\s+manager|program\s+manager|project\s+manager|product\s+manager|clinical|research\s+associate|lab\s+technician)\b/i;

// ─── CS whitelist — phrase-anchored, most specific first ───────────────────

const MLE_PATTERN =
  /\b(machine\s+learning\s+(?:engineer|developer)|\bml\s+(?:engineer|developer)|\bmle\b|applied\s+(?:scientist|researcher)|machine\s+learning\s+scientist|computer\s+vision\s+engineer|nlp\s+engineer|deep\s+learning\s+engineer)/i;

const AI_PATTERN =
  /\b(ai\s+(?:engineer|developer|researcher|scientist)|artificial\s+intelligence\s+(?:engineer|scientist)|research\s+engineer|research\s+scientist|ml\s+scientist|nlp\s+scientist|computer\s+vision\s+scientist|llm\s+(?:engineer|researcher|scientist))/i;

const DS_PATTERN =
  /\b(data\s+scientist|analytics\s+scientist|quantitative\s+(?:analyst|researcher)|quant\s+researcher|decision\s+scientist)/i;

const DATA_ENG_PATTERN =
  /\b(data\s+(?:engineer|developer)|analytics\s+engineer|etl\s+developer|bi\s+engineer|business\s+intelligence\s+engineer)/i;

const SECURITY_PATTERN =
  /\b(security\s+engineer|application\s+security|appsec|cybersecurity\s+(?:engineer|analyst)|infosec\s+engineer|offensive\s+security|detection\s+engineer|incident\s+response\s+engineer|security\s+software\s+engineer)/i;

const MOBILE_PATTERN =
  /\b((?:ios|android)\s+(?:engineer|developer)|mobile\s+(?:engineer|developer|software))/i;

// Note: removed bare `reliability engineer` — too ambiguous (hardware
// reliability engineers are common in defense/aerospace). Require "site
// reliability" or "sre" explicitly.
const SRE_PATTERN =
  /\b(site\s+reliability\s+engineer|\bsre\b|dev\s*ops\s+(?:engineer|developer)|platform\s+(?:engineer|developer|software\s+engineer)|infrastructure\s+(?:engineer|developer|software\s+engineer)|cloud\s+(?:engineer|developer|software\s+engineer)|production\s+engineer(?:ing)?|build\s+engineer|release\s+engineer|kubernetes\s+(?:engineer|developer)|observability\s+engineer)/i;

const SWE_PATTERN =
  /\b(software\s+(?:engineer|developer)|software\s+development\s+engineer|\bsde\b|\bswe\b|full[-\s]?stack\s+(?:engineer|developer)|front[-\s]?end\s+(?:engineer|developer)|back[-\s]?end\s+(?:engineer|developer)|web\s+(?:engineer|developer)|applications?\s+developer|embedded\s+software(?:\s+engineer)?|software\s+architect|systems\s+software\s+engineer|distributed\s+systems\s+engineer|programmer|game\s+(?:engineer|developer|programmer)|ios\s+developer|android\s+developer|robotics\s+software\s+engineer|autonomy\s+software\s+engineer|compiler\s+engineer|graphics\s+software\s+engineer)/i;

function classifyRole(title) {
  const t = (title || '').toLowerCase();
  if (!t) return 'OTHER';

  // Early rejects — anything flagged here is NOT a CS role, even if the rest
  // of the title would otherwise match a CS pattern.
  if (NON_CS_DISCIPLINE.test(t)) return 'OTHER';
  if (RESEARCH_DISCIPLINE_SUFFIX.test(t)) return 'OTHER';
  if (STARTS_NON_CS_DISCIPLINE.test(t) && !HAS_SOFTWARE_CUE.test(t)) return 'OTHER';
  if (HARDWARE_CUE.test(t) && !HAS_SOFTWARE_CUE.test(t)) return 'OTHER';
  if (ADJACENT_NON_CS.test(t)) return 'OTHER';
  if (NON_CS_OTHER.test(t)) return 'OTHER';

  // Tighten SRE detection: `reliability engineer` alone is often hardware
  // (e.g. "Hardware Reliability Engineer"). Require "site reliability" or
  // "sre" explicitly — handled via SRE_PATTERN below (no bare reliability).

  // Most specific → least specific. Data-family before SRE-family so "Cloud
  // Data Engineer" lands as DATA_ENG rather than SRE. MLE/AI before plain
  // "Software Engineer" so "ML Software Engineer" is MLE not SWE.
  if (MLE_PATTERN.test(t)) return 'MLE';
  if (AI_PATTERN.test(t)) return 'AI';
  if (DS_PATTERN.test(t)) return 'DS';
  if (DATA_ENG_PATTERN.test(t)) return 'DATA_ENG';
  if (SECURITY_PATTERN.test(t)) return 'SECURITY';
  if (MOBILE_PATTERN.test(t)) return 'MOBILE';
  if (SRE_PATTERN.test(t)) return 'SRE';
  if (SWE_PATTERN.test(t)) return 'SWE';

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
  /\bchief\b/, // "Programs Chief Engineer", "Chief of Staff", etc.
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
function normalizeJob(raw, { filterUSOnly, filterSoftwareOnly, entryLevelMode, retentionDays } = {}) {
  const company_name = (raw.company_name || '').trim();
  const job_title = (raw.job_title || '').trim();
  const location = normalizeLocation(raw.location);
  const apply_url = (raw.apply_url || '').trim();
  const description = stripHtml(raw.description || '');
  const date_posted = parseDateToIso(raw.date_posted);

  if (!company_name || !job_title || !apply_url) return null;

  // Retention: reject rows we already know are older than the window.
  // Null-dated rows fall through here — the DB sweep prunes them later via
  // last_seen_at if they stop appearing in upstream feeds.
  if (retentionDays && date_posted) {
    const ageMs = Date.now() - new Date(date_posted).getTime();
    if (ageMs > retentionDays * 24 * 60 * 60 * 1000) return null;
  }

  const role_type = classifyRole(job_title);
  if (filterSoftwareOnly && role_type === 'OTHER') return null;
  if (filterUSOnly && !looksUS(location)) return null;
  if (!passesLevel(job_title, entryLevelMode || 'permissive')) return null;

  // A source can supply a pre-labeled sponsorship (e.g. the New-Grad-2027 repo
  // tags every posting). Trust it over the rule-based classifier when present.
  const sponsorship =
    raw.sponsorship_override && ['YES', 'NO', 'UNKNOWN'].includes(raw.sponsorship_override)
      ? raw.sponsorship_override
      : classifySponsorship(`${job_title}\n${description}`, company_name);

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
    category: classifyCategory(company_name, raw.source),
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
