'use strict';

// The collector failing quietly: each case below reproduces a run that used to
// report success while losing data (2026-11-24 audit).
//   - collectAll didn't await the Postgres store, so the run id was a Promise
//     and the prune / run log raced the process exit.
//   - one bad row rolled back the whole run's upsert.
//   - a failed first page read as "0 jobs" instead of a failed company.
//   - jsonld fetched postings its sitemap already dated past retention.
// Modules are stubbed through require.cache; nothing here touches the network
// or a database.

const test = require('node:test');
const assert = require('node:assert/strict');
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
const tick = () => new Promise((r) => setTimeout(r, 5));

test('collectAll awaits an async store: run id, prune and run log all complete', async () => {
  const calls = [];
  stub('../src/db/index.js', {
    startRun: async () => (await tick(), 7),
    bulkUpsert: async (rows) => (await tick(), { inserted: rows.length, updated: 0, failed: 1 }),
    deleteByApplyUrls: async () => 0,
    pruneStaleJobs: async () => (await tick(), calls.push('prune'), 3),
    finishRun: async (id, stats) => (await tick(), calls.push(['finish', id, stats.jobs_inserted])),
  });
  stub('../src/collectors/index.js', {
    getCollector: () => ({
      fetchCompany: async () => [
        {
          source: 'greenhouse',
          external_id: '1',
          company_name: 'Acme',
          job_title: 'Software Engineer, New Grad',
          location: 'San Francisco, CA',
          apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
          description: 'Build things.',
          date_posted: new Date().toISOString(),
        },
      ],
    }),
  });
  const { collectAll } = fresh('../src/services/collect.js');
  const result = await collectAll({ companies: [{ source: 'greenhouse', slug: 'acme' }] });

  assert.equal(result.runId, 7);
  assert.equal(result.rowsFailed, 1);
  assert.deepEqual(calls, ['prune', ['finish', 7, result.inserted]], 'prune and finishRun done before return');
});

test('pg bulkUpsert: a bad row is skipped, the rest of its chunk is kept', async () => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  const log = [];
  class FakeClient {
    async query(sql, params = []) {
      const s = sql.trim().split(/\s+/).slice(0, 2).join(' ');
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(s)) {
        log.push(s);
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT/i.test(s)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO jobs/.test(sql) && params.includes('https://x/bad')) throw new Error('duplicate key');
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    release() {}
  }
  stub('../node_modules/pg/lib/index.js', {
    Pool: class {
      on() {}
      connect() {
        return new FakeClient();
      }
      query(...a) {
        return new FakeClient().query(...a);
      }
    },
  });
  const pg = fresh('../src/db/pg.js');
  const row = (url) => ({ apply_url: url, dedupe_key: url, job_title: 't', company_name: 'c', location: '' });
  const r = await pg.bulkUpsert([row('https://x/1'), row('https://x/bad'), row('https://x/2')]);

  assert.deepEqual(r, { inserted: 2, updated: 0, failed: 1 });
  assert.ok(log.includes('ROLLBACK TO'), 'only the bad row was rolled back');
  assert.equal(log.at(-1), 'COMMIT');
});

test('pcsx: every query failing is a failed company, not zero jobs', async () => {
  stub('../src/collectors/http.js', {
    fetchJson: async () => {
      throw new Error('HTTP 503');
    },
    runWithConcurrency: async () => [],
  });
  const pcsx = fresh('../src/collectors/pcsx.js');
  await assert.rejects(
    pcsx.fetchCompany({ slug: 'q', apiBase: 'https://q.example/api/pcsx/search', domain: 'q.com', applyUrlBase: 'https://q.example/careers' }),
    /HTTP 503/,
  );
});

test('pcsx: a later page failing keeps the rows already read', async () => {
  stub('../src/collectors/http.js', {
    fetchJson: async (url) => {
      const start = Number(new URL(url).searchParams.get('start'));
      if (start > 0) throw new Error('HTTP 429');
      return { data: { count: 50, positions: [{ id: 'p1', name: 'Software Engineer', locations: ['Austin, TX, US'] }] } };
    },
    runWithConcurrency: async () => [],
  });
  const pcsx = fresh('../src/collectors/pcsx.js');
  const rows = await pcsx.fetchCompany({ slug: 'q', apiBase: 'https://q.example/api/pcsx/search', domain: 'q.com', applyUrlBase: 'https://q.example/careers' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_id, 'p1');
});

test('jsonld: lastmod skips stale postings; every page refused fails the company', async () => {
  delete require.cache[require.resolve('../src/collectors/http.js')];
  const jsonld = fresh('../src/collectors/jsonld.js');
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const xml =
    `<urlset><url><loc>https://co.example/careers/job/software-engineer/1</loc><lastmod>${now}</lastmod></url>` +
    `<url><loc>https://co.example/careers/job/software-engineer-ii/2</loc><lastmod>${old}</lastmod></url>` +
    `<url><loc>https://co.example/careers/job/retail-associate/3</loc><lastmod>${now}</lastmod></url></urlset>`;

  const entries = jsonld.extractSitemapEntries(xml, '/careers/job/');
  assert.equal(entries.length, 3);
  assert.equal(entries[1].lastmod, old);
  assert.equal(jsonld.isFresh(old, 14), false);
  assert.equal(jsonld.isFresh(null, 14), true, 'no lastmod: fetch it');

  const fetched = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    fetched.push(url);
    if (url.endsWith('.xml')) return new Response(xml);
    return new Response('blocked', { status: 403 });
  };
  try {
    await assert.rejects(
      jsonld.fetchCompany({ slug: 'co', sitemapUrl: 'https://co.example/sitemap.xml', jobPath: '/careers/job/' }),
      /all 1 job pages failed/,
    );
  } finally {
    global.fetch = realFetch;
  }
  assert.deepEqual(fetched, ['https://co.example/sitemap.xml', 'https://co.example/careers/job/software-engineer/1']);
});
