'use strict';

// Rule-based work-authorization restriction classifier.
//
// Detects postings a candidate needing visa sponsorship cannot take, regardless
// of whether the employer sponsors H-1Bs in general. A US security clearance
// requires US citizenship; ITAR/EAR "U.S. person" status requires citizenship or
// a green card. Neither is reachable on OPT or H-1B.
//
// Precedence (first match wins):
//   1. Hard clearance requirement           → CLEARANCE            (blocking)
//   2. ITAR / export-control US-person req. → EXPORT_CONTROL       (blocking)
//   3. Explicit US citizenship requirement  → CITIZENSHIP          (blocking)
//   4. Export control named, not required   → EXPORT_ADVISORY      (advisory)
//   5. Clearance named, not required        → CLEARANCE_PREFERRED  (advisory)
//   6. Otherwise                            → ''
//
// Only 1–3 disqualify. 4–5 are surfaced as badges but deliberately NOT filtered
// out — see isDisqualifying().
//
// Returns '' (never null) so the DB column stays NOT NULL and the frontend can
// treat falsy as "no badge" — same convention as category.js.
//
// No LLM / no API — pure regex.

// ─── Text normalization ───────────────────────────────────────────────────────

// stripHtml() in normalize.js decodes entities AFTER stripping tags, so
// entity-encoded HTML (Greenhouse returns `&lt;p&gt;`) is reconstituted into
// live markup — 616 stored descriptions currently contain literal <p>/<li>.
// Markup landing mid-phrase defeats these patterns, so normalize independently
// here: strip → decode → strip again.
//
// "U.S." is also folded to "us". Without that, every bounded [^.]{0,N} gap dies
// on the periods inside the abbreviation — the single most common way these
// patterns silently fail to match.
function normalizeForMatch(s) {
  if (!s) return '';
  let t = String(s);
  for (let i = 0; i < 2; i++) {
    t = t
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&nbsp;/gi, ' ')
      // Dashes must become a real hyphen, not whitespace: the generic entity
      // strip below would turn "8&ndash;10 years" into "8 10 years", which
      // reads as two separate numbers instead of a range.
      .replace(/&[mn]dash;/gi, '-')
      .replace(/&#8211;|&#8212;/g, '-')
      .replace(/&#\d+;/g, ' ')
      .replace(/&[a-z]+;/gi, ' ');
  }
  t = t.replace(/<[^>]+>/g, ' ').toLowerCase();
  t = t
    .replace(/\bu\.\s?s\.\s?a?\.?/g, ' us ')
    .replace(/\bunited states( of america)?\b/g, ' us ');
  return t.replace(/\s+/g, ' ').trim();
}

// ─── Clearance ────────────────────────────────────────────────────────────────

// Word-boundary anchored. An unbounded /itar/ matches the "itar" inside
// "m-ilitar-y", which appears in the EEO boilerplate of 237 postings here
// ("discharge status from the military") — 245 naive hits vs 8 real ones.
const CLEARANCE_TERMS =
  /\b(?:security clearance|ts\s*\/\s*sci|top[\s-]secret|secret clearance|polygraph|dod clearance|sci clearance)\b/;

// Requirement-bound phrasings. "Eligible/able to obtain" is deliberately in the
// REQUIRED set: clearance eligibility itself requires US citizenship, so it
// blocks a sponsorship candidate exactly as hard as already holding one
// (Anduril: "Eligible to obtain and maintain an active U.S. Secret clearance").
const CLEARANCE_REQUIRED = [
  /(?:active|current|existing|valid)[^.]{0,40}(?:security )?clearance/,
  /clearance[^.]{0,30}(?:is |are )?(?:required|mandatory)/,
  /(?:must|required to|will need to|need to)[^.]{0,60}clearance/,
  /(?:possess|hold|holds|holding|maintain|obtain)[^.]{0,40}clearance/,
  /(?:eligible|ability|able|willing)[^.]{0,20}to obtain[^.]{0,60}clearance/,
  /requires?[^.]{0,60}clearance/,
  /eligibility for[^.]{0,40}clearance/,
  /\bts\s*\/\s*sci\b/,
  /\bpolygraph\b/,
];

// Optional / "nice to have". Checked only after CLEARANCE_REQUIRED, so a posting
// demanding an active clearance AND listing a higher tier as preferred still
// classifies as blocking.
const CLEARANCE_PREFERRED_PATTERNS = [
  /clearance[^.]{0,30}(?:is |are )?(?:a )?(?:plus|preferred|desired|bonus|nice[\s-]to[\s-]have|advantage)/,
  /(?:preferred|desired|bonus|plus|nice[\s-]to[\s-]have|highly desired)[^.]{0,40}clearance/,
];

// ─── ITAR / export control ────────────────────────────────────────────────────

// Only phrasings that impose eligibility ON THE PERSON. The bare phrase "export
// control" is NOT enough and must never appear here: 15 postings carry
// export-control boilerplate that imposes no personal requirement — Databricks
// ("it is within Employer's discretion whether to apply for a license"),
// Cloudflare ("this position may require access... may be conditioned"). Both
// are prolific H-1B sponsors; hiding them would be a false negative, the most
// costly error for a sponsorship-seeking candidate.
//
// Likewise a bare /\bitar\b/ is too weak — it matches Saronic's "(e.x ITAR,
// FedRAMP)", which lists compliance frameworks the engineer works with rather
// than an eligibility bar.
const US_PERSON_REQUIRED = [
  /\bitar requirements?\b/,
  /subject to itar\b/,
  /must be (?:a |an )?us person/,
  /us person["'”]? status is (?:required|needed)/,
  /require[sd]?[^.]{0,80}["'“]?us person/,
];

// Export control named without any personal eligibility bar. Advisory only.
const EXPORT_ADVISORY_PATTERN = /export[\s-]control/;

// ─── Citizenship ──────────────────────────────────────────────────────────────

// Verb-anchored only. Bare "citizenship" is EEO boilerplate — "regardless of
// race, color, ancestry, religion, sex, national origin, ... citizenship,
// marital status, disability, ... veteran status" appears in ~105 postings and
// imposes nothing.
const CITIZENSHIP_PATTERNS = [
  /(?:candidates?|applicants?|employees?|you|individuals?) must be (?:a |an )?us (?:citizen|national|person)/,
  /must be (?:a |an )?us citizen/,
  /requires? that the (?:candidate|applicant|person|individual)[^.]{0,50}be (?:a |an )?us citizen/,
  /us citizenship (?:is )?(?:required|mandatory)/,
  /\bus citizens? only\b/,
  /restricted to us citizens/,
  /proof of us citizenship/,
];

function classifyRestriction(text) {
  if (!text || typeof text !== 'string') return '';
  const t = normalizeForMatch(text);
  if (!t) return '';

  // 1. Hard clearance requirement. Both a clearance noun and requirement
  //    phrasing must be present, so "we handle top-secret customer data" in a
  //    product blurb doesn't trip it.
  if (CLEARANCE_TERMS.test(t)) {
    for (const p of CLEARANCE_REQUIRED) {
      if (p.test(t)) return 'CLEARANCE';
    }
  }

  // 2. ITAR / export control that restricts who may hold the role.
  const usPersonReq = US_PERSON_REQUIRED.some((p) => p.test(t));
  const citizenReq = CITIZENSHIP_PATTERNS.some((p) => p.test(t));
  const exportFraming = EXPORT_ADVISORY_PATTERN.test(t);

  // A citizenship bar stated *because of* export law is reported as
  // EXPORT_CONTROL — it's the more accurate reason, and it tells the reader the
  // bar is statutory rather than a company preference. Amazon: "Due to
  // applicable export control laws and regulations, candidates must be a U.S.
  // citizen or national, U.S. permanent resident..."
  if (usPersonReq || (exportFraming && citizenReq)) return 'EXPORT_CONTROL';

  // 3. Explicit citizenship requirement with no export-control framing.
  if (citizenReq) return 'CITIZENSHIP';

  // 4. Export control mentioned but imposing nothing on the candidate.
  if (exportFraming) return 'EXPORT_ADVISORY';

  // 5. Clearance named but not required.
  if (CLEARANCE_TERMS.test(t)) {
    for (const p of CLEARANCE_PREFERRED_PATTERNS) {
      if (p.test(t)) return 'CLEARANCE_PREFERRED';
    }
  }

  return '';
}

// Restrictions that make visa sponsorship legally impossible. EXPORT_ADVISORY
// and CLEARANCE_PREFERRED are intentionally absent — those roles stay visible.
const DISQUALIFYING = new Set(['CLEARANCE', 'EXPORT_CONTROL', 'CITIZENSHIP']);

function isDisqualifying(restriction) {
  return DISQUALIFYING.has(restriction);
}

module.exports = {
  classifyRestriction,
  isDisqualifying,
  normalizeForMatch,
  DISQUALIFYING,
};
