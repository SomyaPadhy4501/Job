'use strict';

// Regression tests for the TikTok / ByteDance collector (src/collectors/bytedance.js).
//
// The fixtures are trimmed copies of real responses from api.lifeattiktok.com
// and jobs.bytedance.com (2026-11-23). Descriptions are cut short; the nesting,
// the null `name` fields and jobs.bytedance.com's Chinese ones are as served.

const test = require('node:test');
const assert = require('node:assert');

const bd = require('../src/collectors/bytedance');
const { COMPANIES } = require('../src/config');
const { normalizeJob } = require('../src/services/normalize');

const TIKTOK = COMPANIES.find((c) => c.source === 'bytedance' && c.slug === 'tiktok');
const BYTEDANCE = COMPANIES.find((c) => c.source === 'bytedance' && c.slug === 'bytedance');

const US_ONLY = { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'permissive', retentionDays: 14 };

// A posting id published `daysAgo` days ago: the top 32 bits are Unix seconds.
// Relative to now, so the fixture doesn't age out of the retention window.
const idAt = (daysAgo) =>
  ((BigInt(Math.floor(Date.now() / 1000 - daysAgo * 86400)) << 32n) | 0xad4f0935n).toString();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAN_JOSE = {
  code: 'CT_1103355', location_type: 3, name: null, en_name: 'San Jose', i18n_name: 'San Jose',
  parent: {
    code: 'ST_31', location_type: 2, name: null, en_name: 'California', i18n_name: 'California',
    parent: { code: 'CN_6', location_type: 1, name: null, en_name: 'United States of America', i18n_name: 'United States of America', parent: null },
  },
};
const SEATTLE = {
  code: 'CT_157', location_type: 3, name: null, en_name: 'Seattle', i18n_name: 'Seattle',
  parent: {
    code: 'ST_54', location_type: 2, name: null, en_name: 'Washington', i18n_name: 'Washington',
    parent: { code: 'CN_6', location_type: 1, name: null, en_name: 'United States of America', i18n_name: 'United States of America', parent: null },
  },
};
const SINGAPORE = {
  code: 'CT_163', location_type: 3, name: null, en_name: 'Singapore', i18n_name: 'Singapore',
  parent: {
    code: 'ST_100785', location_type: 2, name: null, en_name: 'Singapore', i18n_name: 'Singapore',
    parent: { code: 'CN_25', location_type: 1, name: null, en_name: 'Singapore', i18n_name: 'Singapore', parent: null },
  },
};
const CAIRO = {
  code: 'CT_79', location_type: 3, name: null, en_name: 'Cairo', i18n_name: 'Cairo',
  parent: {
    code: 'ST_38', location_type: 2, name: null, en_name: 'Cairo', i18n_name: 'Cairo',
    parent: { code: 'CN_14', location_type: 1, name: null, en_name: 'Egypt', i18n_name: 'Egypt', parent: null },
  },
};

// TikTok campus posting: recruit type "Regular", program tag on job_subject.
const TT_GRAD = {
  id: '7663042453461600517',
  code: 'A130616C',
  title: 'Backend Software Engineer Graduate (Business Governance) - 2027 Start',
  description: 'The Trust and Safety(TnS) engineering team is responsible for protecting our users from harmful content and abusive behaviors.',
  requirement: "Minimum Qualifications:\n- Individuals who are completing or have recently completed a Bachelor's or above degree in computer science or a related discipline.",
  recruit_type: { id: '201', name: null, en_name: 'Regular', i18n_name: 'Regular' },
  job_category: { id: '6704215862603155720', name: null, en_name: 'R&D', i18n_name: 'R&D', parent: null },
  city_info: SAN_JOSE,
  job_subject: { id: '7602165694713678133', name: null, en_name: 'Bachelor/Master Graduate - 2027 Start', i18n_name: 'Bachelor/Master Graduate - 2027 Start' },
};

