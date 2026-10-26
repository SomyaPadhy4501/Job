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
  // Recent edit, relative to now so the case doesn't drift with the calendar.
  t_update: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
};

test('eightfold: dates by t_create, so an old posting with a recent edit ages out', () => {
  const row = eightfold.mapPosition(EF_POSITION, {
    source: 'eightfold',
    slug: 'netapp',
    displayName: 'NetApp',
    title: EF_POSITION.name,
    description: 'Build cloud platform services.',
  });
  // t_update moves on any edit. Preferring it kept months-old Netflix and
  // NetApp postings on the board as if they were new.
  assert.strictEqual(row.date_posted, EF_POSITION.t_create);

  const n = normalizeJob(row, {
    filterUSOnly: true,
    filterSoftwareOnly: true,
    entryLevelMode: 'permissive',
    retentionDays: 30,
  });
  assert.strictEqual(n, null, 'a 2024 posting must not pass the 30-day window');
});

test('eightfold: t_update is still used when t_create is absent', () => {
  const row = eightfold.mapPosition(
    { ...EF_POSITION, t_create: undefined },
    { source: 'eightfold', slug: 'netapp', displayName: 'NetApp', title: EF_POSITION.name }
  );
  assert.strictEqual(row.date_posted, EF_POSITION.t_update);
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

// ─── Greenhouse ───────────────────────────────────────────────────────────────

const greenhouse = require('../src/collectors/greenhouse');

// Trimmed from boards-api.greenhouse.io/v1/boards/andurilindustries/jobs on
// 2026-10-26. The whole board shared that morning's updated_at; the posting
// itself went up 14 months earlier.
const GH_JOB = {
  id: 4802146007,
  title: '2026 Early Career Software Engineer',
  absolute_url: 'https://boards.greenhouse.io/andurilindustries/jobs/4802146007?gh_jid=4802146007',
  location: { name: 'Costa Mesa, California, United States' },
  updated_at: '2026-10-26T12:17:25-04:00',
  first_published: '2025-08-11T13:40:49-04:00',
  content: '&lt;p&gt;Build software for autonomous systems.&lt;/p&gt;',
};

test('greenhouse: dates a posting by first_published, not updated_at', () => {
  const row = greenhouse.mapJob(GH_JOB, { slug: 'andurilindustries', displayName: 'Anduril Industries' });
  assert.strictEqual(row.date_posted, '2025-08-11T13:40:49-04:00');
  assert.strictEqual(row.company_name, 'Anduril Industries');
  // Read by updated_at this row looked a few hours old. By its real date it is
  // far outside retention and must not reach the board.
  const n = normalizeJob(row, {
    filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'permissive', retentionDays: 30,
  });
  assert.strictEqual(n, null);
});

test('greenhouse: falls back to updated_at only when first_published is missing', () => {
  const { first_published, ...noFirst } = GH_JOB;
  assert.strictEqual(greenhouse.mapJob(noFirst, { slug: 'x' }).date_posted, '2026-10-26T12:17:25-04:00');
  assert.strictEqual(greenhouse.mapJob({ id: 1 }, { slug: 'x' }).date_posted, null);
});

// ─── Workday ──────────────────────────────────────────────────────────────────

const workday = require('../src/collectors/workday');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (iso) => Math.round((Date.now() - new Date(iso).getTime()) / DAY_MS);

test('workday: every postedOn phrasing gets a date', () => {
  // The four forms Nvidia, Adobe and PayPal return (2026-10-26). Only "N Days
  // Ago" used to parse; today's postings came back null and sorted last.
  assert.strictEqual(daysAgo(workday.parsePostedOn('Posted Today')), 0);
  assert.strictEqual(daysAgo(workday.parsePostedOn('Posted Yesterday')), 1);
  assert.strictEqual(daysAgo(workday.parsePostedOn('Posted 3 Days Ago')), 3);
  assert.strictEqual(workday.parsePostedOn(''), null);
  assert.strictEqual(workday.parsePostedOn('Posted recently'), null);
});

test('workday: "30+ Days Ago" falls outside a 30-day window', () => {
  // A null date skipped the retention check, so these stayed on the board.
  const date_posted = workday.parsePostedOn('Posted 30+ Days Ago');
  assert.strictEqual(daysAgo(date_posted), 31);
  const n = normalizeJob(
    {
      source: 'workday', external_id: 'JR2005011', company_name: 'Nvidia',
      job_title: 'Software Engineer', location: 'Santa Clara, CA',
      apply_url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x',
      description: '', date_posted,
    },
    { filterUSOnly: true, filterSoftwareOnly: true, retentionDays: 30 }
  );
  assert.strictEqual(n, null);
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

test('rippling: dates by createdOn, so a months-old role ages out', () => {
  // Null used to keep Opendoor's long-open roles on the board as if new.
  const row = rippling.mapJob(RIPPLING_JOB, { slug: 'opendoor', detail: RIPPLING_DETAIL });
  assert.strictEqual(row.date_posted, RIPPLING_DETAIL.createdOn);

  const n = normalizeJob(row, {
    filterUSOnly: true,
    filterSoftwareOnly: true,
    entryLevelMode: 'permissive',
    retentionDays: 30,
  });
  assert.strictEqual(n, null, 'a role created 2026-06-23 must not pass the 30-day window');

  // Without a detail record there's no date to read.
  assert.strictEqual(rippling.mapJob(RIPPLING_JOB, { slug: 'opendoor' }).date_posted, null);
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

// ─── JSearch ──────────────────────────────────────────────────────────────────

const jsearch = require('../src/collectors/jsearch');
const { COMPANIES, SCHEDULED_COMPANIES } = require('../src/config');

// Unlike the fixtures above, this is NOT a trimmed real response: no API key
// existed when the collector was written (2026-10-21). It follows the documented
// search-v2 job schema. Replace it with a trimmed real response once one exists.
const JS_TESLA = {
  job_id: 'abc123==',
  employer_name: 'Tesla',
  job_publisher: 'LinkedIn',
  job_title: 'Software Engineer, Inference Infrastructure',
  job_apply_link: 'https://www.linkedin.com/jobs/view/4000000000',
  job_apply_is_direct: false,
  apply_options: [
    { publisher: 'LinkedIn', apply_link: 'https://www.linkedin.com/jobs/view/4000000000', is_direct: false },
    {
      publisher: 'Tesla',
      apply_link:
        'https://www.tesla.com/careers/search/job/software-engineer-inference-infrastructure-222387' +
        '?utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic',
      is_direct: true,
    },
  ],
  job_description: 'Own the systems that power model development. 2+ years of experience with Python.',
  job_posted_at_datetime_utc: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  job_city: 'Palo Alto',
  job_state: 'CA',
  job_country: 'US',
};
const JS_OPTS = { slug: 'tesla', displayName: 'Tesla', employer: 'Tesla', applyHost: 'tesla.com' };

test('jsearch: keeps the employer apply link from apply_options, minus utm tracking', () => {
  // Google lists the LinkedIn repost as the primary link here. Taking
  // job_apply_link blindly would put LinkedIn on the board.
  const row = jsearch.mapJob(JS_TESLA, JS_OPTS);
  assert.strictEqual(
    row.apply_url,
    'https://www.tesla.com/careers/search/job/software-engineer-inference-infrastructure-222387'
  );
  assert.strictEqual(row.location, 'Palo Alto, CA, US');
  assert.strictEqual(row.company_name, 'Tesla');

  const n = normalizeJob(row, { filterUSOnly: true, filterSoftwareOnly: true, retentionDays: 30 });
  assert.ok(n, 'a fresh US software posting must survive normalize');
  assert.strictEqual(n.yoe_min, 2);
});

test('jsearch: drops reposts with no employer link, agency listings and lookalike hosts', () => {
  const repostOnly = { ...JS_TESLA, apply_options: [JS_TESLA.apply_options[0]] };
  assert.strictEqual(jsearch.mapJob(repostOnly, JS_OPTS), null);

  // An agency deep-linking into tesla.com is still not Tesla's listing.
  assert.strictEqual(jsearch.mapJob({ ...JS_TESLA, employer_name: 'Acme Staffing' }, JS_OPTS), null);

  for (const host of ['https://notesla.com/job/1', 'https://tesla.com.example.net/job/1']) {
    const lookalike = { ...JS_TESLA, job_apply_link: host, apply_options: [] };
    assert.strictEqual(jsearch.mapJob(lookalike, JS_OPTS), null, host);
  }
});

test('jsearch: reads both the search-v2 and the older response shapes', () => {
  assert.strictEqual(jsearch.jobsFrom({ data: { jobs: [JS_TESLA], cursor: null } }).length, 1);
  assert.strictEqual(jsearch.jobsFrom({ data: [JS_TESLA] }).length, 1);
  assert.deepStrictEqual(jsearch.jobsFrom({ status: 'ERROR' }), []);
});

// Stubs global fetch and records every call, so the request budget is pinned:
// the free plan is 200 requests/month and every page is billed.
async function withFetch(respond, fn) {
  const realFetch = global.fetch;
  const realKey = process.env.JSEARCH_API_KEY;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: new URL(url), headers: init.headers });
    return respond(calls.length);
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.JSEARCH_API_KEY;
    else process.env.JSEARCH_API_KEY = realKey;
  }
}
const ok = (payload) => ({ status: 200, ok: true, json: async () => payload });

test('jsearch: one page per query, at most MAX_QUERIES queries, last 3 days only', async () => {
  await withFetch(() => ok({ data: { jobs: [JS_TESLA] } }), async (calls) => {
    process.env.JSEARCH_API_KEY = 'test-key';
    const queries = ['a', 'b', 'c', 'd', 'e', 'f'];
    const rows = await jsearch.fetchCompany({ ...JS_OPTS, queries });

    assert.strictEqual(calls.length, jsearch.MAX_QUERIES);
    assert.ok(jsearch.MAX_QUERIES * 31 <= 200, 'a month of daily runs must fit the free plan');
    for (const c of calls) {
      assert.strictEqual(c.url.hostname, 'jsearch.p.rapidapi.com');
      assert.strictEqual(c.url.pathname, '/search-v2');
      assert.strictEqual(c.url.searchParams.get('num_pages'), '1');
      assert.strictEqual(c.url.searchParams.get('date_posted'), '3days');
      assert.strictEqual(c.url.searchParams.get('country'), 'us');
      assert.strictEqual(c.headers['x-rapidapi-key'], 'test-key');
    }
    // The same posting from four queries is one row.
    assert.strictEqual(rows.length, 1);
  });
});

test('jsearch: no key means no requests, and a failed first query is not retried', async () => {
  await withFetch(() => ok({ data: { jobs: [] } }), async (calls) => {
    delete process.env.JSEARCH_API_KEY;
    assert.deepStrictEqual(await jsearch.fetchCompany(JS_OPTS), []);
    assert.strictEqual(calls.length, 0);
  });

  await withFetch(() => ({ status: 429, ok: false }), async (calls) => {
    process.env.JSEARCH_API_KEY = 'test-key';
    await assert.rejects(jsearch.fetchCompany(JS_OPTS), /HTTP 429/);
    assert.strictEqual(calls.length, 1, 'a retry is another billed request');
  });
});

test('jsearch: the 2-hourly collect never runs daily-cadence entries', () => {
  const tesla = COMPANIES.find((c) => c.source === 'jsearch' && c.slug === 'tesla');
  assert.ok(tesla && tesla.applyHost === 'tesla.com' && tesla.cadence === 'daily');
  assert.ok(!SCHEDULED_COMPANIES.some((c) => c.cadence === 'daily'));
  assert.ok(!SCHEDULED_COMPANIES.some((c) => c.source === 'jsearch'));
});
