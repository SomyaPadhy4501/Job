'use strict';

// Parsing tests for the Playwright scraper's Google and Meta targets
// (scraper/src/targets/google.js, meta.js).
//
// Fixtures are trimmed copies of what the live sites served on 2026-11-24:
// Google's server-rendered `ds:1` block on the results page, Meta's GraphQL
// job list and location filter, and the JobPosting block on a Meta job page.
// Descriptions are cut short; field positions and nesting are as served.

const test = require('node:test');
const assert = require('node:assert');

const google = require('../scraper/src/targets/google');
const meta = require('../scraper/src/targets/meta');

// ─── Google ───────────────────────────────────────────────────────────────────

const COMPANY_ID = 'projects/gweb-careers-proto/tenants/60107626-8e00-0000-0000-0071646e0806/companies/ebbbf0d1-8121-483c-8f99-ee92597591fc';

// One record in Google's positional layout.
function googleRecord({ id, title, company = 'Google', locations, level = 2, published = 1793864231 }) {
  return [
    id,
    title,
    `https://www.google.com/about/careers/applications/signin?jobId=abc&loc=US&title=${encodeURIComponent(title)}`,
    [null, '<ul>\n<li>Write and test product code.</li>\n</ul>'],
    [null, '<h3>Minimum qualifications:</h3><ul>\n<li>Bachelor’s degree or equivalent practical experience.</li>\n<li>1 year of experience with software development.</li>\n</ul>'],
    COMPANY_ID,
    null,
    company,
    'en-US',
    locations,
    [null, '<p>Google\'s software engineers develop the next-generation technologies.</p>'],
    [2, 3, 4],
    [published - 86400 * 30, 0],
    [published, 0],
    [published, 60_000_000],
    [null, ''],
    null,
    null,
    [null, ''],
    [null, '<ul>\n<li>Bachelor’s degree or equivalent practical experience.</li>\n</ul>'],
    level,
  ];
}

const MV = ['Mountain View, CA, USA', ['1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA'], 'Mountain View', '94043', 'CA', 'US'];
const NYC = ['New York, NY, USA', ['New York, NY, USA'], 'New York', null, 'NY', 'US'];
const ZRH = ['Zürich, Switzerland', ['Brandschenkestrasse 110, 8002 Zürich, Switzerland'], 'Zürich', '8002', null, 'CH'];

function googlePage(jobs, total = jobs.length) {
  const cards = jobs
    .map((j) => `<li><a href="jobs/results/${j[0]}-${j[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}?location=United+States&amp;target_level=MID">Learn more</a></li>`)
    .join('');
  return [
    '<html><body>',
    `<script class="ds:0" nonce="x">AF_initDataCallback({key: 'ds:0', hash: '1', data:[[["${COMPANY_ID}","Google","google"]]], sideChannel: {}});</script>`,
    `<ul>${cards}</ul>`,
    `<script class="ds:1" nonce="x">AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify([jobs, null, total, 20])}, sideChannel: {}});</script>`,
    '</body></html>',
  ].join('');
}

test('google: search URL pages the US list by level, newest first', () => {
  const u = new URL(google.googleSearchUrl({ level: 'MID', page: 3 }));
  assert.strictEqual(u.origin + u.pathname, 'https://www.google.com/about/careers/applications/jobs/results/');
  assert.strictEqual(u.searchParams.get('location'), 'United States');
  assert.deepStrictEqual(u.searchParams.getAll('target_level'), ['MID']);
  assert.strictEqual(u.searchParams.get('sort_by'), 'date');
  assert.strictEqual(u.searchParams.get('page'), '3');
  assert.strictEqual(new URL(google.googleSearchUrl({ level: 'EARLY' })).searchParams.get('page'), null);
});

test('google: reads the job block, not the companies block, with total and page size', () => {
  const jobs = [
    googleRecord({ id: '137359440260014790', title: 'Software Engineer', locations: [MV] }),
    googleRecord({ id: '90108472175010502', title: 'Software Engineer, Engineering Productivity', locations: [NYC] }),
  ];
  const data = google.extractGoogleData(googlePage(jobs, 849));
  assert.strictEqual(data.jobs.length, 2);
  assert.strictEqual(data.total, 849);
  assert.strictEqual(data.pageSize, 20);
  assert.strictEqual(google.extractGoogleData('<html>no data</html>'), null);
  // A page past the end: empty list, still a valid block.
  assert.deepStrictEqual(google.extractGoogleData(googlePage([], 849)).jobs, []);
});

