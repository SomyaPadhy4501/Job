'use strict';

// Rule-based sponsorship classifier. Operates on normalized lower-case text.
// Precedence: explicit NO signals beat YES signals (an "authorized to work" line
// is usually more load-bearing than a boilerplate "we sponsor" mention).

const YES_PATTERNS = [
  /visa sponsorship/,
  /h-?1b sponsorship/,
  /h-?1b visa sponsorship/,
  /will sponsor(?:ship)?/,
  /sponsor(?: a)? visa/,
];

const NO_PATTERNS = [
  /must be authorized to work/,
  /must be legally authorized to work/,
  /no sponsorship/,
  /unable to sponsor/,
  /cannot sponsor/,
  /do(?:es)? not (?:offer|provide) (?:visa )?sponsorship/,
  /not (?:offering|providing) (?:visa )?sponsorship/,
];

function classifySponsorship(text) {
  if (!text || typeof text !== 'string') return 'UNKNOWN';
  const t = text.toLowerCase();

  for (const p of NO_PATTERNS) {
    if (p.test(t)) return 'NO';
  }
  for (const p of YES_PATTERNS) {
    if (p.test(t)) return 'YES';
  }
  return 'UNKNOWN';
}

module.exports = { classifySponsorship };
