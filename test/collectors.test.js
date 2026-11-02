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
const workday = require('../src/collectors/workday');
const apple = require('../src/collectors/apple');
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
  // Recent maintenance touch. Relative to now: a fixed timestamp ages out of the
  // 30-day retention window and fails the test a month after it is written.
  t_update: Math.floor(Date.now() / 1000) - 2 * 86400,
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

// ─── Rippling ─────────────────────────────────────────────────────────────────

const rippling = require('../src/collectors/rippling');

const RIPPLING_JOB = {
  uuid: '37773206-51d2-43f1-b78c-5ac5eac8abbd',
  name: 'Software Engineer',
  url: 'https://ats.rippling.com/opendoor/jobs/37773206-51d2-43f1-b78c-5ac5eac8abbd',
  department: { id: 'Engineering', label: 'Engineering' },
  workLocation: { label: 'San Francisco, CA', id: 'San Francisco, CA' },
};

const RIPPLING_DETAIL = {
  companyName: 'Opendoor',
  createdOn: '2026-06-23T13:34:02.081000-07:00',
  workLocations: ['San Francisco, CA'],
  description: {
    company: '<p>About Opendoor</p>',
    role: '<p>You will build things. Must hold an active security clearance.</p>',
  },
};

test('rippling: date_posted is null even though createdOn exists', () => {
  // createdOn is a creation date with no updated counterpart, and these boards
  // keep roles open for months. Using it dropped 21 of Opendoor's 24 open
  // software roles at the retention check — the tenant collapsed to 1 row while
  // every one of those jobs was still listed.
  const row = rippling.mapJob(RIPPLING_JOB, { slug: 'opendoor', detail: RIPPLING_DETAIL });
  assert.strictEqual(row.date_posted, null);

  const n = normalizeJob(row, {
    filterUSOnly: true,
    filterSoftwareOnly: true,
    entryLevelMode: 'permissive',
    retentionDays: 30,
  });
  assert.ok(n, 'a still-listed role must survive retention');
  assert.strictEqual(n.date_posted, null);
});

test('rippling: description joins every rich-text block, not just the role', () => {
  // `description` is an object of named blocks. `role` carries the requirements,
  // including clearance language, so taking only one block loses the restriction.
  const row = rippling.mapJob(RIPPLING_JOB, { slug: 'opendoor', detail: RIPPLING_DETAIL });
  assert.ok(row.description.includes('About Opendoor'));
  assert.ok(row.description.includes('build things'));

  const n = normalizeJob(row, { filterUSOnly: true, filterSoftwareOnly: true });
  assert.strictEqual(n.restriction, 'CLEARANCE');
});

test('rippling: buildDescription tolerates a plain string or nothing', () => {
  assert.strictEqual(rippling.buildDescription('already text'), 'already text');
  assert.strictEqual(rippling.buildDescription(null), '');
  assert.strictEqual(rippling.buildDescription({}), '');
});

