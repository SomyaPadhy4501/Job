'use strict';

// scripts/discover-workday.js: Workday tenants read from Common Crawl URLs and
// matched to the USCIS sponsor list. No network; sponsors are passed in.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkdayUrl, collectTenants, matchTenants } = require('../scripts/discover-workday');

test('parseWorkdayUrl reads tenant, shard and site, with or without a locale', () => {
  assert.deepEqual(parseWorkdayUrl('https://tmobile.wd1.myworkdayjobs.com/External/job/Bellevue-WA/SWE_REQ1'), { tenant: 'tmobile', wd: '1', site: 'External' });
  assert.deepEqual(parseWorkdayUrl('https://fmr.wd1.myworkdayjobs.com/en-US/targeted/details/x'), { tenant: 'fmr', wd: '1', site: 'targeted' });
  assert.deepEqual(parseWorkdayUrl('https://acme.wd103.myworkdayjobs.com/Careers?q=1'), { tenant: 'acme', wd: '103', site: 'Careers' });
  assert.deepEqual(parseWorkdayUrl('https://acme.wd5.myworkdayjobs.com/en-us/External/job/x'), { tenant: 'acme', wd: '5', site: 'External' });
});

test('parseWorkdayUrl ignores pages that are not a careers site', () => {
  for (const url of [
    'https://acme.wd5.myworkdayjobs.com/robots.txt',
    'https://acme.wd5.myworkdayjobs.com/en-US',
    'https://acme.wd5.myworkdayjobs.com/es/job/Madrid/x',
    'https://acme.wd5.myworkdayjobs.com/job/Austin-TX/x',
    'https://acme.wd5.myworkdayjobs.com/acme-nonrecruit/job/x',
    'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/jobs',
    'https://viscofan.impl-wd103.myworkdayjobs.com/External',
    'https://example.com/External',
  ]) assert.equal(parseWorkdayUrl(url), null, url);
});

test('collectTenants puts the most-linked site first and drops internal ones', () => {
  const [t] = collectTenants([
    'https://acme.wd5.myworkdayjobs.com/Acme_Internal/job/a',
    'https://acme.wd5.myworkdayjobs.com/Acme_Internal/job/b',
    'https://acme.wd5.myworkdayjobs.com/Acme_Internal/job/c',
    'https://acme.wd5.myworkdayjobs.com/campus/job/a',
    'https://acme.wd5.myworkdayjobs.com/External/job/a',
    'https://acme.wd5.myworkdayjobs.com/en-US/external/job/b',
  ]);
  assert.equal(t.tenant, 'acme');
  assert.deepEqual(t.sites, [{ site: 'External', urls: 2 }, { site: 'campus', urls: 1 }]);
});

const SPONSORS = {
  'zorblex-robotics-usa': { approvals_last_2fy: 40 },
  'quintavo-airlines': { approvals_last_2fy: 90 },
  'quintavo-university': { approvals_last_2fy: 300 },
  'small-zorblex-shop': { approvals_last_2fy: 1 },
};
const tenants = (...names) => names.map((tenant) => ({ tenant, wd: '5', sites: [{ site: 'External', urls: 3 }] }));

test('matchTenants marks a full-name match strong and a first-word match CHECK', () => {
  const { matched, unmatched } = matchTenants(tenants('zorblexrobotics', 'quintavo', 'nobodyknows'), { sponsors: SPONSORS, companies: [] });
  assert.equal(unmatched, 1);
  assert.deepEqual(matched.map((m) => [m.tenant, m.sponsor, m.strong]), [
    ['zorblexrobotics', 'zorblex-robotics-usa', true],
    ['quintavo', 'quintavo-airlines', false],
  ]);
  assert.equal(matched[0].displayName, 'Zorblex Robotics');
});

test('matchTenants skips configured tenants, universities and small sponsors', () => {
  const companies = [{ source: 'workday', tenant: 'zorblexrobotics', wd: '5', site: 'External' }];
  const { matched } = matchTenants(tenants('zorblexrobotics', 'quintavouniversity', 'smallzorblexshop'), { sponsors: SPONSORS, companies });
  assert.deepEqual(matched, []);
});

test('keepDiscovered keeps live employers and drops universities, covered boards and empty ones', () => {
  const { keepDiscovered } = require('../scripts/discover-workday');
  const covered = (key) => key.startsWith('qualcomm');
  assert.equal(keepDiscovered({ legalName: 'Fidelity Investments Institutional Operations Company LLC', softwareHits: 12 }, covered), true);
  assert.equal(keepDiscovered({ legalName: 'Fidelity Investments Institutional Operations Company LLC', softwareHits: 0 }, covered), false);
  assert.equal(keepDiscovered({ legalName: 'Quintavo State University', softwareHits: 40 }, covered), false);
  assert.equal(keepDiscovered({ legalName: 'Qualcomm Technologies, Inc.', softwareHits: 90 }, covered), false);
});

test('discovered Workday employers load as search-only, off the regular schedule', () => {
  const { discoveredWorkday, SCHEDULED_COMPANIES } = require('../src/config');
  const entries = discoveredWorkday(
    [
      { tenant: 'fmr', wd: '1', site: 'targeted', displayName: 'Fidelity Investments', softwareHits: 12 },
      { tenant: 'quiet', wd: '5', site: 'External', displayName: 'Quiet Co', softwareHits: 0 },
      { tenant: 'known', wd: '5', site: 'External', displayName: 'Known', softwareHits: 9 },
    ],
    [{ source: 'workday', tenant: 'known', wd: '5', site: 'External' }]
  );
  assert.deepEqual(entries.map((e) => [e.slug, e.cadence, e.searchOnly]), [['fmr-targeted', 'wide', true]]);
  assert.equal(SCHEDULED_COMPANIES.some((c) => c.cadence), false);
});
