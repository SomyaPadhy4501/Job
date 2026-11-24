'use strict';

// Closed-job detection (src/services/closed.js): a posting the employer closed
// leaves the board after two complete runs miss it, and nothing else does.
// The store and collectors are stubbed through require.cache; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function stub(rel, exports) {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
function fresh(rel) {
  const file = require.resolve(path.join(__dirname, rel));
  delete require.cache[file];
  return require(file);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

const { planClosures, closableScopes, timeOf } = require('../src/services/closed');

// ─── The registry: who opted in ──────────────────────────────────────────────

test('closed: only full-listing ATS collectors opt in, none sharing an ingest source name', () => {
  const { REGISTRY } = fresh('../src/collectors/index.js');
  const optedIn = Object.keys(REGISTRY).filter((s) => REGISTRY[s].fullListing).sort();
  assert.deepEqual(optedIn, [
    'ashby', 'bamboohr', 'gem', 'greenhouse', 'lever', 'pinpoint', 'recruitee', 'rippling', 'smartrecruiters', 'workable',
  ]);

  // Rows the scraper or the extension send to /admin/ingest carry their own
  // source name; one shared with a collector would be judged by its listing.
  const targets = path.join(__dirname, '../scraper/src/targets');
  const ingest = new Set(['extension']);
  for (const f of fs.readdirSync(targets)) {
    for (const m of fs.readFileSync(path.join(targets, f), 'utf8').matchAll(/source: '([a-z_]+)'/g)) ingest.add(m[1]);
  }
  assert.ok(ingest.has('apple') && ingest.has('microsoft'), 'scraper targets were read');
  for (const s of optedIn) assert.ok(!ingest.has(s), `${s} is also an ingest source`);
});

// ─── The pure parts ──────────────────────────────────────────────────────────

test('closed: plan counts a miss, closes on the second, resets on a sighting', () => {
  const since = new Date().toISOString();
  const seenUrls = new Set(['boards.greenhouse.io/acme/jobs/1']);
  const rows = [
    { id: 1, apply_url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x', last_seen_at: HOUR_AGO, missed_runs: 1 },
    { id: 2, apply_url: 'https://boards.greenhouse.io/acme/jobs/2', last_seen_at: HOUR_AGO, missed_runs: 0 },
    { id: 3, apply_url: 'https://boards.greenhouse.io/acme/jobs/3', last_seen_at: HOUR_AGO, missed_runs: 1 },
    { id: 4, apply_url: 'https://relay.example/acme-3', last_seen_at: new Date().toISOString(), missed_runs: 1 },
    { id: 5, apply_url: 'https://boards.greenhouse.io/acme/jobs/5', last_seen_at: since, missed_runs: 0 },
  ];
  // 1: listed (tracking parameter aside). 2: first miss. 3: second miss.
  // 4: listed nowhere but updated during the run (another source's copy).
  const p = planClosures(rows, { seenUrls, since });
  assert.deepEqual(p, { reset: [1, 4], missed: [2], closed: [3], suspicious: false });
});

test('closed: most of a company going missing at once is held back', () => {
  const since = new Date().toISOString();
  const rows = [1, 2, 3, 4].map((id) => ({ id, apply_url: `https://x/${id}`, last_seen_at: HOUR_AGO, missed_runs: 1 }));
  const p = planClosures(rows, { seenUrls: new Set(['x/1']), since });
  assert.equal(p.suspicious, true);
  assert.deepEqual([p.missed, p.closed], [[], []]);
  // A small company closing its only two roles is not suspicious.
  assert.deepEqual(planClosures(rows.slice(0, 2), { seenUrls: new Set(), since }).closed, [1, 2]);
});

test('closed: SQLite and Postgres timestamps both read as UTC', () => {
  assert.equal(timeOf('2026-11-24 10:00:00'), Date.parse('2026-11-24T10:00:00Z'));
  assert.equal(timeOf('2026-11-24T10:00:00.000Z'), Date.parse('2026-11-24T10:00:00Z'));
});

test('closed: only complete, non-empty answers of opted-in collectors are judged', () => {
  const getCollector = (s) => ({ fullListing: s !== 'workday' });
  const row = (name) => ({ company_name: name, apply_url: 'https://x' });
  const partial = Object.assign([row('Beta')], { partial: true });
  const scopes = closableScopes(
    [
      { company: { source: 'greenhouse', slug: 'acme', displayName: 'Acme' }, ok: true, jobs: [row('Acme')] },
      { company: { source: 'lever', slug: 'beta', displayName: 'Beta' }, ok: true, jobs: partial },
      { company: { source: 'ashby', slug: 'gamma', displayName: 'Gamma' }, ok: true, jobs: [] },
      { company: { source: 'gem', slug: 'delta', displayName: 'Delta' }, ok: false, jobs: [], error: 'HTTP 503' },
      { company: { source: 'workday', slug: 'eps', displayName: 'Eps' }, ok: true, jobs: [row('Eps')] },
      // Two boards, one name: the failing one blocks the other.
      { company: { source: 'gem', slug: 'zeta-a', displayName: 'Zeta' }, ok: true, jobs: [row('Zeta')] },
      { company: { source: 'gem', slug: 'zeta-b', displayName: 'Zeta' }, ok: false, jobs: [], error: 'HTTP 429' },
      // An empty answer blocks the same way.
      { company: { source: 'pinpoint', slug: 'eta-a', displayName: 'Eta' }, ok: true, jobs: [row('Eta')] },
      { company: { source: 'pinpoint', slug: 'eta-b', displayName: 'Eta' }, ok: true, jobs: [] },
    ],
    getCollector,
  );
  assert.deepEqual(scopes, [{ source: 'greenhouse', company_name: 'Acme' }]);
});

test('smartrecruiters: paging cut short marks the listing partial', async () => {
  const run = async (failPage) => {
    stub('../src/collectors/http.js', {
      fetchJson: async (url) => {
        if (!url.includes('/postings?')) return {};
        if (new URL(url).searchParams.get('offset') !== '0') {
          if (failPage) throw new Error('HTTP 503');
          return { content: [] };
        }
        return { totalFound: failPage ? 150 : 1, content: [{ id: 'p1', name: 'Software Engineer', location: { city: 'Austin', region: 'TX', country: 'us' } }] };
      },
      runWithConcurrency: async (items, _n, worker) => Promise.all(items.map(worker)),
    });
    return fresh('../src/collectors/smartrecruiters.js').fetchCompany({ slug: 'Acme', displayName: 'Acme' });
  };
  const cut = await run(true);
  assert.equal(cut.length, 1);
  assert.equal(cut.partial, true);
  assert.equal((await run(false)).partial, undefined);
  delete require.cache[require.resolve('../src/collectors/http.js')];
});

// ─── collectAll end to end, against an in-memory store ───────────────────────

function memoryStore() {
  const rows = [];
  let nextId = 1;
  const store = {
    rows,
    startRun: async () => 1,
    finishRun: async () => {},
    pruneStaleJobs: async () => 0,
    deleteByApplyUrls: async () => 0,
    // Same matching as upsertJob: link first, then dedupe_key. Source and
    // company name stay as first inserted.
    bulkUpsert: async (list) => {
      let inserted = 0;
      let updated = 0;
      for (const job of list) {
        const hit = rows.find((r) => r.apply_url === job.apply_url) || rows.find((r) => r.dedupe_key === job.dedupe_key);
        const ts = new Date().toISOString();
        if (hit) {
          Object.assign(hit, { apply_url: job.apply_url, last_seen_at: ts });
          updated++;
        } else {
          rows.push({ ...job, id: nextId++, last_seen_at: ts, missed_runs: 0 });
          inserted++;
        }
      }
      return { inserted, updated, failed: 0 };
    },
    jobsForCompanies: async (source, names) =>
      rows.filter((r) => r.source === source && names.includes(r.company_name)).map((r) => ({ ...r })),
    recordMisses: async ({ reset, missed, closed }, since) => {
      const before = (r) => r.last_seen_at < since;
      for (const r of rows) {
        if (reset.includes(r.id)) r.missed_runs = 0;
        if (missed.includes(r.id) && before(r)) r.missed_runs++;
      }
      const gone = rows.filter((r) => closed.includes(r.id) && before(r));
      for (const r of gone) rows.splice(rows.indexOf(r), 1);
      return gone.length;
    },
  };
  return store;
}

function job(source, company, n, url) {
  return {
    source,
    external_id: String(n),
    company_name: company,
    job_title: `Software Engineer, New Grad ${['Payments', 'Search', 'Ads', 'Infra', 'Data'][n]}`,
    location: 'San Francisco, CA',
    apply_url: url || `https://boards.example/${company.toLowerCase()}/jobs/${n}`,
    description: 'Build things.',
    date_posted: new Date().toISOString(),
  };
}

function setup() {
  const store = memoryStore();
  const answers = {}; // slug -> rows, or an Error to throw
  stub('../src/db/index.js', store);
  stub('../src/collectors/index.js', {
    getCollector: (source) => ({
      fullListing: ['greenhouse'].includes(source),
      fetchCompany: async ({ slug }) => {
        const a = answers[slug];
        if (a instanceof Error) throw a;
        return a || [];
      },
    }),
  });
  const { collectAll } = fresh('../src/services/collect.js');
  const companies = [
    { source: 'greenhouse', slug: 'acme', displayName: 'Acme' },
    { source: 'workday', slug: 'wd', displayName: 'Wdco' },
    { source: 'ghlistings', slug: 'list', displayName: 'list' },
  ];
  // Runs start strictly after the previous run's writes, as in production.
  const run = async () => {
    await sleep(5);
    return collectAll({ companies });
  };
  const titles = () => store.rows.map((r) => r.job_title.split(' ').pop()).sort();
  return { store, answers, run, titles };
}

test('collectAll: a closed posting goes after two complete runs miss it; failures and empty answers never count', async () => {
  const { answers, run, titles } = setup();
  const acme = (...ns) => ns.map((n) => job('greenhouse', 'Acme', n));

  answers.acme = acme(0, 1, 2);
  await run();
  assert.deepEqual(titles(), ['Ads', 'Payments', 'Search']);

  answers.acme = acme(0, 1); // Ads closed
  assert.equal((await run()).closed, 0, 'one miss only');
  answers.acme = new Error('HTTP 503');
  assert.equal((await run()).closed, 0, 'a failed fetch is not a miss');
  answers.acme = [];
  assert.equal((await run()).closed, 0, 'an empty answer is not a miss');
  assert.deepEqual(titles(), ['Ads', 'Payments', 'Search']);

  answers.acme = acme(0, 1);
  assert.equal((await run()).closed, 1);
  assert.deepEqual(titles(), ['Payments', 'Search']);
});

test('collectAll: a sighting in between starts the count over', async () => {
  const { answers, run, titles } = setup();
  const acme = (...ns) => ns.map((n) => job('greenhouse', 'Acme', n));
  answers.acme = acme(0, 1);
  await run();
  answers.acme = acme(0);
  await run();
  answers.acme = acme(0, 1); // back (a re-opened req, a flaky board)
  await run();
  answers.acme = acme(0);
  assert.equal((await run()).closed, 0);
  assert.deepEqual(titles(), ['Payments', 'Search']);
});

test('collectAll: a job another source still lists stays, under the same link or another', async () => {
  const { answers, run, titles } = setup();
  answers.acme = [0, 1, 2].map((n) => job('greenhouse', 'Acme', n));
  await run();
  // Greenhouse drops Search and Ads; the GitHub list relays Search by the same
  // link and Ads by its own link (merged on the company|title|location key).
  answers.acme = [job('greenhouse', 'Acme', 0)];
  answers.list = [job('ghlistings', 'Acme', 1), job('ghlistings', 'Acme', 2, 'https://relay.example/acme-ads')];
  await run();
  await run();
  assert.equal((await run()).closed, 0);
  assert.deepEqual(titles(), ['Ads', 'Payments', 'Search']);
});

test('collectAll: sources without a full listing are never judged', async () => {
  const { answers, run, store } = setup();
  answers.wd = [job('workday', 'Wdco', 0), job('workday', 'Wdco', 1)];
  answers.list = [job('ghlistings', 'Listco', 3)];
  await run();
  answers.wd = [job('workday', 'Wdco', 0)];
  answers.list = [job('ghlistings', 'Listco', 4)];
  await run();
  await run();
  assert.equal(store.rows.length, 4);
});

test('collectAll: closing runs after the retention sweep, so rows past retention never skew it', async () => {
  const { answers, store } = setup();
  const order = [];
  const list = store.jobsForCompanies;
  store.pruneStaleJobs = async () => (order.push('prune'), 0);
  store.jobsForCompanies = async (...a) => (order.push('close'), list(...a));
  const { collectAll } = fresh('../src/services/collect.js');
  answers.acme = [job('greenhouse', 'Acme', 0)];
  await collectAll({ companies: [{ source: 'greenhouse', slug: 'acme', displayName: 'Acme' }] });
  assert.deepEqual(order, ['prune', 'close']);
});

test('collectAll: without migration 006 the step is skipped and the run completes', async () => {
  const { answers, store } = setup();
  store.jobsForCompanies = async () => {
    throw Object.assign(new Error('column "missed_runs" does not exist'), { code: '42703' });
  };
  // collect.js reads the store's functions when it loads.
  const { collectAll } = fresh('../src/services/collect.js');
  answers.acme = [job('greenhouse', 'Acme', 0)];
  const r = await collectAll({ companies: [{ source: 'greenhouse', slug: 'acme', displayName: 'Acme' }] });
  assert.equal(r.closed, 0);
  assert.equal(r.inserted, 1);
});

// ─── SQLite store (skipped where better-sqlite3 has no build, e.g. Node 26) ──

let sqliteOk = true;
try {
  new (require('better-sqlite3'))(':memory:').close();
} catch {
  sqliteOk = false;
}

test('sqlite: misses are counted and closed rows deleted, never a row seen since the run began', { skip: !sqliteOk && 'better-sqlite3 not built for this Node' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-'));
  process.env.DB_PATH = path.join(dir, 'jobs.db');
  delete require.cache[require.resolve('../src/config.js')];
  const db = fresh('../src/db/sqlite.js');
  const row = (n) => ({
    dedupe_key: `acme|${n}`, source: 'greenhouse', external_id: String(n), company_name: 'Acme',
    job_title: `Software Engineer ${n}`, location: 'Austin, TX', apply_url: `https://x/${n}`, description: '',
    date_posted: null, sponsorship: 'UNKNOWN', role_type: 'SWE', category: '', is_entry_level: 1,
    is_mid_level: 0, restriction: '', yoe_min: -1,
  });
  await db.bulkUpsert([row(1), row(2), row(3)]);
  db.getDb().prepare("UPDATE jobs SET last_seen_at = datetime('now', '-1 hour')").run();
  db.getDb().prepare("UPDATE jobs SET last_seen_at = datetime('now', '+1 minute') WHERE id = 3").run();

  const since = new Date().toISOString();
  const [a, b, c] = db.jobsForCompanies('greenhouse', ['Acme']).sort((x, y) => x.id - y.id);
  assert.equal(a.missed_runs, 0);
  assert.equal(db.recordMisses({ reset: [], missed: [a.id], closed: [b.id, c.id] }, since), 1);
  const left = db.jobsForCompanies('greenhouse', ['Acme']).map((r) => [r.id, r.missed_runs]);
  assert.deepEqual(left.sort(), [[a.id, 1], [c.id, 0]]);
  db.getDb().close();
});
