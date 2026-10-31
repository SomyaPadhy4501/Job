'use strict';

// Tests for the browser extension's generic job extractor (extension/extract.js).
// Fixtures are trimmed from the real responses captured on 2026-10-31 by
// loading each careers page in Chromium with the extension's scripts injected.

const test = require('node:test');
const assert = require('node:assert');
const X = require('../extension/extract.js');

const ctx = (pageUrl, extra = {}) => ({ pageUrl, company: 'PageCo', ...extra });

test('finds a Workday job list and resolves externalPath via the rendered link', () => {
  const json = {
    total: 2,
    jobPostings: [
      { title: 'Software Engineer', externalPath: '/job/US-CA-Santa-Clara/Software-Engineer_JR1', locationsText: 'US, CA, Santa Clara', bulletFields: ['JR1'] },
      { title: 'Data Engineer', externalPath: '/job/US-TX-Austin/Data-Engineer_JR2', locationsText: '2 Locations', bulletFields: ['JR2'] },
      { title: 'ML Engineer', externalPath: '/job/US-WA-Seattle/ML-Engineer_JR3', locationsText: 'US, WA, Seattle', bulletFields: ['JR3'] },
    ],
    facets: [{ facetParameter: 'locations', values: [{ descriptor: 'US', count: 9 }] }],
  };
  const base = 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite';
  const findLink = (p) => (p.startsWith('/job/') ? `${base}${p}` : '');
  const rows = X.usable(X.extractFromJson(json, ctx(`${base}`, { findLink })));
  // "2 Locations" is a placeholder → dropped, not assumed US.
  assert.deepStrictEqual(rows.map((r) => r.job_title), ['Software Engineer', 'ML Engineer']);
  assert.strictEqual(rows[0].apply_url, `${base}/job/US-CA-Santa-Clara/Software-Engineer_JR1`);
  assert.strictEqual(rows[0].location, 'US, CA, Santa Clara');
});

test('maps an Eightfold list: epoch-second dates and canonical URLs', () => {
  const json = {
    positions: [
      { id: 790316811164, name: 'Software Engineer 4', location: 'Remote, United States', t_update: 1793059200, canonicalPositionUrl: 'https://explore.jobs.netflix.net/careers/job/790316811164' },
      { id: 790318081427, name: 'Software Engineer 5', location: 'Los Gatos,California,United States of America', t_update: 1793059200, canonicalPositionUrl: 'https://explore.jobs.netflix.net/careers/job/790318081427' },
      { id: 790315422460, name: 'ML Engineer', location: 'Remote, United States', t_update: 1793059200, canonicalPositionUrl: 'https://explore.jobs.netflix.net/careers/job/790315422460' },
    ],
  };
  const rows = X.usable(X.extractFromJson(json, ctx('https://explore.jobs.netflix.net/careers')));
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].apply_url, 'https://explore.jobs.netflix.net/careers/job/790316811164');
  assert.strictEqual(rows[0].date_posted, new Date(1793059200 * 1000).toISOString());
  assert.strictEqual(rows[0].external_id, 'explore.jobs.netflix.net:790316811164');
});

test('ignores arrays that are not job lists', () => {
  const json = {
    nav: [{ name: 'Home', href: '/' }, { name: 'Teams', href: '/teams' }],         // too short
    filters: [{ label: 'Engineering' }, { label: 'Design' }, { label: 'Sales' }], // no title key
    offices: [{ city: 'Austin' }, { city: 'Boston' }, { city: 'Denver' }],
  };
  assert.deepStrictEqual(X.extractFromJson(json, ctx('https://example.com/careers')), []);
});

test('reads schema.org JobPosting JSON-LD, including @graph', () => {
  const blocks = [{
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': 'JobPosting',
      title: 'Backend Engineer',
      url: 'https://example.com/careers/123',
      datePosted: '2026-10-20',
      hiringOrganization: { name: 'Example Inc' },
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Denver', addressRegion: 'CO', addressCountry: 'US' } },
      description: '<p>Build APIs.</p>',
    }],
  }];
  const [row] = X.usable(X.extractFromJsonLd(blocks, ctx('https://example.com/careers/123')));
  assert.strictEqual(row.company_name, 'Example Inc');
  assert.strictEqual(row.location, 'Denver, CO, US');
  assert.strictEqual(row.date_posted, '2026-10-20T00:00:00.000Z');
});