const TT_INTERN = {
  id: '7668696895234197813',
  code: 'A174918',
  title: 'Software Engineer Intern (ML Infra) - 2027 Start (PhD)',
  description: 'The ads system at TikTok operates on a massive scale and serves millions of advertisers, clients and influencers across the world.',
  requirement: 'Minimum Qualifications:\n- Currently pursuing a PhD degree in Computer Science, AI, Machine Learning or a related discipline.',
  recruit_type: { id: '202', name: null, en_name: 'Intern', i18n_name: 'Intern' },
  city_info: SAN_JOSE,
  job_subject: { id: '7602166391986194741', name: null, en_name: 'PhD Intern - 2027 Start', i18n_name: 'PhD Intern - 2027 Start' },
};

const TT_SINGAPORE = {
  id: '7314683321684936987',
  code: 'A87772',
  title: 'Backend Software Engineer - TikTok Shop（SEA)',
  description: 'About the team\nThe e-commerce industry has seen tremendous growth in recent years.',
  requirement: "Minimum Qualifications\n- Bachelor's or higher degree in Computer Science.",
  recruit_type: { id: '101', name: null, en_name: 'Regular', i18n_name: 'Regular' },
  city_info: SINGAPORE,
  job_subject: null,
};

// jobs.bytedance.com fills `name` with Chinese and en_name with English.
const BD_ROW = {
  id: '7617931526848104757',
  code: 'A157549B',
  title: 'Backend Software Engineer - Platforms',
  description: "The DCS platform team's goal is to build all the necessary and advanced tooling to support full-lifecycle operation of data centers.",
  requirement: 'Minimum Qualifications\n- BS degree in Computer Science, similar technical field of study or equivalent practical experience.',
  recruit_type: { id: '101', name: '正式', en_name: 'Regular', i18n_name: 'Regular' },
  job_category: { id: '6704215862603155720', name: '研发', en_name: 'R&D', i18n_name: 'R&D', parent: null },
  city_info: {
    code: 'CT_1103355', location_type: 3, name: '圣何塞', en_name: 'San Jose', i18n_name: 'San Jose',
    parent: {
      code: 'ST_31', location_type: 2, name: '加利福尼亚州', en_name: 'California', i18n_name: 'California',
      parent: { code: 'CN_6', location_type: 1, name: '美国', en_name: 'United States of America', i18n_name: 'United States of America', parent: null },
    },
  },
  job_subject: null,
};

// ─── Field mapping ────────────────────────────────────────────────────────────

test('bytedance: maps a TikTok search row without network access', () => {
  const row = bd.mapPosting(TT_GRAD, TIKTOK);
  assert.strictEqual(row.source, 'bytedance');
  assert.strictEqual(row.external_id, '7663042453461600517');
  assert.strictEqual(row.company_name, 'TikTok');
  assert.strictEqual(row.job_title, TT_GRAD.title);
  assert.strictEqual(row.location, 'San Jose, California, United States');
  assert.deepStrictEqual(row.countries, ['US']);
  assert.strictEqual(row.apply_url, 'https://lifeattiktok.com/search/7663042453461600517');
  // The qualifications arrive in the search row itself: no detail request.
  assert.match(row.description, /^The Trust and Safety/);
  assert.match(row.description, /\n\nMinimum Qualifications:\n- Individuals who are completing/);
  assert.strictEqual(row.date_posted, '2026-07-16T08:38:26.000Z');
});

// Search rows carry no date field. The older API's publish_time for this
// posting was 2026-09-02T17:25:17Z: the id's creation time, ten minutes earlier.
test('bytedance: the posting id carries its publish date', () => {
  assert.strictEqual(bd.postedAt('7680987768009754885'), '2026-09-02T17:15:25.000Z');
  // Not an id, before the platform existed, or in the future: no date rather
  // than a wrong one.
  for (const bad of [null, undefined, '', 'A130616C', '12345', '9'.repeat(19)]) {
    assert.strictEqual(bd.postedAt(bad), null, String(bad));
  }
});

