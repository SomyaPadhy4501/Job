'use strict';

// Workday description requests (src/collectors/workday.js). Each costs one
// request against Workday's per-IP limit, so postings past the retention
// window and postings already stored with a description get none. Fake fetch;
// no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchCompany } = require('../src/collectors/workday');
const { resetRateLimits, NODE_HTTP_PLATFORMS } = require('../src/collectors/http');

NODE_HTTP_PLATFORMS.clear(); // Workday through the faked fetch below

const realFetch = global.fetch;
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test.afterEach(() => {
  global.fetch = realFetch;
  resetRateLimits();
});

const company = { source: 'workday', slug: 'acme', displayName: 'Acme', tenant: 'acme', wd: 5, site: 'Careers' };
const posting = (title, path, postedOn) => ({ title, externalPath: path, locationsText: 'Austin, TX', postedOn });

test('only fresh postings without a stored description are read in full', async () => {
  const details = [];
  global.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      return json({
        total: 3,
        jobPostings: [
          posting('Software Engineer', '/job/Austin-TX/New_R1', 'Posted Today'),
          posting('Software Engineer II', '/job/Austin-TX/Old_R2', 'Posted 30+ Days Ago'),
          posting('Backend Engineer', '/job/Austin-TX/Known_R3', 'Posted 2 Days Ago'),
        ],
      });
    }
    details.push(new URL(url).pathname);
    return json({ jobPostingInfo: { jobDescription: '<p>Build things.</p>' } });
  };
  const known = 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin-TX/Known_R3';
  const rows = await fetchCompany({ ...company, described: new Set([known]) });

  assert.deepEqual(details, ['/wday/cxs/acme/Careers/job/Austin-TX/New_R1']);
  assert.equal(rows.length, 3, 'every posting is still returned');
  assert.equal(rows.find((r) => r.apply_url === known).description, '', 'stored description is kept by upsert, not re-read');
  assert.match(rows.find((r) => /New_R1/.test(r.apply_url)).description, /Build things/);
});

test('a search-only employer is searched, never listed in full, within its caps', async () => {
  const searches = [];
  let details = 0;
  global.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      const { searchText, offset } = JSON.parse(init.body);
      searches.push(`${searchText}@${offset}`);
      // Every page is full, so only searchCap stops the paging.
      return json({
        total: 500,
        jobPostings: Array.from({ length: 20 }, (_, i) => posting(`Software Engineer ${searchText} ${offset + i}`, `/job/Austin-TX/${searchText.replace(/ /g, '-')}_${offset + i}`, 'Posted Today')),
      });
    }
    details++;
    return json({ jobPostingInfo: { jobDescription: '<p>x</p>' } });
  };
  const rows = await fetchCompany({ ...company, searchOnly: true, searches: ['software engineer', 'data engineer'], searchCap: 40, enrichMax: 5 });

  assert.deepEqual(searches, ['software engineer@0', 'software engineer@20', 'data engineer@0', 'data engineer@20']);
  assert.equal(rows.length, 80);
  assert.equal(details, 5);
});
