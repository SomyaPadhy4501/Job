'use strict';

// Slug guessing shared by the ATS discovery probes (probe-smartrecruiters.js,
// probe-ats.js). USCIS petitioner names are close to an ATS slug once the
// corporate suffixes come off; these helpers produce the likely variants.

// Corporate and staffing-agency suffixes that appear in USCIS petitioner names
// but never in an ATS slug. Order matters — longest first, so
// 'technology-solutions-us' is stripped before 'us'.
const SUFFIXES = [
  'technology-solutions-us', 'technology-solutions', 'consultancy-svcs',
  'global-services', 'business-services', 'services-inc', 'americas', 'america',
  'us-llp', 'usa-inc', 'usa', 'llp', 'llc', 'inc', 'ltd', 'limited', 'corp',
  'corporation', 'company', 'co', 'plc', 'lp', 'pc', 'group', 'holdings',
  'technologies', 'technology', 'tech', 'systems', 'solutions', 'software',
  'labs', 'associates', 'partners', 'consulting', 'international', 'us',
];

function stripSuffixes(key) {
  let parts = key.split('-').filter(Boolean);
  let changed = true;
  while (changed && parts.length > 1) {
    changed = false;
    for (const suf of SUFFIXES) {
      const sufParts = suf.split('-');
      if (sufParts.length >= parts.length) continue;
      const tail = parts.slice(-sufParts.length).join('-');
      if (tail === suf) {
        parts = parts.slice(0, -sufParts.length);
        changed = true;
        break;
      }
    }
  }
  return parts;
}

// Slug candidates for one normalized USCIS petitioner key, most-likely first.
// Deduped, so a single-word company only costs one request.
function slugCandidates(key) {
  const core = stripSuffixes(key);
  const joined = core.join('');
  const hyphen = core.join('-');
  const out = [joined, hyphen, key.replace(/-/g, ''), key];
  if (core.length > 1) out.push(core[0]);            // 'bosch' from 'bosch-group'
  if (core.length >= 1) out.push(`${joined}group`);  // 'boschgroup' from 'bosch'
  return [...new Set(out.filter((s) => s && s.length >= 3))];
}

module.exports = { SUFFIXES, stripSuffixes, slugCandidates };
