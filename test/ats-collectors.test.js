'use strict';

// Field-mapping tests for the Workable / Recruitee / Pinpoint / Gem / BambooHR
// collectors (added 2026-10-31). Fixtures are trimmed copies of real API
// responses. The thing pinned in each case is the field the collector reads —
// a wrong field name doesn't error, it just yields empty locations or
// descriptions and the rows vanish in normalizeJob.

const test = require('node:test');
const assert = require('node:assert');

const workable = require('../src/collectors/workable');
const recruitee = require('../src/collectors/recruitee');
const pinpoint = require('../src/collectors/pinpoint');
const gem = require('../src/collectors/gem');
const bamboohr = require('../src/collectors/bamboohr');
const { looksUS } = require('../src/services/normalize');

test('workable: prefers a US office when a posting lists several', () => {
  const row = workable.mapPosting(
    {
      title: 'Machine Learning Engineer',
      shortcode: '81B46579FE',
      url: 'https://apply.workable.com/j/81B46579FE',
      published_on: '2026-10-29',
      telecommuting: false,
      description: '<p>Build models.</p>',
      locations: [
        { country: 'France', countryCode: 'FR', city: 'Paris', region: 'Île-de-France' },
        { country: 'United States', countryCode: 'US', city: 'New York', region: 'New York' },
      ],
    },
    { slug: 'huggingface', accountName: 'Hugging Face' }
  );
  assert.strictEqual(row.company_name, 'Hugging Face');
  assert.strictEqual(row.location, 'New York, New York, United States');
  assert.ok(looksUS(row.location));
  assert.strictEqual(row.date_posted, '2026-10-29');
  assert.strictEqual(row.external_id, 'huggingface:81B46579FE');
});

test('recruitee: keeps the requirements block in the description', () => {
  const row = recruitee.mapPosting(
    {
      id: 2793226,
      title: 'Software Engineer',
      location: 'Utrecht, Utrecht, Netherlands',
      careers_url: 'https://jobs.channable.com/o/software-engineer',
      description: '<p>Build things.</p>',
      requirements: '<p>Must be authorized to work without sponsorship.</p>',
      published_at: '2026-10-22 12:11:23 UTC',
      company_name: 'Channable',
      remote: false,
    },
    { slug: 'channable' }
  );
  assert.match(row.description, /without sponsorship/);
  assert.strictEqual(row.company_name, 'Channable');
  assert.strictEqual(row.apply_url, 'https://jobs.channable.com/o/software-engineer');
});

test('pinpoint: builds location from city/province and joins body sections', () => {
  const row = pinpoint.mapPosting(
    {
      id: '559663',
      title: 'Software Engineer',
      url: 'https://workwithus.pinpointhq.com/en/postings/ce6c9e5c',
      description: '<div>Intro</div>',
      skills_knowledge_expertise: '<ul><li>Must be a U.S. citizen</li></ul>',
      workplace_type: 'hybrid',
      location: { city: 'Austin', province: 'Texas', name: 'Austin HQ' },
    },
    { slug: 'workwithus', displayName: 'Pinpoint' }
  );
  assert.strictEqual(row.location, 'Austin, Texas');
  assert.ok(looksUS(row.location));
  assert.match(row.description, /U\.S\. citizen/);
  assert.strictEqual(row.date_posted, null);
});

test('gem: reads office locations and prefers updated_at over first_published_at', () => {
  const row = gem.mapPosting(
    {
      id: '4965519002',
      title: 'Software Engineer',
      absolute_url: 'https://jobs.gem.com/gem/4965519002',
      content: '<h2>Role</h2>',
      first_published_at: '2020-11-17T15:37:23.000Z',
      updated_at: '2026-10-29T21:20:54.077Z',
      location: { name: 'San Francisco, United States' },
      location_type: 'hybrid',
      offices: [{ name: 'San Francisco', location: { name: 'San Francisco, United States' } }],
    },
    { slug: 'gem', displayName: 'Gem' }
  );
  assert.strictEqual(row.location, 'San Francisco, United States');
  assert.strictEqual(row.date_posted, '2026-10-29T21:20:54.077Z');
});

test('bamboohr: uses detail description/date and falls back to the hosted URL', () => {
  const item = {
    id: '42',
    jobOpeningName: 'Software Engineer',
    atsLocation: { country: 'United States', state: 'Utah', city: 'Lehi' },
    isRemote: false,
  };
  const withDetail = bamboohr.mapPosting(item, {
    slug: 'acme',
    displayName: 'Acme',
    detail: { result: { jobOpening: { description: '<p>Build.</p>', datePosted: '2026-10-20' } } },
  });
  assert.strictEqual(withDetail.location, 'Lehi, Utah, United States');
  assert.strictEqual(withDetail.description, '<p>Build.</p>');
  assert.strictEqual(withDetail.date_posted, '2026-10-20');
  assert.strictEqual(withDetail.apply_url, 'https://acme.bamboohr.com/careers/42');

  const bare = bamboohr.mapPosting(item, { slug: 'acme', displayName: 'Acme', detail: null });
  assert.strictEqual(bare.description, '');
  assert.strictEqual(bare.job_title, 'Software Engineer');
});

const mdtable = require('../src/collectors/mdtable');

test('mdtable: parses rows with and without a Salary column', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  const md = [
    '| Company | Position | Location | Salary | Posting | Age |',
    '|---|---|---|---|---|---|',
    '| <a href="https://www.roblox.com"><strong>Roblox</strong></a> | Software Engineer - Frontend | San Mateo, CA | $150k/yr | <a href="https://careers.roblox.com/jobs/8259453"><img src="x.png" alt="Apply" width="70"/></a> | 3d |',
    '| <a href="http://www.hellofresh.com"><strong>HelloFresh</strong></a> | WMS Software Engineer | Newark, NJ +2 | <a href="https://careers.hellofresh.com/job/8334705"><img src="x.png" alt="Apply" width="70"/></a> | 0d |',
  ].join('\n');
  const rows = mdtable.parseTable(md, now);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], {
    company_name: 'Roblox',
    job_title: 'Software Engineer - Frontend',
    location: 'San Mateo, CA',
    apply_url: 'https://careers.roblox.com/jobs/8259453',
    date_posted: '2026-10-28T00:00:00.000Z',
  });
  // "+2" other-locations suffix stripped; Salary column absent.
  assert.strictEqual(rows[1].location, 'Newark, NJ');
  assert.strictEqual(rows[1].apply_url, 'https://careers.hellofresh.com/job/8334705');
});
