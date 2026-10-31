'use strict';

const { CONFIG } = require('../config');

// Generic collector for community job lists published as markdown tables —
// speedyapply/2026-SWE-College-Jobs is the first consumer. Its data lives in a
// private Supabase, so the rendered README table is the only public output.
//
// Row shape (Salary column present in some sections, absent in others):
//   | <a href="https://co.com"><strong>Co</strong></a> | Title | City, ST +2 | $150k/yr | <a href="APPLY"><img alt="Apply"…></a> | 3d |
//
// Cells are located by content rather than position — the Apply cell is the one
// with alt="Apply", the age is the last cell — so a section with or without a
// Salary column parses the same way.
//
// Like ghlistings, these rows carry no description, so sponsorship comes from
// the USCIS company lookup and restriction from the title / employer rules.
//
// Config shape:
//   { source: 'mdtable', slug, displayName, url, entryLevel }

const ROW = /^\|(.+)\|\s*$/;
const HREF = /href="([^"]+)"/;
const AGE = /^(\d+)\s*([dhwm])$/i;
const AGE_MS = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000 };

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'job-aggregator/1.0', Accept: 'text/plain' },
    signal: AbortSignal.timeout(CONFIG.requestTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/\*\*/g, '').trim();
}

// "3d" → ISO date, relative to `now`. Unknown formats → null (first-seen stamp).
// Day-sized ages are truncated to the start of that UTC day: "0d" only says
// "today", and stamping the collect run's exact time made these rows read as
// posted minutes ago and sort above genuinely fresh postings.
function ageToIso(age, now = Date.now()) {
  const m = String(age || '').trim().match(AGE);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const d = new Date(now - Number(m[1]) * AGE_MS[unit]);
  if (unit !== 'h') d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function parseRow(line, now) {
  const m = line.match(ROW);
  if (!m) return null;
  const cells = m[1].split(' | ').map((c) => c.trim());
  if (cells.length < 4) return null;

  const applyCell = cells.find((c) => /alt="apply"/i.test(c));
  const apply = applyCell && (applyCell.match(HREF) || [])[1];
  if (!apply) return null; // header, separator, or closed posting (no link)

  return {
    company_name: stripTags(cells[0]),
    job_title: stripTags(cells[1]),
    // "Newark, NJ +2" — the "+N other locations" suffix would only confuse
    // looksUS(); the first location is the useful part.
    location: stripTags(cells[2]).replace(/\s*\+\d+\s*$/, ''),
    apply_url: apply,
    date_posted: ageToIso(cells[cells.length - 1], now),
  };
}

function parseTable(markdown, now = Date.now()) {
  const out = [];
  for (const line of String(markdown || '').split('\n')) {
    const row = parseRow(line, now);
    if (row && row.company_name && row.job_title) out.push(row);
  }
  return out;
}

async function fetchCompany({ url, slug, entryLevel = true }) {
  if (!url) throw new Error(`mdtable entry "${slug}" missing url`);
  const rows = parseTable(await fetchText(url));
  return rows.map((r) => ({
    source: 'mdtable',
    external_id: `${slug}:${r.apply_url}`,
    ...r,
    description: '',
    entry_level_override: entryLevel ? 1 : undefined,
  }));
}

module.exports = { fetchCompany, parseTable, ageToIso, source: 'mdtable' };
