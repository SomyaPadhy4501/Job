'use strict';

// Regression tests for the field mapping in the Getro / Eightfold /
// SmartRecruiters collectors.
//
// Every case below encodes a mistake that actually happened while these
// collectors were written (2026-08-13), and each has the same failure shape:
// the collector keeps reporting success while quietly producing wrong or zero
// rows. Nothing about that is visible from the outside, which is why it is
// pinned here. The fixture objects are trimmed copies of real API responses —
// don't "tidy" the snake_case/camelCase mix, it's the thing under test.

const test = require('node:test');
const assert = require('node:assert');

const getro = require('../src/collectors/getro');
const eightfold = require('../src/collectors/eightfold');
const sr = require('../src/collectors/smartrecruiters');
const { normalizeJob } = require('../src/services/normalize');

// ─── Getro ────────────────────────────────────────────────────────────────────

// Shape as returned by POST api.getro.com/api/v2/collections/{id}/search/jobs.
// The API is snake_case; the board's SSR __NEXT_DATA__ is camelCase. Reading
// `createdAt` here instead of `created_at` yields date_posted: null on every
// row, which then survives retention silently rather than erroring.
const GETRO_JOB = {
  id: 89798337,
  title: 'Staff AI Security Engineer',
  slug: '89798337-staff-ai-security-engineer',
  url: 'https://boards.greenhouse.io/addepar1/jobs/8696485002',
  created_at: 1786624648,
  seniority: 'senior',
  locations: ['United States', 'Remote'],
  location_details: [{ name: 'United States', area_type: 'country' }],
  organization: { name: 'Addepar', slug: 'addepar' },
};

test('getro: reads the snake_case API shape, not the camelCase SSR shape', () => {
  const row = getro.mapJob(GETRO_JOB, 'craft-ventures', null);
  assert.strictEqual(row.date_posted, 1786624648, 'created_at must map to date_posted');
  assert.strictEqual(row.location, 'United States, Remote');
  // The employer is the portfolio company, never the VC firm whose board it came from.
  assert.strictEqual(row.company_name, 'Addepar');
  // apply_url must be the direct ATS link, not a getro.com redirect.
  assert.match(row.apply_url, /boards\.greenhouse\.io/);
  assert.strictEqual(row.external_id, 'craft-ventures:89798337');
});

test('getro: enrichment overrides date with the precise postedAt and adds description', () => {
  const row = getro.mapJob(GETRO_JOB, 'craft-ventures', {
    description: 'We require an active TS/SCI clearance.',
    postedAt: '2026-08-13T12:37:28.183Z',
  });
  assert.strictEqual(row.date_posted, '2026-08-13T12:37:28.183Z');
  // The whole reason descriptions are fetched: restriction is classified from
  // description text only, so an un-enriched clearance role looks applicable.
  const n = normalizeJob(row, { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'off' });
  assert.strictEqual(n.restriction, 'CLEARANCE');
});

test('getro: seniority maps only at the ends of the range', () => {
  const at = (seniority) => getro.mapJob({ ...GETRO_JOB, seniority }, 'x', null);
  for (const s of ['entry_level', 'associate']) {
    assert.strictEqual(at(s).entry_level_override, 1, `${s} → entry`);
  }
  assert.strictEqual(at('mid_senior').mid_level_override, 1);
  // 'senior' and null must stay undefined so normalize's title heuristics decide —
  // Getro labels plenty of plain "Software Engineer" postings as senior.
  for (const s of ['senior', null, undefined]) {
    const row = at(s);
    assert.strictEqual(row.entry_level_override, undefined, `${s} must not force entry`);
    assert.strictEqual(row.mid_level_override, undefined, `${s} must not force mid`);
  }
});

// Getro's portfolio records keep pre-acquisition company names while the posting
// itself moved to the acquirer's ATS. Every pair below is real, from a single
// collection run, and every one landed sponsorship UNKNOWN before this existed —
// 46 Adobe roles as "Frame.io", 32 IBM roles as "Instana", and so on, against
// employers with thousands of USCIS approvals.
const ACQUIRER_URLS = [
  ['https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/x', 'adobe'],
  ['https://careers.ibm.com/job/12345/', 'ibm'],
  ['https://www.salesforce.com/company/careers/jobs/JR355789/swe', 'salesforce'],
  ['https://apply.careers.microsoft.com/careers/job/123', 'microsoft'],
  ['https://careers.oracle.com/jobs/#en/sites/jobsearch/job/123', 'oracle'],
  ['https://paypal.eightfold.ai/careers/job/123', 'paypal'],
  ['https://proofpoint.wd5.myworkdayjobs.com/external/job/x', 'proofpoint'],
  ['https://www.databricks.com/company/careers/open-positions/job/x', 'databricks'],
  ['https://careers.hpe.com/us/en/job/123', 'hpe'],
];

test('getro: derives the real employer from the apply_url host', () => {
  for (const [url, expected] of ACQUIRER_URLS) {
    assert.strictEqual(getro.employerFromApplyUrl(url), expected, url);
  }
});

