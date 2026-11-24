'use strict';

// The Built In resolver (scraper/src/targets/builtin-resolve.js) swaps Built
// In's sign-in-gated link for the employer's own. fetch is faked: a Workday
// tenant we track (Capital One), a Greenhouse board found by guessing the
// slug (Acme Robotics), and 404 for everything else.

const test = require('node:test');
const assert = require('node:assert/strict');

const WD = 'https://capitalone.wd12.myworkdayjobs.com/wday/cxs/capitalone/Capital_One';
const GH = 'https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs';

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const requests = [];
let throttle = false;
global.fetch = async (url, init = {}) => {
  url = String(url);
  requests.push(url);
  if (throttle && url.startsWith(WD)) return new Response('slow down', { status: 429 });
  if (url === `${WD}/jobs`) {
    const { searchText } = JSON.parse(init.body);
    if (searchText !== 'Full-stack Engineer 4') return json({ total: 0, jobPostings: [] });
    return json({
      total: 3,
      jobPostings: [
        { title: 'Full-stack Engineer 3', externalPath: '/job/McLean-VA/Full-stack-Engineer-3_R1', locationsText: 'McLean, VA' },
        { title: 'Full-stack Engineer 4', externalPath: '/job/McLean-VA/Full-stack-Engineer-4_R2', locationsText: '4 Locations' },
        { title: 'Full-Stack Engineer 4', externalPath: '/job/New-York-NY/Full-stack-Engineer-4_R3', locationsText: 'New York, NY' },
      ],
    });
  }
  if (url.startsWith(`${WD}/job/`)) return json({ jobPostingInfo: { jobDescription: '<p>Build things.</p>' } });
  if (url.startsWith(GH)) {
    return json({
      jobs: [
        { id: 1, title: 'Software Engineer', location: { name: 'Boston, MA' }, absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/1', content: 'x' },
        { id: 2, title: 'Software Engineer', location: { name: 'Austin, TX' }, absolute_url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/2', content: 'y' },
      ],
    });
  }
  return new Response('not found', { status: 404 });
};

const { resolveOriginalLinks, normalizeTitle, slugGuesses, sharesPlace } = require('../scraper/src/targets/builtin-resolve');

function row(company, title, location, id) {
  return {
    source: 'builtin',
    external_id: id,
    company_name: company,
    job_title: title,
    location,
    apply_url: `https://builtin.com/job/x/${id}`,
    description: '',
  };
}

test('helpers', () => {
  assert.equal(normalizeTitle('Full-Stack Engineer  4'), 'full stack engineer 4');
  assert.equal(normalizeTitle('R&D Engineer'), 'r and d engineer');
  assert.deepEqual(slugGuesses('Acme Robotics, Inc.'), ['acmerobotics', 'acme-robotics']);
  assert.deepEqual(slugGuesses('Chewy'), ['chewy']);
  assert.ok(sharesPlace('New York, NY, USA', 'New York, NY'));
  assert.ok(!sharesPlace('Boston, MA, USA', 'Austin, TX'));
  assert.ok(sharesPlace('Remote, USA', 'Remote - US'));
});

test('a tracked Workday company: title search, prefers the row\'s city', async () => {
  const [r] = await resolveOriginalLinks([row('Capital One', 'Full-stack Engineer 4', 'New York, NY, USA', '12445385')]);
  assert.equal(r.apply_url, 'https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/New-York-NY/Full-stack-Engineer-4_R3');
  assert.equal(r.location, 'New York, NY');
  assert.equal(r.description, '<p>Build things.</p>');
  assert.equal(r.source, 'builtin');
  // No slug guessing for a company we already track.
  assert.ok(!requests.some((u) => u.includes('capitalone') && !u.startsWith(WD)));
});

test('a tracked company with no exact title match keeps its Built In link', async () => {
  const before = row('Capital One', 'Full-stack Engineer 5', 'McLean, VA, USA', '9');
  const [r] = await resolveOriginalLinks([before]);
  assert.deepEqual(r, before);
});

test('an untracked company: guessed Greenhouse slug, matched by title and city', async () => {
  const rows = await resolveOriginalLinks([
    row('Acme Robotics, Inc.', 'Software Engineer', 'Boston, MA, USA', '1'),
    row('Acme Robotics, Inc.', 'Software Engineer', 'Seattle, WA, USA', '2'),
  ]);
  assert.equal(rows[0].apply_url, 'https://job-boards.greenhouse.io/acmerobotics/jobs/1');
  assert.equal(rows[0].location, 'Boston, MA');
  // Same title on the guessed board, but not in Seattle: could be another
  // company that happens to own the slug, so the Built In link stays.
  assert.equal(rows[1].apply_url, 'https://builtin.com/job/x/2');
});

test('nothing found anywhere: rows come back unchanged', async () => {
  const before = row('Nobody Corp', 'Software Engineer', 'Boston, MA, USA', '3');
  const [r] = await resolveOriginalLinks([before]);
  assert.deepEqual(r, before);
});

test('the first Workday 429 ends Workday lookups for the run, without waiting', async () => {
  throttle = true;
  requests.length = 0;
  const started = Date.now();
  const rows = await resolveOriginalLinks([
    row('Capital One', 'Full-stack Engineer 4', 'New York, NY, USA', '5'),
    row('Capital One', 'Full-stack Engineer 3', 'McLean, VA, USA', '6'),
  ]);
  throttle = false;
  assert.ok(Date.now() - started < 2000);
  assert.equal(rows[0].apply_url, 'https://builtin.com/job/x/5');
  assert.equal(rows[1].apply_url, 'https://builtin.com/job/x/6');
  assert.equal(requests.filter((u) => u.startsWith(WD)).length, 1);
});

test('out of time: lookups stop and rows keep their Built In link', async () => {
  const [r] = await resolveOriginalLinks([row('Capital One', 'Full-stack Engineer 4', 'New York, NY, USA', '8')], { budgetMs: -1 });
  assert.equal(r.apply_url, 'https://builtin.com/job/x/8');
});

// ─── src/scripts/fix-builtin-links.js: what happens to stored rows ───────────

const { plan } = require('../src/scripts/fix-builtin-links');

test('fix-builtin-links: update when the link is new, delete when another row has it', () => {
  const stored = [
    { id: 1, apply_url: 'https://builtin.com/job/a/1' },
    { id: 2, apply_url: 'https://builtin.com/job/b/2' },
    { id: 3, apply_url: 'https://builtin.com/job/c/3' },
    { id: 4, apply_url: 'https://builtin.com/job/d/4' },
    { id: 9, apply_url: 'https://www.capitalonecareers.example/job/9/' }, // employer's own row
  ];
  const resolved = [
    { id: 1, apply_url: 'https://boards.greenhouse.io/acme/jobs/1' },          // new link
    { id: 2, apply_url: 'https://capitalonecareers.example/job/9?utm_source=x' }, // row 9 has it
    { id: 3, apply_url: 'https://builtin.com/job/c/3' },                         // not found
    { id: 4, apply_url: 'https://boards.greenhouse.io/acme/jobs/1' },          // same posting as 1
  ];
  assert.deepEqual(plan(stored, resolved), {
    updates: [{ id: 1, apply_url: 'https://boards.greenhouse.io/acme/jobs/1' }],
    deletes: [2, 4],
  });
});
