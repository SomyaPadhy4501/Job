'use strict';

// The USCIS H-1B lookup behind sponsorship = YES, and the script that builds it.
//
// The data half pins employers by name. A sponsor that drops out of
// h1b-sponsors.json doesn't fail loudly: its jobs read UNKNOWN and vanish from
// the board's default view. If a refresh breaks one of these, find the
// employer's new legal name in the hub before deleting the case.

const test = require('node:test');
const assert = require('node:assert');
const { classifySponsorship, normSlug } = require('../src/services/classifier');
const { readExport, buildSponsors } = require('../scripts/refresh-h1b-data');
const SPONSORS = require('../src/data/h1b-sponsors.json');

// No sponsorship words at all, so the verdict comes from the lookup alone.
const NEUTRAL = 'software engineer';

// ─── Lookup data ──────────────────────────────────────────────────────────────

test('employers that began sponsoring after FY2023 resolve as sponsors', () => {
  // Absent from the FY2022–23 files, so every one of their jobs read UNKNOWN.
  for (const company of [
    'xAI',
    'X.AI',
    'OpenAI',
    'Notion',
    'Notion Labs',
    'Harvey',
    'Counsel AI', // Harvey's legal name in its FY2025 filings
    'Cursor',
    'Anysphere',
    'Perplexity',
    'Perplexity AI',
    'ElevenLabs',
    'Mistral AI',
  ]) {
    assert.strictEqual(classifySponsorship(NEUTRAL, company), 'YES', company);
  }
});

test("today's big sponsors still resolve", () => {
  for (const company of [
    'Amazon',
    'Google',
    'Microsoft',
    'Meta',
    'Apple',
    'NVIDIA',
    'Tesla',
    'Salesforce',
    'Goldman Sachs',
    'Capital One',
    'American Express',
    'Stripe',
    'Databricks',
    'Anthropic',
  ]) {
    assert.strictEqual(classifySponsorship(NEUTRAL, company), 'YES', company);
  }
});

test('employers that changed legal name between FY2023 and FY2025 keep resolving', () => {
  for (const company of [
    'Atlassian', // ATLASSIAN US INC
    'DraftKings', // DK CROWN HOLDINGS INC
    'Motive', // MOTIVE TECHNOLOGIES INC
    'Keep Truckin',
    'Anthem', // ELEVANCE HEALTH INC
    'Mercer University', // THE CORPORATION OF MERCER UNIVERSITY
    'Deel', // DEEL US INC
    'Clover Health',
    // The hub hyphenates these; postings usually don't.
    'Bristol Myers Squibb',
    'Bristol-Myers Squibb',
    'Embry Riddle Aeronautical University',
    'Embry-Riddle Aeronautical University',
  ]) {
    assert.strictEqual(classifySponsorship(NEUTRAL, company), 'YES', company);
  }
});

test('the lookup carries current fiscal years', () => {
  for (const slug of ['amazon', 'google', 'xai', 'openai']) {
    assert.ok(SPONSORS[slug].latest_fy >= 2025, `${slug}: FY${SPONSORS[slug].latest_fy}`);
  }
});

test('a description still outranks the lookup', () => {
  assert.strictEqual(classifySponsorship('we are unable to sponsor visas', 'OpenAI'), 'NO');
  assert.strictEqual(classifySponsorship(NEUTRAL, 'An Employer With No Filings'), 'UNKNOWN');
});

// ─── refresh-h1b-data.js ─────────────────────────────────────────────────────

// The hub's crosstab export, trimmed: long format, one row per employer
// location and measure, the fiscal-year header padded with spaces.
const HEADER =
  'Employer (Petitioner) Name,Fiscal Year   ,Industry (NAICS) Code,Measure Names,Petitioner City,Petitioner State,Petitioner Zip Code,Tax ID,Line by line,Measure Values';
function exportCsv(fy, rows) {
  return [HEADER, ...rows.map(([name, measure, value, city = 'SAN FRANCISCO']) =>
    [name.includes(',') ? `"${name}"` : name, fy, '54', measure, city, 'CA', '94110', '1234', '1', value].join(','),
  )].join('\r\n') + '\r\n';
}
// Feed the text in small pieces so quoted fields straddle chunk boundaries.
function chunked(text, size = 7) {
  const buf = Buffer.from(text);
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

test('readExport sums the six approval measures and skips denials', async () => {
  const csv = exportCsv(2026, [
    ['ANYSPHERE, INC.', 'New Employment Approval', '20'],
    ['ANYSPHERE, INC.', 'New Employment Denial', '9'],
    ['ANYSPHERE, INC.', 'Continuation Approval', '3'],
    ['ANYSPHERE, INC.', 'Change of Employer Approval', '8', 'NEW YORK'], // second location
    ['ANYSPHERE, INC.', 'Amended Approval', '"1,203"'],
    ['NOTION LABS INC', 'New Concurrent Approval', '0'],
    ['', 'Change with Same Employer Approval', '1'], // withheld name
  ]);
  const totals = await readExport(chunked(csv), 2026);
  assert.deepStrictEqual([...totals], [['ANYSPHERE, INC.', 20 + 3 + 8 + 1203]]);
});

test('readExport rejects an export whose year filter was ignored', async () => {
  // Tableau answers "?Fiscal Year=2025" (no padding) with the default year.
  const csv = exportCsv(2026, [['GOOGLE LLC', 'New Employment Approval', '5']]);
  await assert.rejects(readExport(chunked(csv), 2025), /asked for FY2025/);
});

test('readExport reads an unpublished year as empty', async () => {
  assert.strictEqual((await readExport([Buffer.from('\n')], 2027)).size, 0);
});

test('buildSponsors slugs with the classifier and adds brand and spaced keys', () => {
  const sponsors = buildSponsors([
    { fy: 2025, totals: new Map([['COUNSEL AI CORPORATION', 14], ['BRISTOL-MYERS SQUIBB COMPANY', 200]]) },
    { fy: 2026, totals: new Map([['HARVEY AI CORPORATION', 31], ['C-VISION INC', 4], ['AMAZON.COM SERVICES LLC', 9]]) },
  ]);
  // Legal names keep their own keys, and the brand sums both filers.
  assert.deepStrictEqual(sponsors['counsel-ai-corporation'], { approvals_last_2fy: 14, latest_fy: 2025 });
  assert.deepStrictEqual(sponsors['harvey'], { approvals_last_2fy: 45, latest_fy: 2026 });
  // Both spellings of a hyphenated name, as normSlug reads each.
  assert.strictEqual(sponsors[normSlug('Bristol-Myers Squibb Company')].approvals_last_2fy, 200);
  assert.strictEqual(sponsors[normSlug('Bristol Myers Squibb Company')].approvals_last_2fy, 200);
  // A spaced spelling that shrinks to one generic word is not indexed.
  assert.ok(sponsors.cvision);
  assert.strictEqual(sponsors.vision, undefined);
  assert.strictEqual(sponsors.amazon.approvals_last_2fy, 9);
  assert.deepStrictEqual(Object.keys(sponsors), Object.keys(sponsors).sort());
});
