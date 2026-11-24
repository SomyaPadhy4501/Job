'use strict';

// Apple, Uber and the Phenom scraper target, fixed 2026-11-24. Each one was
// reporting success while collecting a sliver of the employer's openings:
//   - apple: six fuzzy keyword queries, five pages each, all returned the same
//     ~100 newest postings site-wide (55 rows on a 14-day board);
//   - uber: the search RPC was removed (404 ERR_MISSING_HANDLER) and every
//     query's error was swallowed, so the run logged collector.ok count 0;
//   - phenom: scrolled for an infinite scroll Phenom doesn't have (10 Cisco
//     rows), and a Cloudflare challenge on Cognizant came back as 0 rows.
// No network: fetch and the Playwright page are faked.

const test = require('node:test');
const assert = require('node:assert');

const apple = require('../src/collectors/apple');
const uber = require('../src/collectors/uber');
const phenom = require('../scraper/src/targets/phenom');
const { resetRateLimits, NODE_HTTP_PLATFORMS } = require('../src/collectors/http');

NODE_HTTP_PLATFORMS.clear(); // Workday through the faked fetch below
const { normalizeJob } = require('../src/services/normalize');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

async function withFetch(fake, fn) {
  const real = global.fetch;
  global.fetch = fake;
  resetRateLimits();
  try {
    return await fn();
  } finally {
    global.fetch = real;
    resetRateLimits();
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ─── Apple ────────────────────────────────────────────────────────────────────

const appleBlob = (obj) =>
  `<html><script>window.__staticRouterHydrationData = JSON.parse(${JSON.stringify(JSON.stringify(obj))});</script></html>`;

function appleResult(i, { title = `Software Engineer ${i}`, posted = daysAgo(1) } = {}) {
  return {
    id: `2000${i}-0836`,
    postingTitle: title,
    transformedPostingTitle: `t-${i}`,
    postDateInGMT: posted,
    jobSummary: 'Summary.',
    locations: [{ name: 'Cupertino', countryName: 'United States of America' }],
  };
}

test('apple: the search URL walks all US postings newest-first, with no keyword', () => {
  const u = new URL(apple.searchUrl(3));
  assert.strictEqual(u.searchParams.get('search'), null, 'search= ranks fuzzily; it must not be sent');
  assert.strictEqual(u.searchParams.get('location'), 'united-states-USA');
  assert.strictEqual(u.searchParams.get('sort'), 'newest');
  assert.strictEqual(u.searchParams.get('page'), '3');
});

test('apple: paging stops on a short page, at the total, or once a page is all older than the cutoff', () => {
  const cutoff = Date.now() - 15 * DAY;
  const fresh = Array.from({ length: 20 }, (_, i) => appleResult(i));
  const old = Array.from({ length: 20 }, (_, i) => appleResult(i, { posted: daysAgo(30) }));
  const mixed = [...fresh.slice(0, 10), ...old.slice(0, 10)];
  const undated = old.map((r, i) => (i === 0 ? { ...r, postDateInGMT: undefined } : r));

  assert.strictEqual(apple.isLastPage(fresh, { page: 1, totalRecords: 4597, cutoff }), false);
  assert.strictEqual(apple.isLastPage(fresh.slice(0, 7), { page: 1, totalRecords: 4597, cutoff }), true);
  assert.strictEqual(apple.isLastPage(fresh, { page: 3, totalRecords: 60, cutoff }), true);
  assert.strictEqual(apple.isLastPage(old, { page: 1, totalRecords: 4597, cutoff }), true);
  assert.strictEqual(apple.isLastPage(mixed, { page: 1, totalRecords: 4597, cutoff }), false);
  assert.strictEqual(apple.isLastPage(undated, { page: 1, totalRecords: 4597, cutoff }), false, 'undated is not old');
  assert.strictEqual(apple.isLastPage(fresh, { page: 1, totalRecords: 4597, cutoff: null }), false);
});

test('apple: fetchCompany pages past the first 100 rows and stops at the retention window', async () => {
  // 3 pages: two of fresh postings, then one entirely older than 14+1 days.
  // Per page, half the titles are software and half are not.
  const pages = [1, 2, 3].map((p) =>
    Array.from({ length: 20 }, (_, i) => {
      const n = p * 100 + i;
      return appleResult(n, {
        title: i % 2 ? `Retail Specialist ${n}` : `Software Engineer ${n}`,
        posted: p === 3 ? daysAgo(40) : daysAgo(p),
      });
    })
  );
  const requested = [];
  await withFetch(async (url) => {
    requested.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/search')) {
      const page = Number(u.searchParams.get('page'));
      return new Response(appleBlob({ loaderData: { search: { totalRecords: 4597, searchResults: pages[page - 1] || [] } } }));
    }
    return new Response(
      appleBlob({ loaderData: { jobDetails: { jobsData: { description: 'Build.', minimumQualifications: '1+ years.' } } } })
    );
  }, async () => {
    const rows = await apple.fetchCompany({ pageDelayMs: 0, detailConcurrency: 1 });
    const searches = requested.filter((u) => u.includes('/search?'));
    assert.strictEqual(searches.length, 3, 'stops after the first all-old page');
    // 2 fresh pages x 10 software titles; the old page's rows are dropped.
    assert.strictEqual(rows.length, 20);
    assert.ok(rows.every((r) => /^Software Engineer/.test(r.job_title)));
    assert.strictEqual(requested.length - searches.length, 20, 'one detail per kept row');
    assert.match(rows[0].description, /Minimum Qualifications\n1\+ years/);
  });
});

test('apple: a first page without embedded job data throws instead of returning 0 rows', async () => {
  await withFetch(async () => new Response('<html>Access denied</html>'), async () => {
    await assert.rejects(apple.fetchCompany({ pageDelayMs: 0 }), /no embedded job data/);
  });
});

// ─── Uber ─────────────────────────────────────────────────────────────────────

// Trimmed from recruitingCEJobRequisitions on iaziqy.fa.ocs.oraclecloud.com
// (site UberCareers), 2026-11-24.
const UBER_REQ = {
  Id: '156028',
  Title: 'Software Engineer II, Merchant Intel 5',
  PostedDate: daysAgo(1).slice(0, 10),
  PrimaryLocation: 'London, United Kingdom',
  PrimaryLocationCountry: 'GB',
  ShortDescriptionStr: '',
  secondaryLocations: [
    { Name: 'San Francisco, CA, United States', CountryCode: 'US' },
    { Name: 'London, United Kingdom', CountryCode: 'GB' },
  ],
};

test('uber: maps an Oracle requisition, US offices first, with country codes', () => {
  const detail = {
    ExternalDescriptionStr: '<p>Build payments.</p>',
    ExternalResponsibilitiesStr: '<p>Ship.</p>',
    ExternalQualificationsStr: '<p>2+ years of experience.</p>',
    ExternalPostedStartDate: '2026-11-23T06:19:44+00:00',
  };
  const row = uber.mapRequisition(UBER_REQ, detail, 'Uber');
  assert.strictEqual(row.source, 'uber');
  assert.strictEqual(row.external_id, '156028', 'same id jobs.uber.com and the old API used');
  assert.strictEqual(row.location, 'San Francisco, CA, United States; London, United Kingdom');
  assert.deepStrictEqual(row.countries, ['US', 'GB']);
  assert.strictEqual(row.apply_url, 'https://jobs.uber.com/en/jobs/156028/');
  assert.strictEqual(row.date_posted, '2026-11-23T06:19:44+00:00');
  assert.match(row.description, /Build payments[\s\S]*2\+ years/);

  // Without a detail it still maps, on the list's day-precision date.
  const bare = uber.mapRequisition(UBER_REQ, null);
  assert.strictEqual(bare.description, '');
  assert.strictEqual(bare.date_posted, UBER_REQ.PostedDate);
  assert.strictEqual(bare.company_name, 'Uber');

  // The board keeps it as a US row on the strength of the country codes.
  const n = normalizeJob(row, { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'permissive' });
  assert.ok(n, 'kept');
  assert.strictEqual(n.yoe_min, 2);
});

test('uber: the list request filters to the US location and reads the list shape', () => {
  const u = new URL(uber.listUrl(200));
  assert.strictEqual(u.host, 'iaziqy.fa.ocs.oraclecloud.com');
  assert.match(u.searchParams.get('finder'), /siteNumber=UberCareers,locationId=300000000484560,limit=200,offset=200/);
  assert.match(uber.detailUrl('156028'), /ById%3BId%3D%22156028%22%2CsiteNumber%3DUberCareers/);

  assert.deepStrictEqual(uber.listPageOf({ items: [{ TotalJobsCount: 413, requisitionList: [UBER_REQ] }] }), {
    total: 413,
    rows: [UBER_REQ],
  });
  assert.strictEqual(uber.listPageOf({ status: 'failure' }), null);
  assert.strictEqual(uber.listPageOf({ items: [] }), null);
});

test('uber: fetchCompany pages the whole US list and fetches details only for kept titles', async () => {
  const mk = (i, title, posted = daysAgo(2).slice(0, 10)) => ({
    Id: String(300000 + i),
    Title: title,
    PostedDate: posted,
    PrimaryLocation: 'Sunnyvale, CA, United States',
    PrimaryLocationCountry: 'US',
  });
  // 250 US requisitions: 3 software, 1 software but stale, the rest sales.
  const all = Array.from({ length: 250 }, (_, i) => mk(i, `Account Executive ${i}`));
  all[5] = mk(5, 'Software Engineer II - Backend');
  all[150] = mk(150, 'Machine Learning Engineer');
  all[220] = mk(220, 'Software Engineer I');
  all[230] = mk(230, 'Software Engineer', daysAgo(60).slice(0, 10));

  const offsets = [];
  const details = [];
  await withFetch(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/recruitingCEJobRequisitions')) {
      const offset = Number(/offset=(\d+)/.exec(u.searchParams.get('finder'))[1]);
      offsets.push(offset);
      return json({ items: [{ TotalJobsCount: 250, requisitionList: all.slice(offset, offset + 200) }] });
    }
    const id = /Id="(\d+)"/.exec(u.searchParams.get('finder'))[1];
    details.push(id);
    return json({ items: [{ ExternalDescriptionStr: `<p>Job ${id}. 1+ years.</p>` }] });
  }, async () => {
    const rows = await uber.fetchCompany({ displayName: 'Uber', pageDelayMs: 0, detailConcurrency: 1 });
    assert.deepStrictEqual(offsets, [0, 200]);
    assert.deepStrictEqual(rows.map((r) => r.job_title).sort(), [
      'Machine Learning Engineer',
      'Software Engineer I',
      'Software Engineer II - Backend',
    ]);
    assert.deepStrictEqual(details.sort(), ['300005', '300150', '300220']);
    assert.ok(rows.every((r) => /^<p>Job \d+\. 1\+ years\.<\/p>$/.test(r.description)));
  });
});