test('getro: multi-tenant ATS hosts yield no employer hint', () => {
  // On these the employer is the path slug, and Getro's own company name is the
  // better signal — deriving "greenhouse" or "linkedin" would be actively wrong.
  const atsUrls = [
    'https://boards.greenhouse.io/addepar1/jobs/8696485002',
    'https://jobs.ashbyhq.com/sentilink/abc',
    'https://jobs.lever.co/palantir/xyz',
    'https://jobs.smartrecruiters.com/BoschGroup/744000143366119',
    'https://www.linkedin.com/jobs/view/12345',
    'https://ats.rippling.com/acme/jobs/1',
  ];
  for (const url of atsUrls) {
    assert.strictEqual(getro.employerFromApplyUrl(url), null, url);
  }
  assert.strictEqual(getro.employerFromApplyUrl('not a url'), null);
  assert.strictEqual(getro.employerFromApplyUrl(''), null);
});

test('getro: acquired-brand rows resolve to the acquirer for sponsorship', () => {
  // The end-to-end assertion: a posting Getro labels "Frame.io", hosted on
  // Adobe's Workday, must classify YES off Adobe's USCIS record while still
  // displaying as Frame.io.
  const row = getro.mapJob(
    {
      ...GETRO_JOB,
      title: 'Software Engineer',
      url: 'https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/x',
      organization: { name: 'Frame.io', slug: 'frame-io' },
    },
    'general-catalyst',
    null
  );
  assert.deepStrictEqual(row.sponsor_company_fallbacks, ['adobe']);

  const n = normalizeJob(row, { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'off' });
  assert.strictEqual(n.company_name, 'Frame.io', 'display name must be preserved');
  assert.strictEqual(n.sponsorship, 'YES', 'must resolve via the acquirer');
});

test('classifier: fallback keys never override an explicit NO in the text', () => {
  const { classifySponsorship } = require('../src/services/classifier');
  // Precedence must hold — a stated refusal to sponsor outranks any company
  // record, however large.
  assert.strictEqual(
    classifySponsorship('we are unable to sponsor visas for this role', 'Frame.io', ['adobe']),
    'NO'
  );
  // And with no usable key at all we stay honest rather than guessing.
  assert.strictEqual(classifySponsorship('build software', 'Frame.io', []), 'UNKNOWN');
});

// ─── Eightfold ────────────────────────────────────────────────────────────────

const EF_POSITION = {
  id: 41240606,
  name: 'Software Engineer - Cloud Platform',
  locations: ['RTP, North Carolina, USA Office (NOCAROLINA)'],
  location: 'RTP, North Carolina, USA Office (NOCAROLINA)',
  canonicalPositionUrl: 'https://netapp.eightfold.ai/careers/job/41240606',
  job_description: '',
  t_create: 1721692800, // 2024-07-23 — genuinely old posting
  t_update: 1786953600, // recent maintenance touch
};

test('eightfold: prefers t_update over t_create so long-lived postings survive retention', () => {
  const row = eightfold.mapPosition(EF_POSITION, {
    source: 'eightfold',
    slug: 'netapp',
    displayName: 'NetApp',
    title: EF_POSITION.name,
    description: 'Build cloud platform services.',
  });
  // Preferring t_create here put every Netflix/NetApp row outside the 30-day
  // retention window, and the tenants collected to exactly zero rows while
  // still reporting success.
  assert.strictEqual(row.date_posted, EF_POSITION.t_update);

  const n = normalizeJob(row, {
    filterUSOnly: true,
    filterSoftwareOnly: true,
    entryLevelMode: 'permissive',
    retentionDays: 30,
  });
  assert.ok(n, 'a maintained posting must survive the retention window');
});

test('eightfold: t_create is still used when t_update is absent', () => {
  const row = eightfold.mapPosition(
    { ...EF_POSITION, t_update: undefined },
    { source: 'eightfold', slug: 'netapp', displayName: 'NetApp', title: EF_POSITION.name }
  );
  assert.strictEqual(row.date_posted, EF_POSITION.t_create);
});

test('eightfold: netflix L-level hook flows into the level overrides', async () => {
  const netflix = require('../src/collectors/netflix');
  // L6+ is rejected inside fetchEightfold; here we pin that the hook's output
  // reaches the row, which is what the mapping is responsible for.
  const row = eightfold.mapPosition(EF_POSITION, {
    source: 'netflix',
    displayName: 'Netflix',
    title: 'Software Engineer L3 - Playback',
    lvl: { reject: false, entry: 1 },
  });
  assert.strictEqual(row.entry_level_override, 1);
  assert.strictEqual(row.source, 'netflix', 'netflix rows keep their own source');
  assert.strictEqual(typeof netflix.fetchCompany, 'function');
});

// ─── SmartRecruiters ──────────────────────────────────────────────────────────

const SR_POSTING = {
  id: '744000143366119',
  name: 'Manufacturing Engineer - Final Assembly',
  company: { identifier: 'BoschGroup', name: 'Bosch Group' },
  releasedDate: '2026-08-13T17:20:16.255Z',
  location: { city: 'Austin', region: 'TX', country: 'us', fullLocation: 'Austin, TX, United States' },
  experienceLevel: { id: 'entry_level' },
};