test('google: keeps the slugged detail path from the cards', () => {
  const jobs = [googleRecord({ id: '137359440260014790', title: 'Software Engineer', locations: [MV] })];
  const paths = google.extractDetailPaths(googlePage(jobs));
  assert.strictEqual(paths.get('137359440260014790'), '137359440260014790-software-engineer');
});

test('google: parses a record into an ingest row', () => {
  const rec = googleRecord({
    id: '89324030758134470',
    title: 'Software Engineer III, Infrastructure, Google Cloud Platforms',
    locations: [MV, ZRH, NYC],
    level: 2,
  });
  const paths = new Map([['89324030758134470', '89324030758134470-software-engineer-iii-infrastructure-google-cloud-platforms']]);
  const row = google.parseGoogleJob(rec, paths);
  assert.strictEqual(row.external_id, '89324030758134470');
  assert.strictEqual(row.company_name, 'Google');
  assert.strictEqual(row.job_title, 'Software Engineer III, Infrastructure, Google Cloud Platforms');
  // Non-US offices are dropped from the location string.
  assert.strictEqual(row.location, 'Mountain View, CA, USA; New York, NY, USA');
  assert.deepStrictEqual(row.countries, ['US']);
  assert.strictEqual(
    row.apply_url,
    'https://www.google.com/about/careers/applications/jobs/results/89324030758134470-software-engineer-iii-infrastructure-google-cloud-platforms'
  );
  assert.match(row.description, /About the job/);
  assert.match(row.description, /Minimum qualifications/);
  assert.match(row.description, /1 year of experience/);
  assert.match(row.description, /Responsibilities/);
  // Published date (field 14), not the older created date (field 12).
  assert.strictEqual(row.date_posted, new Date(1793864231 * 1000).toISOString());
  assert.strictEqual(row.mid_level_override, 1);
  assert.strictEqual(row.entry_level_override, undefined);
});

test('google: Early level marks entry; id-only URL without a card link', () => {
  const row = google.parseGoogleJob(googleRecord({ id: '111', title: 'Software Engineer, Early Career', locations: [MV], level: 1 }));
  assert.strictEqual(row.entry_level_override, 1);
  assert.strictEqual(row.mid_level_override, undefined);
  assert.strictEqual(row.apply_url, 'https://www.google.com/about/careers/applications/jobs/results/111');
});

test('google: skips non-US, Advanced, senior, non-software and non-Google rows', () => {
  const skip = [
    googleRecord({ id: '1', title: 'Software Engineer', locations: [ZRH] }),
    googleRecord({ id: '2', title: 'Software Engineer', locations: [MV], level: 3 }),
    googleRecord({ id: '3', title: 'Senior Software Engineer, AI/ML', locations: [MV] }),
    googleRecord({ id: '4', title: 'Staff Software Engineer, Geo Makers', locations: [MV] }),
    googleRecord({ id: '5', title: 'Software Engineer Manager II, Diagnostics Infrastructure', locations: [MV] }),
    googleRecord({ id: '6', title: 'Account Strategist, Mid-Market Sales', locations: [MV] }),
    googleRecord({ id: '7', title: 'Software Engineer', company: 'Waymo', locations: [MV] }),
    googleRecord({ id: '8', title: 'Software Engineer Intern, BS, Summer 2027', locations: [MV] }),
  ];
  for (const rec of skip) assert.strictEqual(google.parseGoogleJob(rec), null, rec[1]);
  // YouTube is Google's.
  assert.ok(google.parseGoogleJob(googleRecord({ id: '9', title: 'Software Engineer, YouTube', company: 'YouTube', locations: [MV] })));
});

test('google: a page is past the age window only when every record is', () => {
  const now = Math.floor(Date.now() / 1000);
  const fresh = googleRecord({ id: '1', title: 'Software Engineer', locations: [MV], published: now - 86400 * 3 });
  const stale = googleRecord({ id: '2', title: 'Software Engineer', locations: [MV], published: now - 86400 * 45 });
  const cutoff = Date.now() - 30 * 86_400_000;
  assert.strictEqual(google.pageIsOlderThan([stale, stale], cutoff), true);
  assert.strictEqual(google.pageIsOlderThan([fresh, stale], cutoff), false);
  assert.strictEqual(google.pageIsOlderThan([], cutoff), false);
});

