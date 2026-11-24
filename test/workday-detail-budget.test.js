'use strict';

// Workday description requests (src/collectors/workday.js). Each costs one
// request against Workday's per-IP limit, so postings past the retention
// window and postings already stored with a description get none. Fake fetch;
// no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchCompany } = require('../src/collectors/workday');
const { resetRateLimits } = require('../src/collectors/http');

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
