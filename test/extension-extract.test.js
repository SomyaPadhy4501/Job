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
  assert.strictEqual(X.cleanSiteName('Apply'), '');
  assert.strictEqual(X.companyFromHost('www.tesla.com'), 'Tesla');
});