test('uber: a removed endpoint or an empty list fails the run instead of reporting 0 jobs', async () => {
  await withFetch(
    async () => json({ status: 'failure', data: { code: 'ERR_MISSING_HANDLER' } }, 404),
    async () => {
      await assert.rejects(uber.fetchCompany({ pageDelayMs: 0 }), /Not found/);
    }
  );
  await withFetch(
    async () => json({ items: [{ TotalJobsCount: 0, requisitionList: [] }] }),
    async () => {
      await assert.rejects(uber.fetchCompany({ pageDelayMs: 0 }), /no US requisitions/);
    }
  );
});

// ─── Phenom scraper target ────────────────────────────────────────────────────

// Trimmed from careers.cisco.com POST /widgets (refineSearch), 2026-11-24.
const CISCO_JOB = {
  jobId: '2023799',
  title: 'Software Engineer (Hybrid)',
  location: 'San Jose, California, United States of America',
  country: 'United States of America',
  postedDate: '2026-11-20T00:00:00.000+0000',
  descriptionTeaser: 'Build runtime security features.',
  applyUrl:
    'https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/San-Jose-California-US/Software-Engineer--Hybrid-_2023799/apply',
};
const CISCO = phenom.TENANTS.find((t) => t.slug === 'cisco');

test('phenom: a widgets job maps to a row with the workday collector\'s link and name', () => {
  const row = phenom.mapWidgetJob(CISCO_JOB, CISCO);
  assert.strictEqual(row.source, 'phenom');
  assert.strictEqual(row.external_id, '2023799');
  assert.strictEqual(row.company_name, 'Cisco Systems');
  assert.strictEqual(
    row.apply_url,
    'https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/San-Jose-California-US/Software-Engineer--Hybrid-_2023799'
  );
  assert.deepStrictEqual(row.countries, ['US']);
  assert.strictEqual(row.date_posted, '2026-11-20T00:00:00.000+0000');
  assert.strictEqual(row.description, 'Build runtime security features.');

  // A link that isn't the tenant's Workday site falls back to the Phenom job page.
  const other = phenom.mapWidgetJob({ ...CISCO_JOB, applyUrl: 'https://elsewhere.example/x' }, CISCO);
  assert.strictEqual(other.apply_url, 'https://careers.cisco.com/global/en/job/2023799');
  assert.strictEqual(phenom.workdayApplyUrl('not a url', CISCO.workday), null);
});

