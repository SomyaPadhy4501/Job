'use strict';

// In-batch dedupe: one job seen twice collapses to its best copy, while
// separate openings an employer lists under the same title and location each
// keep a row (owner's call, 2026-11-23).

const test = require('node:test');
const assert = require('node:assert');
const { dedupeBatch } = require('../src/services/dedupe');
const { buildDedupeKey } = require('../src/services/normalize');

// Rows as normalizeJob returns them, dedupe_key included.
const row = (r) => ({ external_id: null, description: '', ...r, dedupe_key: buildDedupeKey(r.company_name, r.job_title, r.location) });

const PANW_LOC = 'Office - USA - CA - Headquarters';
const PANW_KEY = buildDedupeKey('Palo Alto Networks', 'Software Engineer', PANW_LOC);
const panw = (req, extra = {}) =>
  row({
    source: 'workday',
    external_id: req,
    company_name: 'Palo Alto Networks',
    job_title: 'Software Engineer',
    location: PANW_LOC,
    apply_url: `https://paloaltonetworks.wd5.myworkdayjobs.com/en-US/panwexternalcareers/job/Santa-Clara/Software-Engineer_${req}`,
    ...extra,
  });

test('separate openings one employer lists under the same title and location each keep a row', () => {
  const out = dedupeBatch([panw('JR1'), panw('JR2'), panw('JR3')]);
  assert.deepStrictEqual(out.map((r) => r.dedupe_key), [`${PANW_KEY}#JR1`, `${PANW_KEY}#JR2`, `${PANW_KEY}#JR3`]);
});

test('a single opening keeps the plain key, and its best copy wins as before', () => {
  const direct = row({
    source: 'workday',
    external_id: 'R5',
    company_name: 'Nvidia',
    job_title: 'Software Engineer',
    location: 'Santa Clara, CA',
    apply_url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/Santa-Clara/Software-Engineer_R5',
  });
  const relayed = { ...direct, source: 'ghlistings', external_id: null, apply_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/R5' };
  const out = dedupeBatch([relayed, direct]);
  assert.deepStrictEqual(out.map((r) => [r.source, r.dedupe_key]), [['workday', direct.dedupe_key]]);
});

test('one req posted on two of the employer\'s Workday sites is one opening', () => {
  const main = row({
    source: 'workday',
    external_id: 'R100',
    company_name: 'Cadence Design',
    job_title: 'Software Engineer',
    location: 'San Jose, CA',
    apply_url: 'https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers/job/San-Jose/Software-Engineer_R100',
  });
  const univ = { ...main, apply_url: main.apply_url.replace('External_Careers', 'Univ_Careers'), description: 'Build EDA tools.' };
  const out = dedupeBatch([main, univ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].description, 'Build EDA tools.', 'the described copy wins');
  assert.strictEqual(out[0].dedupe_key, main.dedupe_key, 'one opening keeps the plain key');
});

test("an aggregator's copy joins the opening it links to; an unmatched one is dropped as a relay", () => {
  const relayed = row({
    source: 'ghlistings',
    company_name: 'Palo Alto Networks',
    job_title: 'Software Engineer',
    location: PANW_LOC,
    apply_url: 'https://jobs.paloaltonetworks.com/en/jobs/software-engineer',
  });
  const sameLink = { ...relayed, source: 'getro', external_id: 'a16z:9', apply_url: `${panw('JR2').apply_url}?utm_source=getro`, description: 'Full JD.' };
  const out = dedupeBatch([panw('JR1'), relayed, panw('JR2'), sameLink]);
  // The described Getro copy of JR2 beats the bare Workday one, under JR2's key.
  assert.deepStrictEqual(out.map((r) => [r.source, r.dedupe_key]), [
    ['workday', `${PANW_KEY}#JR1`],
    ['getro', `${PANW_KEY}#JR2`],
  ]);
});

test('aggregator copies keep collapsing: Getro tags one job differently in each VC network', () => {
  const getro = (network, job) =>
    row({
      source: 'getro',
      external_id: `${network}:77`,
      company_name: 'Cribl',
      job_title: 'Software Engineer',
      location: 'Remote - US',
      apply_url: `https://boards.greenhouse.io/cribl/jobs/${job}`,
    });
  const out = dedupeBatch([getro('a16z', 1), getro('sequoia', 1), getro('accel', 2)]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].dedupe_key, buildDedupeKey('Cribl', 'Software Engineer', 'Remote - US'));
});

test('when two direct boards each list several, the one listing more keeps them', () => {
  const hp = (source, n) =>
    row({
      source,
      external_id: `${source}-${n}`,
      company_name: 'HP',
      job_title: 'Software Engineer',
      location: 'Palo Alto, CA',
      apply_url: `https://example.com/hp/${source}/${n}`,
    });
  const out = dedupeBatch([hp('greenhouse', 1), hp('greenhouse', 2), hp('workday', 1), hp('workday', 2), hp('workday', 3)]);
  assert.deepStrictEqual(out.map((r) => r.external_id), ['workday-1', 'workday-2', 'workday-3']);
});

test('without a posting id, different links are different openings and the same link is one', () => {
  const deloitte = (path) =>
    row({
      source: 'deloitte',
      company_name: 'Deloitte',
      job_title: 'Software Engineer',
      location: 'Atlanta, GA',
      apply_url: `https://apply.deloitte.com/careers/JobDetail/${path}`,
    });
  const out = dedupeBatch([deloitte('1'), deloitte('2'), deloitte('2?utm_source=linkedin')]);
  assert.deepStrictEqual(out.map((r) => r.apply_url), ['https://apply.deloitte.com/careers/JobDetail/1', 'https://apply.deloitte.com/careers/JobDetail/2']);
});