test('smartrecruiters: an un-enriched row still gets a working apply_url', () => {
  // detailCap must never cost a row, only its description — so the id-only
  // posting URL (verified HTTP 200, no redirect) is the fallback rather than a
  // reconstructed title slug, which is lossy.
  const row = sr.mapPosting(SR_POSTING, { slug: 'BoschGroup', displayName: 'Bosch Group', detail: null });
  assert.strictEqual(
    row.apply_url,
    'https://jobs.smartrecruiters.com/BoschGroup/744000143366119'
  );
  assert.strictEqual(row.description, '');
  assert.strictEqual(row.date_posted, SR_POSTING.releasedDate);
  assert.strictEqual(row.entry_level_override, 1);
});

test('smartrecruiters: detail applyUrl wins when present', () => {
  const row = sr.mapPosting(SR_POSTING, {
    slug: 'BoschGroup',
    detail: { applyUrl: 'https://jobs.smartrecruiters.com/BoschGroup/744000143366119-manufacturing?oga=true' },
  });
  assert.match(row.apply_url, /oga=true/);
});

test('smartrecruiters: description concatenates the sections carrying auth language', () => {
  // qualifications and additionalInformation are where clearance and
  // "must be authorized to work" clauses live. Taking only jobDescription
  // would defeat the point of fetching the detail at all.
  const detail = {
    jobAd: {
      sections: {
        companyDescription: { text: 'Bosch builds things.' },
        jobDescription: { text: 'You will write software.' },
        qualifications: { text: 'Must be a U.S. citizen due to ITAR.' },
        additionalInformation: { text: 'Relocation offered.' },
      },
    },
  };
  const row = sr.mapPosting(SR_POSTING, { slug: 'BoschGroup', detail });
  for (const fragment of ['Bosch builds things', 'write software', 'ITAR', 'Relocation']) {
    assert.ok(row.description.includes(fragment), `missing: ${fragment}`);
  }
  // Assert the restriction is *blocking*, not its exact label — which of
  // CITIZENSHIP / EXPORT_CONTROL fires depends on phrasing and is the
  // clearance classifier's business (see test/clearance.test.js). What matters
  // here is that text living in `qualifications` reaches the classifier at all.
  const { isDisqualifying } = require('../src/services/clearance');
  const n = normalizeJob({ ...row, job_title: 'Software Engineer' }, { filterUSOnly: true });
  assert.ok(isDisqualifying(n.restriction), `expected a blocking restriction, got ${n.restriction}`);
});

test('smartrecruiters: buildLocation falls back when fullLocation is absent', () => {
  assert.strictEqual(
    sr.buildLocation({ city: 'Austin', region: 'TX', country: 'us' }),
    'Austin, TX, US'
  );
  assert.strictEqual(sr.buildLocation({ remote: true }), 'Remote');
  assert.strictEqual(
    sr.buildLocation({ city: 'Austin', region: 'TX', country: 'us', remote: true }),
    'Austin, TX, US, Remote'
  );
  assert.strictEqual(sr.buildLocation(null), '');
});

test('smartrecruiters: experienceLevel maps only at the ends of the range', () => {
  const at = (id) => sr.mapPosting({ ...SR_POSTING, experienceLevel: { id } }, { slug: 'x', detail: null });
  assert.strictEqual(at('associate').entry_level_override, 1);
  assert.strictEqual(at('mid_senior_level').mid_level_override, 1);
  for (const id of ['not_applicable', undefined]) {
    assert.strictEqual(at(id).entry_level_override, undefined);
    assert.strictEqual(at(id).mid_level_override, undefined);
  }
});

// ─── Cross-collector invariants ───────────────────────────────────────────────

test('every new collector is registered and exposes the collector contract', () => {
  const { REGISTRY } = require('../src/collectors');
  for (const source of ['getro', 'eightfold', 'smartrecruiters']) {
    assert.ok(REGISTRY[source], `${source} missing from the registry`);
    assert.strictEqual(typeof REGISTRY[source].fetchCompany, 'function');
    assert.strictEqual(REGISTRY[source].source, source);
  }
});

test('config entries for the new sources carry their required fields', () => {
  const { COMPANIES } = require('../src/config');
  // A missing networkId/apiBase throws at fetch time inside a try/catch in
  // collect.js, so the entry would just log a warning forever.
  for (const c of COMPANIES.filter((x) => x.source === 'getro')) {
    assert.ok(c.networkId, `getro ${c.slug} missing networkId`);
    assert.ok(c.boardHost, `getro ${c.slug} missing boardHost`);
  }
  for (const c of COMPANIES.filter((x) => x.source === 'eightfold')) {
    assert.ok(c.apiBase, `eightfold ${c.slug} missing apiBase`);
    assert.ok(c.domain, `eightfold ${c.slug} missing domain`);
  }
  for (const c of COMPANIES.filter((x) => x.source === 'smartrecruiters')) {
    assert.ok(c.slug, 'smartrecruiters entry missing slug');
  }
});