test('google: title filter keeps II/III, drops IV and up', () => {
  assert.ok(google.looksRelevantTitle('Software Engineer II, Android'));
  assert.ok(google.looksRelevantTitle('Software Engineer III, Core Data (multiple openings)'));
  assert.ok(google.looksRelevantTitle('Research Scientist, Science AI, Google Research'));
  assert.ok(!google.looksRelevantTitle('Software Engineer IV, Payments'));
  assert.ok(!google.looksRelevantTitle('Program Manager III, Spares Management'));
});

// ─── Meta ─────────────────────────────────────────────────────────────────────

const META_LIST = JSON.stringify({
  data: {
    job_search_with_featured_jobs_v2: {
      all_jobs: [
        { id: '998357492128826', title: 'Software Engineer, Machine Learning', locations: ['Menlo Park, CA', 'London, UK'], teams: ['Software Engineering'], sub_teams: ['Engineering'] },
        { id: '3221791248029792', title: 'Software Engineer, Network Infrastructure', locations: ['Remote, US'], teams: ['Infrastructure'], sub_teams: [] },
        { id: '1126899676481179', title: 'Research Scientist Intern, Computer Vision (PhD)', locations: ['Menlo Park, CA'], teams: ['Internship - PhD'], sub_teams: [] },
        { id: '34138980215746375', title: 'Product Manager, Central Products', locations: ['Menlo Park, CA'], teams: ['Product Management'], sub_teams: [] },
        { id: '2079446389603122', title: 'Silicon Packaging Engineer (SIPI)', locations: ['Sunnyvale, CA'], teams: ['Infrastructure'], sub_teams: [] },
        { id: '555', title: 'Software Engineer, Infrastructure', locations: ['London, UK', 'Remote, UK'], teams: [], sub_teams: [] },
        { id: '666', title: 'Engineering Manager, Ads', locations: ['Miami, Florida'], teams: [], sub_teams: [] },
        { id: '998357492128826', title: 'Software Engineer, Machine Learning', locations: ['Menlo Park, CA'], teams: [], sub_teams: [] },
      ],
      featured_jobs: [],
      featured_jobs_title: 'Featured Jobs',
      all_jobs_title: 'All Jobs',
    },
  },
  extensions: { is_final: true },
});

const META_LOCATIONS = JSON.stringify({
  data: {
    job_search_filters: {
      locations: [
        { id: 'menlo-park', location_display_name: 'Menlo Park, CA', is_remote: false, state: 'California', country: 'United States' },
        { id: 'miami', location_display_name: 'Miami, Florida', is_remote: false, state: 'Florida', country: 'United States' },
        { id: 'us-remote', location_display_name: 'Remote, US', is_remote: true, state: 'Wisconsin', country: 'United States' },
        { id: 'london', location_display_name: 'London, UK', is_remote: false, state: '', country: 'UK' },
        { id: 'uk-remote', location_display_name: 'Remote, UK', is_remote: true, state: '', country: 'UK' },
      ],
    },
  },
});

test('meta: reads the all-jobs list and the location map from GraphQL bodies', () => {
  const [list] = meta.parseGraphqlBody(META_LIST + '\n{"label":"stream"}\n');
  assert.strictEqual(meta.extractAllJobs(list).length, 8);
  assert.strictEqual(meta.extractLocationCountries(list), null);
  const countries = meta.extractLocationCountries(meta.parseGraphqlBody(META_LOCATIONS)[0]);
  assert.strictEqual(countries.get('Miami, Florida'), 'United States');
  assert.strictEqual(countries.get('London, UK'), 'UK');
  assert.deepStrictEqual(meta.parseGraphqlBody('for (;;);\nnot json'), []);
});