// The search's location filter matches city codes only: the US country code
// (CN_6) returns 0 rows, and returned them silently.
test('bytedance: US city codes come from the filter config', () => {
  assert.deepStrictEqual(bd.usCityCodes([CAIRO, SAN_JOSE, SINGAPORE, SEATTLE]), ['CT_1103355', 'CT_157']);
  assert.deepStrictEqual(bd.usCityCodes(undefined), []);
});

test("bytedance: places are read in English, not jobs.bytedance.com's Chinese names", () => {
  const row = bd.mapPosting(BD_ROW, BYTEDANCE);
  assert.strictEqual(row.location, 'San Jose, California, United States');
  assert.strictEqual(row.company_name, 'ByteDance');
  assert.strictEqual(row.apply_url, 'https://joinbytedance.com/search/7617931526848104757');
  // City, state and country all named "Singapore" collapse to one.
  assert.strictEqual(bd.locationText(SINGAPORE), 'Singapore');
  assert.deepStrictEqual(bd.mapPosting(TT_SINGAPORE, TIKTOK).countries, ['Singapore']);
});

// Titles like "Software Engineer Graduate (…) - 2027 Start" carry no word
// normalize reads as entry level. The program on job_subject does.
test('bytedance: graduate programs are entry level; intern programs and experienced roles are not', () => {
  assert.strictEqual(bd.mapPosting(TT_GRAD, TIKTOK).entry_level_override, 1);
  assert.strictEqual(bd.mapPosting(BD_ROW, BYTEDANCE).entry_level_override, undefined);
  const program = (en_name) => ({ job_subject: { en_name } });
  for (const s of [
    'PhD Graduates - 2027 Start',
    'Global Frontier Tech Recruitment Program - 2027 Grad',
    'Seed Foundation Model Campus Recruitment - Graduates',
  ]) {
    assert.ok(bd.isGraduateProgram(program(s)), s);
  }
  // "Undergraduate" contains "grad".
  for (const s of [
    'Undergraduate/Master Intern - 2027 Start',
    'PhD Intern - 2027 Start',
    'Project Intern',
    'Global Frontier Tech Recruitment Program - Intern',
  ]) {
    assert.ok(!bd.isGraduateProgram(program(s)), s);
  }
});

// ─── Paging and filtering (no network: `post` is injected) ────────────────────

const FILTERS = { code: 0, data: { city_list: [CAIRO, SAN_JOSE, SINGAPORE, SEATTLE] } };

function fakeApi(pagesByOffset, count) {
  const calls = [];
  const post = async (path, body) => {
    calls.push({ path, body });
    if (path === '/config/job/filters') return FILTERS;
    const list = pagesByOffset[body.offset];
    if (list instanceof Error) throw list;
    return { code: 0, message: 'ok', data: { count, job_post_list: list || [] } };
  };
  return { post, calls };
}

test('bytedance: fetchCompany reads every US page and keeps rows that pass the title gates', async () => {
  const SENIOR = { ...BD_ROW, id: '7617931526848104001', title: 'Senior Backend Software Engineer - Platforms' };
  const NOT_SOFTWARE = { ...BD_ROW, id: '7710034115379005749', title: 'Ops Communications Leader' };
  // An intern posting whose title doesn't say so: the recruit type catches it.
  const QUIET_INTERN = { ...TT_INTERN, id: '7668696895234197999', title: 'Software Engineer (ML Infra) - 2027 Start (PhD)' };
  // The first page came back with 3 rows, so the rest are read 3 at a time.
  const { post, calls } = fakeApi(
    {
      0: [TT_GRAD, TT_INTERN, SENIOR],
      3: [TT_SINGAPORE, NOT_SOFTWARE, TT_GRAD], // TT_GRAD repeated: the index moved
      6: [BD_ROW, QUIET_INTERN],
    },
    8
  );
  const rows = await bd.fetchCompany(TIKTOK, { post, delayMs: 0 });

  // SENIOR passes the title gate: normalize's levelVerdict reads its posting.
  assert.deepStrictEqual(rows.map((r) => r.external_id), [TT_GRAD.id, SENIOR.id, BD_ROW.id]);
  assert.strictEqual(calls[0].path, '/config/job/filters');
  const searches = calls.filter((c) => c.path === '/search/job/posts');
  assert.deepStrictEqual(searches.map((c) => c.body.offset).sort((a, b) => a - b), [0, 3, 6]);
  for (const { body } of searches) {
    assert.deepStrictEqual(body.location_code_list, ['CT_1103355', 'CT_157']);
    assert.strictEqual(body.keyword, '');
  }
});