test('company naming: ATS path beats generic page metadata', () => {
  assert.strictEqual(X.companyFromUrl('https://apply.workable.com/huggingface/'), 'Huggingface');
  assert.strictEqual(X.companyFromUrl('https://jobs.ashbyhq.com/openai'), 'Openai');
  assert.strictEqual(X.companyFromUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'), 'Nvidia');
  assert.strictEqual(X.companyFromUrl('https://www.tesla.com/careers/search'), '');
  assert.strictEqual(X.cleanSiteName('Careers at Netflix'), 'Netflix');
  assert.strictEqual(X.cleanSiteName('Build your Career at Tesla'), 'Tesla');
  assert.strictEqual(X.cleanSiteName('The future of work starts with our amazing people'), '');
  assert.strictEqual(X.cleanSiteName('Apply'), '');
  assert.strictEqual(X.companyFromHost('www.tesla.com'), 'Tesla');
});

test('resolves location ids through a lookup table in the same response', () => {
  // Tesla-style: listings carry an id, the label lives in lookup.locations.
  const json = {
    lookup: { locations: { 402: 'Palo Alto, California', 17: 'Austin, Texas', 9: 'Shanghai, China' } },
    listings: [
      { id: 'a1', t: 'Software Engineer, Vehicle Firmware', l: '402' },
      { id: 'a2', t: 'Data Engineer', l: '17' },
      { id: 'a3', t: 'Backend Engineer', l: '9' },
    ],
  };
  const rows = X.extractFromJson(json, ctx('https://www.tesla.com/careers/search'));
  assert.deepStrictEqual(rows.map((r) => r.location), ['Palo Alto, California', 'Austin, Texas', 'Shanghai, China']);
});

test('completes a bare city with the state field the item carries', () => {
  const json = { jobs: [1, 2, 3].map((i) => ({ data: { req_id: `R${i}`, title: `Software Engineer ${i}`, location_name: 'Torrance', city: 'Torrance', state: 'California', country: 'United States' } })) };
  const [row] = X.extractFromJson(json, ctx('https://careers.rivian.com/careers-home/jobs'));
  assert.strictEqual(row.location, 'Torrance, California, United States');
});

// ─── Job-link templates ───────────────────────────────────────────────────────

const row = (id, title, url) => ({ external_id: `www.example.com:${id}`, job_title: title, apply_url: url });

test('learnTemplate infers id and slug positions from linked rows', () => {
  const rows = [
    row('101', 'Software Engineer', 'https://x.com/careers/job/software-engineer-101'),
    row('102', 'Data Engineer, Platform', 'https://x.com/careers/job/data-engineer-platform-102?src=list'),
    row('103', 'ML Engineer', 'https://x.com/careers/search/?site=US#job-103'),
  ];
  assert.strictEqual(X.learnTemplate(rows), 'https://x.com/careers/job/{slug}-{id}');
  assert.strictEqual(
    X.fillTemplate('https://x.com/careers/job/{slug}-{id}', rows[2]),
    'https://x.com/careers/job/ml-engineer-103',
  );
});

test('learnTemplate refuses to generalise from a single link', () => {
  assert.strictEqual(X.learnTemplate([row('101', 'SWE', 'https://x.com/job/101')]), null);
});

test('Tesla placeholders map to the confirmed job-page format', () => {
  const tpl = X.KNOWN_TEMPLATES['www.tesla.com'];
  const r = { external_id: 'www.tesla.com:222387', job_title: 'Software Engineer', apply_url: 'https://www.tesla.com/careers/search/?site=US#job-222387' };
  assert.ok(X.isPlaceholder(r));
  assert.strictEqual(X.fillTemplate(tpl, r), 'https://www.tesla.com/careers/search/job/222387');
});

test('candidateTemplates tries next to the search page first', () => {
  assert.deepStrictEqual(X.candidateTemplates('https://www.tesla.com/careers/search/?site=US').slice(0, 2), [
    'https://www.tesla.com/careers/search/job/{id}',
    'https://www.tesla.com/careers/search/jobs/{id}',
  ]);
});

test('reads Apple search results: name+country locations and summaries', () => {
  const json = { loaderData: { search: { searchResults: [1, 2, 3].map((i) => ({
    id: `20067830${i}-0836`, positionId: `20067830${i}`, postingTitle: `Software Engineer ${i}`,
    jobSummary: 'Build things at Apple.', postDateInGMT: '2026-10-31T05:22:24.836Z',
    locations: [{ name: 'Cupertino', city: '', stateProvince: '', countryName: 'United States of America' }],
  })) } } };
  const [r] = X.extractFromJson(json, ctx('https://jobs.apple.com/en-us/search'));
  assert.strictEqual(r.location, 'Cupertino, United States of America');
  assert.strictEqual(r.description, 'Build things at Apple.');
  assert.strictEqual(r.date_posted, '2026-10-31T05:22:24.836Z');
});

test('LinkedIn job cards: URN ids, {text} fields, view links', () => {
  assert.strictEqual(X.idValue('urn:li:fsd_jobPosting:4012345678'), '4012345678');
  assert.strictEqual(X.idValue({ text: 'Google' }), 'Google');
  assert.ok(X.isSensitiveHost('www.linkedin.com'));
  assert.ok(!X.isSensitiveHost('jobs.apple.com'));
  const json = { included: [1, 2, 3].map((i) => ({
    jobPostingTitle: `Software Engineer ${i}`, jobPostingUrn: `urn:li:fsd_jobPosting:40123456${i}`,
    primaryDescription: { text: 'Stripe' }, secondaryDescription: { text: 'Seattle, WA (On-site)' },
  })) };
  const [r] = X.extractFromJson(json, ctx('https://www.linkedin.com/jobs/search/'));
  assert.strictEqual(r.company_name, 'Stripe');
  assert.strictEqual(r.location, 'Seattle, WA (On-site)');
  assert.strictEqual(r.external_id, 'www.linkedin.com:401234561');
});