test('meta: US location by the filter map, else by name shape', () => {
  const countries = meta.extractLocationCountries(JSON.parse(META_LOCATIONS));
  assert.ok(meta.isUsLocation('Miami, Florida', countries));
  assert.ok(!meta.isUsLocation('London, UK', countries));
  // No map: "City, ST" and "Remote, US" read as US.
  assert.ok(meta.isUsLocation('Bellevue, WA', null));
  assert.ok(meta.isUsLocation('Remote, US', null));
  assert.ok(!meta.isUsLocation('London, UK', null));
  assert.ok(!meta.isUsLocation('Singapore', null));
});

test('meta: seeds are US software roles, deduped, in list order', () => {
  const allJobs = meta.extractAllJobs(JSON.parse(META_LIST));
  const countries = meta.extractLocationCountries(JSON.parse(META_LOCATIONS));
  const seeds = meta.selectSeeds(allJobs, countries);
  assert.deepStrictEqual(seeds, [
    { id: '998357492128826', title: 'Software Engineer, Machine Learning', location: 'Menlo Park, CA' },
    { id: '3221791248029792', title: 'Software Engineer, Network Infrastructure', location: 'Remote, US' },
    // Kept here; the API's role classifier decides hardware titles.
    { id: '2079446389603122', title: 'Silicon Packaging Engineer (SIPI)', location: 'Sunnyvale, CA' },
  ]);
});

const META_JOB_PAGE = [
  '<html><head><script type="application/ld+json" nonce="abc">',
  JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Software Engineer, Machine Learning',
    description: 'Meta is seeking Machine Learning Engineers to join our Central Growth team.',
    responsibilities: 'Implement custom user interfaces&nbsp;Analyze and optimize code for quality &amp; performance&nbsp;',
    hiringOrganization: { '@type': 'Organization', name: 'Meta' },
    datePosted: '2026-11-24T07:17:27-08:00',
    jobLocation: [
      { '@type': 'Place', name: 'Menlo Park, CA', address: { '@type': 'PostalAddress', addressLocality: 'Menlo Park', addressRegion: 'California', addressCountry: 'US' } },
      { '@type': 'Place', name: 'London, UK', address: { '@type': 'PostalAddress', addressLocality: 'London', addressCountry: 'GB' } },
    ],
    qualifications: '2+ years of programming experience&nbsp;Bachelor\'s degree in Computer Science&nbsp;',
    employmentType: 'FULL_TIME',
  }).replace(/\//g, '\\/'),
  '</script></head><body></body></html>',
].join('');

test('meta: reads description, date and countries from the JobPosting block', () => {
  const posting = meta.extractJobPosting(META_JOB_PAGE);
  assert.strictEqual(posting['@type'], 'JobPosting');
  const d = meta.postingDetails(posting);
  assert.strictEqual(d.title, 'Software Engineer, Machine Learning');
  assert.strictEqual(d.date_posted, '2026-11-24T15:17:27.000Z');
  assert.deepStrictEqual(d.countries, ['US', 'GB']);
  assert.strictEqual(
    d.description,
    [
      'Meta is seeking Machine Learning Engineers to join our Central Growth team.',
      'Responsibilities:\nImplement custom user interfaces\nAnalyze and optimize code for quality & performance',
      "Qualifications:\n2+ years of programming experience\nBachelor's degree in Computer Science",
    ].join('\n\n')
  );
  assert.strictEqual(meta.extractJobPosting('<html><script type="application/ld+json">{"@type":"Organization"}</script></html>'), null);
});

test('meta: builds rows with or without page details', () => {
  const seed = { id: '998357492128826', title: 'Software Engineer, Machine Learning', location: 'Menlo Park, CA' };
  const full = meta.buildRow(seed, meta.postingDetails(meta.extractJobPosting(META_JOB_PAGE)));
  assert.strictEqual(full.external_id, '998357492128826');
  assert.strictEqual(full.company_name, 'Meta');
  assert.strictEqual(full.apply_url, 'https://www.metacareers.com/profile/job_details/998357492128826');
  assert.strictEqual(full.location, 'Menlo Park, CA');
  assert.ok(full.description.includes('2+ years'));
  assert.ok(full.date_posted);

  const bare = meta.buildRow(seed, null);
  assert.strictEqual(bare.job_title, seed.title);
  assert.deepStrictEqual(bare.countries, ['US']);
  assert.strictEqual(bare.description, '');
  assert.strictEqual(bare.date_posted, null);
});