test('bytedance: a failed later page keeps the pages that came back', async () => {
  const { post } = fakeApi({ 0: [TT_GRAD], 1: new Error('HTTP 429'), 2: [BD_ROW] }, 3);
  const warn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const rows = await bd.fetchCompany(TIKTOK, { post, delayMs: 0 });
    assert.deepStrictEqual(rows.map((r) => r.external_id), [TT_GRAD.id, BD_ROW.id]);
  } finally {
    console.warn = warn;
  }
  assert.match(warnings.join('\n'), /1 of 3 pages failed/);
});

// An empty result would read as "TikTok has no US jobs" in the run log.
test('bytedance: a refused or empty search fails loudly', async () => {
  const opts = (post) => ({ post, delayMs: 0 });
  await assert.rejects(
    bd.fetchCompany(TIKTOK, opts(async (path) => (path === '/config/job/filters'
      ? FILTERS
      : { code: -9000002, data: null, message: 'Server request failed' }))),
    /code -9000002/
  );
  await assert.rejects(
    bd.fetchCompany(TIKTOK, opts(async () => ({ code: 0, data: { city_list: [CAIRO, SINGAPORE] } }))),
    /no US cities/
  );
  await assert.rejects(bd.fetchCompany(TIKTOK, opts(fakeApi({}, 0).post)), /found 0 US postings/);
  await assert.rejects(bd.fetchCompany({ source: 'bytedance', slug: 'x' }), /missing apiBase/);
});

// ─── Through normalize ────────────────────────────────────────────────────────

test('bytedance: a fresh graduate posting passes normalize as entry level; a months-old one ages out', () => {
  const fresh = bd.mapPosting({ ...TT_GRAD, id: idAt(2) }, TIKTOK);
  const n = normalizeJob(fresh, US_ONLY);
  assert.ok(n, 'a posting published 2 days ago is kept');
  assert.strictEqual(n.is_entry_level, 1, 'the program tag, not the title, makes it entry level');
  assert.strictEqual(n.sponsorship, 'YES'); // USCIS: TikTok, 1,087 approvals
  assert.strictEqual(n.date_posted, fresh.date_posted);
  assert.strictEqual(normalizeJob(bd.mapPosting({ ...BD_ROW, id: idAt(1) }, BYTEDANCE), US_ONLY)?.sponsorship, 'YES');

  // The real posting is from July 2026. Retention drops it, as it drops the
  // new-grad lists' copies of it.
  assert.strictEqual(normalizeJob(bd.mapPosting(TT_GRAD, TIKTOK), US_ONLY), null);
});

test('bytedance: registered, with both sites configured', () => {
  const { REGISTRY } = require('../src/collectors');
  assert.strictEqual(REGISTRY.bytedance, bd);
  const entries = COMPANIES.filter((c) => c.source === 'bytedance');
  assert.deepStrictEqual(entries.map((c) => c.slug).sort(), ['bytedance', 'tiktok']);
  for (const c of entries) {
    assert.ok(c.displayName && c.websitePath && c.applyUrlBase, `${c.slug} missing a site setting`);
    assert.match(c.apiBase, /\/api\/v1\/public\/supplier$/, `${c.slug} apiBase`);
  }
});