test('phenom: refineSearch parsing and the US filter in the request body', () => {
  const body = phenom.refineSearchBody({ from: 100, size: 100, pageId: 'page4', tenant: CISCO });
  assert.strictEqual(body.ddoKey, 'refineSearch');
  assert.strictEqual(body.from, 100);
  assert.deepStrictEqual(body.selected_fields, { country: ['United States of America'] });

  assert.deepStrictEqual(
    phenom.parseRefineSearch({ refineSearch: { status: 200, totalHits: 486, data: { jobs: [CISCO_JOB] } } }),
    { total: 486, jobs: [CISCO_JOB] }
  );
  assert.strictEqual(phenom.parseRefineSearch({ error: 'x' }), null);
});

test('phenom: a Cloudflare interstitial is recognised, an ordinary Cloudflare page is not', () => {
  assert.ok(phenom.isBotChallenge({ title: 'Just a moment...', html: '' }));
  assert.ok(phenom.isBotChallenge({ title: '', html: '<script>window._cf_chl_opt={cvId:"3"}</script>' }));
  assert.ok(
    !phenom.isBotChallenge({
      title: 'Search results | Cisco',
      html: '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
    })
  );
});

// A stand-in for a Playwright page: enough of goto/title/content/evaluate for
// the target. evaluate(fn) with no argument is the phApp session read;
// evaluate(fn, { body }) is a /widgets call.
function fakeContext({ title = 'Cisco Careers', pages = [], session = { csrf: 't', pageId: 'page4' } } = {}) {
  const calls = [];
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    title: async () => title,
    content: async () => '<html></html>',
    isClosed: () => false,
    close: async () => {},
    evaluate: async (_fn, arg) => {
      if (!arg) return session;
      calls.push(arg.body.from);
      const p = pages[calls.length - 1];
      return p === undefined ? { status: 500, text: 'oops' } : { status: 200, text: JSON.stringify(p) };
    },
  };
  return { calls, context: { newPage: async () => page } };
}

