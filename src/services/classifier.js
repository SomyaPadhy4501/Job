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

function classifySponsorship(text, companyName) {
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
  if (companyName) {
    const slug = normSlug(companyName);
    const record = getH1bCache()[slug];
    if (record && record.approvals_last_2fy >= USCIS_THRESHOLD) {
      return 'YES';
    }
  }
  // 4. Fall through
  return 'UNKNOWN';
}

module.exports = { classifySponsorship };