test('rippling: falls back to the list workLocation and a derived apply_url', () => {
  const row = rippling.mapJob(RIPPLING_JOB, { slug: 'opendoor', displayName: 'Opendoor', detail: null });
  assert.strictEqual(row.location, 'San Francisco, CA');
  assert.strictEqual(row.company_name, 'Opendoor');
  assert.match(row.apply_url, /ats\.rippling\.com\/opendoor\/jobs\//);
});

// ─── Workday ──────────────────────────────────────────────────────────────────

// The list returns externalPath as "/job/{location}/{title}_{req}". The detail
// URL used to put another "/job" in front of it; Workday answered HTTP 406, the
// collector swallowed the error, and every Workday row (PayPal, Nvidia, Adobe…)
// shipped with an empty description. Sponsorship then came from USCIS history
// alone, so PayPal roles stating "Visa Sponsorship … is not available" showed as
// sponsored. Verified live 2026-10-31: the doubled path 406s, this one returns
// the full description.
test('workday: detail URL appends externalPath without a second /job', () => {
  const company = { tenant: 'paypal', wd: '1', site: 'jobs' };
  assert.strictEqual(
    workday.detailUrl(company, '/job/Central-Singapore-Singapore/Software-Engineer_R0137876'),
    'https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/job/Central-Singapore-Singapore/Software-Engineer_R0137876'
  );
});

// ─── Apple ────────────────────────────────────────────────────────────────────

// jobs.apple.com embeds its page data as JSON.parse("<json string>") — a JSON
// string literal holding JSON, hence the double parse. Fixture shapes are
// trimmed from real responses (2026-10-31).
const appleBlob = (obj) =>
  `<script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(obj))});</script>`;

const APPLE_RESULT = {
  id: '200678303-0836',
  positionId: '200678303',
  postingTitle: 'AI/ML Engineer: System RF Data Ecosystem',
  transformedPostingTitle: 'ai-ml-engineer-system-rf-data-ecosystem',
  postDateInGMT: '2026-10-31T04:01:36.281Z',
  jobSummary: 'Summary paragraph.',
  locations: [
    { name: 'Cupertino', city: '', stateProvince: '', countryName: 'United States of America' },
  ],
};

test('apple: reads the double-encoded page data', () => {
  const html = `<html>${appleBlob({ loaderData: { search: { searchResults: [APPLE_RESULT] } } })}</html>`;
  const data = apple.extractHydration(html);
  assert.strictEqual(data.loaderData.search.searchResults[0].id, '200678303-0836');
  assert.strictEqual(apple.extractHydration('<html>no data</html>'), null);
});

test('apple: maps a search result without network access', () => {
  const row = apple.mapPosting(APPLE_RESULT, null);
  assert.strictEqual(row.source, 'apple');
  assert.strictEqual(row.external_id, '200678303-0836');
  assert.strictEqual(row.company_name, 'Apple');
  assert.strictEqual(row.location, 'Cupertino, United States');
  assert.strictEqual(
    row.apply_url,
    'https://jobs.apple.com/en-us/details/200678303-0836/ai-ml-engineer-system-rf-data-ecosystem'
  );
  // The real timestamp, not just the day.
  assert.strictEqual(row.date_posted, '2026-10-31T04:01:36.281Z');
  // No detail fetched: falls back to the summary rather than going empty.
  assert.strictEqual(row.description, 'Summary paragraph.');
});

// The JD fields live in loaderData.jobDetails.jobsData. Reading jobDetails
// itself found none of them, every row silently kept only the marketing summary,
// and nothing errored — so experience, clearance and sponsorship wording in the
// qualifications was never seen.
test('apple: the detail description carries the qualifications from jobsData', () => {
  const html = appleBlob({
    loaderData: {
      jobDetails: {
        jobsData: {
          jobSummary: 'Intro.',
          description: 'Build things.',
          minimumQualifications: "5+ years of experience. Visa sponsorship is not available.",
          preferredQualifications: 'Swift.',
        },
        requestUrl: 'x',
      },
    },
  });
  const d = apple.jobsDataFrom(apple.extractHydration(html));
  assert.ok(d, 'jobsData must be found');
  const row = apple.mapPosting(APPLE_RESULT, d);
  assert.match(row.description, /Minimum Qualifications\n5\+ years/);
  assert.match(row.description, /Visa sponsorship is not available/);
  assert.strictEqual(normalizeJob(row)?.sponsorship, 'NO');
});

// ─── PCSX (Microsoft, Qualcomm) descriptions ─────────────────────────────────

// Search rows carry no body, so every Microsoft and Qualcomm row used to go
// through the classifiers on its title alone — sponsorship came purely from
// USCIS history. Verified live 2026-10-31: position_details returns the JD.
test('pcsx: detail URL is derived from the search URL', () => {
  const { detailBase } = require('../src/collectors/pcsx');
  assert.strictEqual(
    detailBase('https://apply.careers.microsoft.com/api/pcsx/search'),
    'https://apply.careers.microsoft.com/api/pcsx/position_details'
  );
  assert.strictEqual(
    detailBase('https://careers.qualcomm.com/api/pcsx/search'),
    'https://careers.qualcomm.com/api/pcsx/position_details'
  );
});

test('pcsx: spends detail requests only on rows the pipeline would keep, newest first', () => {
  const { pickForDetail } = require('../src/collectors/pcsx');
  const row = (id, title, location, ts) => ({ external_id: id, job_title: title, location, date_posted: ts });
  const picked = pickForDetail([
    row('1', 'Software Engineer II', 'Redmond, WA, US', 100),
    row('2', 'Principal Software Engineer', 'Redmond, WA, US', 900), // senior: rejected later anyway
    row('3', 'Software Engineer', 'Bangalore, India', 800), // not US
    row('4', 'Software Engineer', 'Seattle, WA, US', 300),
    row('5', 'Office Manager', 'Redmond, WA, US', 700), // not a software role
  ]);
  assert.deepStrictEqual(picked.map((r) => r.external_id), ['4', '1']);
});

test('pcsx: descriptions are filled in place and one failure does not lose the rest', async () => {
  const { addDescriptions } = require('../src/collectors/pcsx');
  const rows = [
    { external_id: 'a', job_title: 'Software Engineer', location: 'Redmond, WA, US', date_posted: 2, description: '' },
    { external_id: 'b', job_title: 'Software Engineer', location: 'Redmond, WA, US', date_posted: 1, description: '' },
  ];
  const calls = [];
  await addDescriptions(
    rows,
    { apiBase: 'https://apply.careers.microsoft.com/api/pcsx/search', domain: 'microsoft.com' },
    async (base, domain, id) => {
      calls.push([base, domain, id]);
      if (id === 'b') throw new Error('HTTP 429');
      return 'Visa sponsorship is not available.';
    }
  );
  assert.strictEqual(rows[0].description, 'Visa sponsorship is not available.');
  assert.strictEqual(rows[1].description, '', 'failed row stays empty');
  assert.strictEqual(calls[0][0], 'https://apply.careers.microsoft.com/api/pcsx/position_details');
});

// Workday spends at most 80 detail requests per company per run. Spending them
// on postings the pipeline rejects right after (Director, Senior Manager, …) left
// real candidates without a JD — Capital One had 92 candidates for 80 slots, a
// third of them doomed — and rows without one fall back to USCIS history alone.
test('workday: detail requests go to rows normalize would keep, newest first', () => {
  const posting = (title, postedOn, locationsText = 'Austin, Texas, United States of America') => ({
    title,
    postedOn,
    locationsText,
  });
  const picked = workday.pickCandidates([
    posting('Software Engineer', 'Posted 9 Days Ago'),
    posting('Director - AI Engineering', 'Posted 1 Day Ago'), // rejected by the level gate
    posting('Machine Learning Engineer 5 (Senior Manager, IC)', 'Posted 2 Days Ago'),
    posting('Software Engineer', 'Posted 1 Day Ago', 'Bengaluru, India'), // not US
    posting('Data Engineer 4', 'Posted 5 Days Ago'),
  ]);
  assert.deepStrictEqual(
    picked.map((j) => j.title),
    ['Machine Learning Engineer 5 (Senior Manager, IC)', 'Data Engineer 4', 'Software Engineer']
  );
});

// "Posted Today" / "Posted Yesterday" carry no number, so a parser that only
// reads "N days ago" ranks the newest postings as the oldest — the first to lose
// their JD when the cap bites.
test('workday: "Posted Today" and "Posted Yesterday" rank as newest', () => {
  assert.strictEqual(workday.postedAgeDays('Posted Today'), 0);
  assert.strictEqual(workday.postedAgeDays('Posted Yesterday'), 1);
  assert.strictEqual(workday.postedAgeDays('Posted 5 Days Ago'), 5);
  assert.strictEqual(workday.postedAgeDays('Posted 30+ Days Ago'), 30);
  const order = ['Posted 30+ Days Ago', 'Posted Yesterday', 'Posted Today', 'Posted 3 Days Ago']
    .sort((a, b) => workday.postedAgeDays(a) - workday.postedAgeDays(b));
  assert.deepStrictEqual(order, ['Posted Today', 'Posted Yesterday', 'Posted 3 Days Ago', 'Posted 30+ Days Ago']);
});

// ─── Location countries (PCSX, Getro) ─────────────────────────────────────────

const US_ONLY = { filterUSOnly: true, filterSoftwareOnly: true };
const pcsx = require('../src/collectors/pcsx');

test('pcsx: a trailing country code is read as a country, not a US state', () => {
  // Live Microsoft rows (2026-11-01): standardizedLocations ["IN"] was stored
  // as location "IN" and passed the US filter as Indiana.
  assert.deepStrictEqual(pcsx.locationOf({ standardizedLocations: ['IN'] }), { location: 'IN', countries: ['IN'] });
  assert.deepStrictEqual(
    pcsx.locationOf({ standardizedLocations: ['Herzliya, Tel Aviv District, IL'] }).countries,
    ['IL']
  );
  const row = (standardizedLocations) => ({
    source: 'microsoft', company_name: 'Microsoft', job_title: 'Software Engineer II',
    apply_url: 'https://apply.careers.microsoft.com/careers/job/1', description: '',
    ...pcsx.locationOf({ standardizedLocations }),
  });
  assert.strictEqual(normalizeJob(row(['IN']), US_ONLY), null);
  assert.strictEqual(normalizeJob(row(['Noida, Uttar Pradesh, IN']), US_ONLY), null);
  assert.strictEqual(normalizeJob(row(['Munich, BY, DE']), US_ONLY), null);
  assert.ok(normalizeJob(row(['Redmond, WA, US']), US_ONLY));
  assert.ok(normalizeJob(row(['US']), US_ONLY), 'a US-wide posting stays');
});

test('pcsx: a posting open in the US and abroad keeps only its US locations', () => {
  const { location, countries } = pcsx.locationOf({
    standardizedLocations: ['San Diego, CA, US', 'Hsinchu, Hsinchu City, TW', 'Munich, BY, DE'],
  });
  assert.strictEqual(location, 'San Diego, CA, US');
  assert.deepStrictEqual(countries, ['US', 'TW', 'DE']);
});

test('pcsx: without standardizedLocations the raw string is left to the US filter', () => {
  assert.deepStrictEqual(
    pcsx.locationOf({ locations: ['United States, Washington, Redmond'] }),
    { location: 'United States, Washington, Redmond', countries: undefined }
  );
});

test('pcsx: India rows do not spend the description budget', () => {
  // "IN" looks like Indiana to looksUS, so before countries were read these
  // took detail requests from US rows.
  const picked = pcsx.pickForDetail([
    { external_id: '1', job_title: 'Software Engineer', date_posted: 2, ...pcsx.locationOf({ standardizedLocations: ['IN'] }) },
    { external_id: '2', job_title: 'Software Engineer', date_posted: 1, ...pcsx.locationOf({ standardizedLocations: ['Redmond, WA, US'] }) },
  ]);
  assert.deepStrictEqual(picked.map((r) => r.external_id), ['2']);
});

test('getro: a state-only US entry beside cities abroad is a geocoding error', () => {
  // Live PayPal iOS role (2026-10-31): Bengaluru and Chennai, plus "Tennessee,
  // USA" — Chennai's TN (Tamil Nadu) geocoded as Tennessee.
  const details = [
    { name: 'Tennessee, USA', area_type: 'administrative_area_level_1' },
    { name: 'Bengaluru, Karnataka, India', area_type: 'locality' },
    { name: 'Chennai, Tamil Nadu, India', area_type: 'locality' },
  ];
  assert.deepStrictEqual(getro.countriesOf(details), ['India']);
  const row = getro.mapJob(
    {
      ...GETRO_JOB, title: 'Software Engineer - iOS', seniority: null,
      locations: details.map((d) => d.name), location_details: details,
    },
    'accel', null
  );
  assert.strictEqual(normalizeJob(row, US_ONLY), null);
});

test('getro: real US locations are kept, alone or beside ones abroad', () => {
  assert.deepStrictEqual(
    getro.countriesOf([
      { name: 'San Jose, CA, USA', area_type: 'locality' },
      { name: 'Bengaluru, Karnataka, India', area_type: 'locality' },
    ]),
    ['US', 'India']
  );
  // A state with no city is fine when nothing abroad is listed.
  assert.deepStrictEqual(getro.countriesOf([{ name: 'Florida, USA', area_type: 'administrative_area_level_1' }]), ['US']);
  assert.deepStrictEqual(
    getro.countriesOf([{ name: 'United States', area_type: 'country' }, { name: 'Remote', area_type: 'global' }]),
    ['US']
  );
});

test('getro: names that are not places give no country evidence', () => {
  // undefined sends normalizeJob back to the location string.
  assert.strictEqual(getro.countriesOf([{ name: 'Remote', area_type: 'global' }]), undefined);
  assert.strictEqual(getro.countriesOf([{ name: 'North America', area_type: 'continent' }]), undefined);
  assert.strictEqual(getro.countriesOf(undefined), undefined);
});

test('workday: a multi-site US posting shown as "2 Locations" still gets a description', () => {
  // Live PayPal roles (2026-11-01). The path names the primary site; the raw
  // locationsText matched no US pattern, so these were never enriched.
  const posting = (title, externalPath) => ({ title, postedOn: 'Posted 3 Days Ago', locationsText: '2 Locations', externalPath });
  const picked = workday.pickCandidates([
    posting('Software Engineer - Android', '/job/San-Jose-California-United-States-of-America/Software-Engineer---Android_R0138333'),
    posting('Software Engineer - iOS', '/job/Bangalore-Karnataka-India/Software-Engineer---iOS_R0138550-1'),
  ]);
  assert.deepStrictEqual(picked.map((j) => j.title), ['Software Engineer - Android']);
});

test('getro: "Georgia, USA" beside other countries is the country Georgia', () => {
  // Deel's "Backend Engineer Node.js + AWS" (stored 2026, deleted 2026-11-02):
  // remote across EMEA, with the country Georgia geocoded as the US state.
  const country = (name) => ({ name, area_type: 'country' });
  const deel = [
    country('Spain'),
    { name: 'Georgia, USA', area_type: 'administrative_area_level_1' },
    country('India'),
    country('Croatia'),
    country('Poland'),
  ];
  assert.deepStrictEqual(getro.countriesOf(deel), ['Spain', 'India', 'Croatia', 'Poland']);
  const row = getro.mapJob(
    { ...GETRO_JOB, title: 'Backend Engineer', seniority: null, locations: deel.map((d) => d.name), location_details: deel },
    'accel', null
  );
  assert.strictEqual(normalizeJob(row, US_ONLY), null);
});

test('getro: Georgia the state stays when nothing beside it is a country abroad', () => {
  // Live Bonterra posting (2026-11-02): US-wide plus states, and a province.
  const state = (name) => ({ name, area_type: 'administrative_area_level_1' });
  assert.deepStrictEqual(
    getro.countriesOf([
      { name: 'United States', area_type: 'country' },
      state('Illinois, USA'), state('Georgia, USA'), state('Ontario, Canada'), state('Nevada, USA'),
      { name: 'Remote', area_type: 'global' },
    ]),
    ['US', 'Canada']
  );
  // On its own, or with a US city in the state, Georgia is the state.
  assert.deepStrictEqual(getro.countriesOf([state('Georgia, USA')]), ['US']);
  assert.deepStrictEqual(
    getro.countriesOf([{ name: 'Atlanta, GA, USA', area_type: 'locality' }, { name: 'Spain', area_type: 'country' }]),
    ['US', 'Spain']
  );
});