const widgetsPage = (total, jobs) => ({ refineSearch: { status: 200, totalHits: total, data: { jobs } } });

test('phenom: the widgets path pages by 100 until totalHits', async () => {
  const jobs = Array.from({ length: 150 }, (_, i) => ({ ...CISCO_JOB, jobId: String(3000000 + i), title: `Software Engineer ${i}` }));
  const { calls, context } = fakeContext({
    pages: [widgetsPage(150, jobs.slice(0, 100)), widgetsPage(150, jobs.slice(100))],
  });
  const rows = await phenom.run(context, { tenants: [{ ...CISCO, delayMs: 0 }] });
  assert.deepStrictEqual(calls, [0, 100]);
  assert.strictEqual(rows.length, 150);
  assert.strictEqual(new Set(rows.map((r) => r.external_id)).size, 150);
});

test('phenom: a challenged tenant fails, the others keep their rows, and all-failed throws', async () => {
  const cognizant = phenom.TENANTS.find((t) => t.slug === 'cognizant');
  const blocked = fakeContext({ title: 'Just a moment...' }).context;
  await assert.rejects(phenom.run(blocked, { tenants: [cognizant] }), /every phenom tenant failed — cognizant: bot challenge/);
  await assert.rejects(phenom.run(blocked, { tenants: [{ ...CISCO, delayMs: 0 }] }), /bot challenge/);

  // Cisco succeeds, Cognizant is challenged: Cisco's rows come back.
  const ok = fakeContext({ pages: [widgetsPage(1, [CISCO_JOB])] }).context;
  const mixed = {
    newPage: async () => {
      mixed.n = (mixed.n || 0) + 1;
      return mixed.n === 1 ? ok.newPage() : blocked.newPage();
    },
  };
  const rows = await phenom.run(mixed, { tenants: [{ ...CISCO, delayMs: 0 }, cognizant] });
  assert.strictEqual(rows.length, 1);
});

test('phenom: an empty first widgets page or a missing session is a failure, not 0 rows', async () => {
  const empty = fakeContext({ pages: [widgetsPage(0, [])] }).context;
  await assert.rejects(phenom.run(empty, { tenants: [{ ...CISCO, delayMs: 0 }] }), /returned 0 jobs/);
  const noSession = fakeContext({ session: { csrf: '', pageId: '' } }).context;
  await assert.rejects(phenom.run(noSession, { tenants: [{ ...CISCO, delayMs: 0 }] }), /no phApp session/);
});
