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
// out — see isDisqualifying(). deriveRestriction() at the bottom layers title,
// employer and no-sponsorship signals on top for rows with little or no text.
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
  /\b(?:security clearance|ts\s*\/\s*sci|top[\s-]secret|secret clearance|ts clearance|polygraph|dod clearance|sci clearance|clearance[\s-]eligible)\b/;

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
  /clearance[\s-]eligible/,
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
  // "either" and the curly quote are both real: "must either be a “U.S.
  // person” as defined by 22 C.F.R. § 120.62" (Anduril's export clause).
  /must (?:either )?be (?:a |an )?["'“]? ?us persons?/,
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
  // "U.S. Citizen or Green Card (Lawful Permanent Resident) holder only"
  /citizens? or (?:a )?green card[^.]{0,60}\bonly\b/,
  /green card holders? only\b/,
  /us citizens? (?:or|and) (?:lawful )?permanent residents? only\b/,
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

// ─── Signals beyond the description ───────────────────────────────────────────
//
// classifyRestriction() can only judge text it is given, and most rows arrive
// without any: on 2026-10-31, 1,092 of 1,200 visible defense/government rows
// had an empty description (ghlistings 653/654, Workday 186/186, BuiltIn,
// Getro). Every one of them sailed through the filter. The rules below use
// what those rows DO carry — title, employer, and a source's own label.

// A title that names the clearance is as explicit as a description that does:
// "Software Engineer - Cleared", "Software Engineer II - CTJ - Top Secret",
// "Cloud Engineer (with POLY Clearance)".
const TITLE_CLEARANCE =
  /\b(?:cleared|clearance|ts\s*\/\s*sci|top[\s-]secret|secret|polygraph|poly)\b/;
// Qualcomm: "Embedded Software Engineer (QGOV Division) - (Top Secret Clearance
// Highly Desired)" — optional, same as CLEARANCE_PREFERRED in a description.
const TITLE_CLEARANCE_OPTIONAL = /\b(?:highly desired|desired|preferred|a plus|nice to have)\b/;

// Government-programme titles. These postings almost always carry a
// citizenship or clearance bar even when the description is missing or words
// it vaguely ("Software Engineer - Federal", "Forward Deployed Engineer, US
// Government", "Software Engineer, Public Sector").
const TITLE_GOVERNMENT =
  /\b(?:federal|us government|government|public sector|defense|dod|national security|intelligence community|govcloud|fedramp)\b/;
// …but not roles ABOUT government that sit in an ordinary commercial team
// (Zipline: "Forward Deployed AI Engineer, Land Use and Government Affairs").
const TITLE_GOVERNMENT_EXCEPT = /\bgovernment (?:affairs|relations)\b/;

// Employers whose engineering roles are effectively all US-person-only (ITAR
// primes, cleared-work contractors, export-controlled space hardware).
//
// Applied ONLY when a row has no description to judge. Where text exists, the
// description classifier stays authoritative — RTX, for one, does sponsor
// specific roles ("The company will offer immigration sponsorship for this
// role"), and those must stay visible.
//
// Evidence, from rows that did carry a description on 2026-10-31: Anduril
// 376/423 restricted, SpaceX 147/147, True Anomaly 13/13, Varda 24/24,
// Saronic 18/18, Astranis 18/18, Chaos 12/12, Rocket Lab 8/8; a live sample of
// Workday postings came back restricted for KBR, Leidos, Booz Allen, Blue
// Origin, Parsons, Sierra Space and RTX. The primes (Lockheed, Northrop, GD,
// L3Harris, BAE, Boeing…) arrive with no description from every source.
//
// Deliberately NOT listed, because a meaningful share of their roles stay open
// to visa holders: Palantir, Scale AI, Shield AI (3 of 7 restricted),
// Relativity Space (0 of 9), Hermeus (0 of 7), Applied Intuition, Google,
// Microsoft. Their government roles are caught by the title rules above.
//
// Patterns run against normalizeForMatch(company_name), anchored at the start
// so "BAE Systems, Inc." and "The Boeing Company" match but a company that
// merely contains the word does not.
const RESTRICTED_EMPLOYERS = [
  /^(?:the )?boeing\b/,
  /^lockheed\b/,
  /^northrop\b/,
  /^rtx\b/,
  /^raytheon\b/,
  /^l3 ?harris\b/,
  /^general dynamics\b/,
  /^gdit\b/,
  /^bae systems\b/,
  /^huntington ingalls\b/,
  /^leidos\b/,
  /^caci\b/,
  /^saic\b/,
  /^science applications international\b/,
  /^booz allen\b/,
  /^peraton\b/,
  /^parsons\b/,
  /^kbr\b/,
  /^mantech\b/,
  /^noblis\b/,
  /^mitre\b/,
  /^(?:the )?aerospace corporation\b/,
  /^johns hopkins (?:university )?applied physics/,
  /^mit lincoln/,
  /^anduril\b/,
  /^spacex\b/,
  /^space exploration technologies\b/,
  /^blue origin\b/,
  /^sierra space\b/,
  /^rocket lab\b/,
  /^true anomaly\b/,
  /^varda\b/,
  /^saronic\b/,
  /^astranis\b/,
  /^chaos industries\b/,
  /^defense unicorns\b/,
  /^vannevar\b/,
  /^epirus\b/,
  /^castelion\b/,
];

// Shorter than this after stripping markup = "no description to judge".
// Getro and BuiltIn sometimes store a one-line teaser instead of an empty
// string.
const MIN_DESCRIPTION_CHARS = 200;

function isRestrictedEmployer(companyName) {
  const name = normalizeForMatch(companyName);
  return !!name && RESTRICTED_EMPLOYERS.some((p) => p.test(name));
}

// Full restriction verdict for a row. Precedence (first match wins):
//   1. Source-supplied label (ghlistings "U.S. Citizenship is Required")
//   2. Blocking verdict from the description           → CLEARANCE / EXPORT_CONTROL / CITIZENSHIP
//   3. Clearance named in the title                    → CLEARANCE
//   4. Government-programme title                      → GOVERNMENT
//   5. Explicit "we won't sponsor" (sponsorship = NO)  → NO_SPONSORSHIP
//   6. No description + restricted employer            → DEFENSE_EMPLOYER
//   7. Advisory verdict from the description, or ''
//
// Kept separate from classifyRestriction() so that function stays a pure
// text → verdict mapping (and its regression tests stay meaningful).
function deriveRestriction({ job_title, description, company_name, sponsorship, restriction_override } = {}) {
  if (restriction_override && DISQUALIFYING.has(restriction_override)) return restriction_override;

  const fromText = classifyRestriction(`${job_title || ''}\n${description || ''}`);
  if (DISQUALIFYING.has(fromText)) return fromText;

  const title = normalizeForMatch(job_title);
  if (TITLE_CLEARANCE.test(title) && !TITLE_CLEARANCE_OPTIONAL.test(title)) return 'CLEARANCE';
  if (TITLE_GOVERNMENT.test(title) && !TITLE_GOVERNMENT_EXCEPT.test(title)) return 'GOVERNMENT';

  if (sponsorship === 'NO') return 'NO_SPONSORSHIP';

  const bodyChars = normalizeForMatch(description).length;
  if (bodyChars < MIN_DESCRIPTION_CHARS && isRestrictedEmployer(company_name)) {
    return 'DEFENSE_EMPLOYER';
  }

  return fromText;
}

// Restrictions hidden by default. EXPORT_ADVISORY and CLEARANCE_PREFERRED are
// intentionally absent — those roles stay visible.
//
// The first three make visa sponsorship legally impossible. The rest are
// "this posting won't work for a visa holder" by the employer's statement
// (NO_SPONSORSHIP) or by strong inference (GOVERNMENT, DEFENSE_EMPLOYER). All
// stay in the DB, so ?restriction=all brings them back.
const DISQUALIFYING = new Set([
  'CLEARANCE',
  'EXPORT_CONTROL',
  'CITIZENSHIP',
  'GOVERNMENT',
  'DEFENSE_EMPLOYER',
  'NO_SPONSORSHIP',
]);

// SQL literal list for the `restriction IN (...)` filter. Built from the set so
// the two DB backends can't drift from it. Values are fixed identifiers, never
// user input.
const DISQUALIFYING_SQL = [...DISQUALIFYING].map((r) => `'${r}'`).join(', ');

function isDisqualifying(restriction) {
  return DISQUALIFYING.has(restriction);
}

module.exports = {
  classifyRestriction,
  deriveRestriction,
  isDisqualifying,
  isRestrictedEmployer,
  normalizeForMatch,
  DISQUALIFYING,
  DISQUALIFYING_SQL,
};
