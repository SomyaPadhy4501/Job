'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, validate, excerpt } = require('../src/services/ai-tags');
const { tagJobs, sponsorshipFor } = require('../src/services/ai-tagger');
const samples = require('./tag-examples.json');

const answer = async (posting) => samples.find((s) => posting.description.startsWith(s.description.slice(0, 200))).expected;

function job(sample, extra = {}) {
  return {
    apply_url: sample.apply_url, job_title: sample.job_title, description: sample.description,
    company_name: 'Tiny Startup Nobody Sponsors', source: 'greenhouse', date_posted: '2026-11-20',
    role_type: 'SWE', sponsorship: 'UNKNOWN', restriction: '', ...extra,
  };
}
const run = (jobs, opts = {}) => tagJobs(jobs, {
  lookup: async () => [], options: { model: 'fixture' }, limit: 100, deadline: Date.now() + 60_000, infer: answer, ...opts,
});

test('requires literal, decision-relevant evidence', () => {
  const sample = samples[0];
  assert.throws(() => validate(sample.expected, 'No evidence here.'));
  assert.throws(() => validate({ ...sample.expected, reason: 'refused' }, sample.description));
  assert.throws(() => validate(null, sample.description), /shape/);
});

test('a long JD keeps its opening and its sponsorship lines within the model context', async () => {
  const sample = samples[0];
  const filler = Array.from({ length: 600 }, (_, i) => `Duty ${i}: build and run services.`).join('\n');
  const long = `${sample.description}\n${filler}\nWe do not sponsor visas.`;
  const cut = excerpt(long);
  assert.ok(cut.length <= 9000, `excerpt is ${cut.length} chars`);
  assert.ok(cut.startsWith(sample.description.slice(0, 100)));
  assert.ok(cut.endsWith('We do not sponsor visas.'));
  const out = await classify({ ...sample, description: long }, { model: 'fixture' }, (p) => {
    assert.equal(p.description, cut);
    return { ...sample.expected, reason: 'refused', quote: 'We do not sponsor visas.' };
  });
  assert.equal(out.sponsorship, 'NO');
});

test('new postings get the model verdict in the existing columns', async () => {
  const jobs = samples.map((s) => job(s));
  const stats = await run(jobs);
  assert.equal(stats.tagged, samples.length);
  assert.equal(stats.failed, 0);
  for (const [i, s] of samples.entries()) {
    const want = s.expected.role_type === 'OTHER' ? 'SWE' : s.expected.role_type; // OTHER keeps the rule family
    assert.equal(jobs[i].role_type, want, s.apply_url);
    const sponsor = { offered: 'YES', refused: 'NO' }[s.expected.reason] || 'UNKNOWN';
    assert.equal(jobs[i].sponsorship, sponsor, s.apply_url);
  }
  // A refusal in the JD becomes the board's no-sponsorship restriction.
  const refused = samples.findIndex((s) => s.expected.reason === 'refused');
  assert.equal(jobs[refused].restriction, 'NO_SPONSORSHIP');
});

test('an unchanged stored posting reuses its stored tags without a model call', async () => {
  const s = samples[1];
  const stored = { apply_url: s.apply_url, job_title: s.job_title, description: s.description, role_type: 'MLE', sponsorship: 'YES', restriction: '' };
  const fresh = job(s);
  const stats = await run([fresh], { lookup: async () => [stored], infer: () => assert.fail('model called') });
  assert.deepEqual([stats.reused, stats.requested], [1, 0]);
  assert.deepEqual([fresh.role_type, fresh.sponsorship], ['MLE', 'YES']);

  // A re-fetch without a description is still the same posting.
  const empty = job(s, { description: '' });
  await run([empty], { lookup: async () => [stored], infer: () => assert.fail('model called') });
  assert.equal(empty.role_type, 'MLE');

  // Changed text is reviewed again.
  const edited = job(s, { description: s.description + '\nNew paragraph.' });
  const again = await run([edited], { lookup: async () => [stored], infer: async () => samples[0].expected });
  assert.equal(again.requested, 1);
});

test('budget and outages leave rule tags in place and stop asking', async () => {
  const jobs = samples.map((s) => job(s));
  const capped = await run(jobs, { limit: 2 });
  assert.deepEqual([capped.requested, capped.deferred], [2, samples.length - 2]);

  const rules = samples.map((s) => job(s, { role_type: 'DS', sponsorship: 'UNKNOWN' }));
  let calls = 0;
  const down = await run(rules, { infer: async () => { calls++; throw new Error('Model HTTP 503'); } });
  assert.equal(calls, 1);
  assert.ok(down.unavailable);
  assert.ok(rules.every((j) => j.role_type === 'DS' && j.sponsorship === 'UNKNOWN'));

  await assert.rejects(run(samples.map((s) => job(s)), { infer: async () => { throw new Error('Model HTTP 401'); } }), /MINA_API_KEY/);

  // A request cut off by the run's own time budget is deferred, not an outage.
  const late = await run([job(samples[0])], {
    deadline: Date.now() + 1500,
    infer: async () => {
      await new Promise((r) => setTimeout(r, 1600));
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    },
  });
  assert.deepEqual([late.unavailable, late.deferred], [false, 1]);
});

test('a JD silent on sponsorship falls back to the employer H-1B record', () => {
  const silent = { reason: 'silent' };
  assert.equal(sponsorshipFor(silent, { company_name: 'Google' }), 'YES');
  assert.equal(sponsorshipFor(silent, { company_name: 'Tiny Startup Nobody Sponsors' }), 'UNKNOWN');
  assert.equal(sponsorshipFor({ reason: 'refused' }, { company_name: 'Google' }), 'NO');
  assert.equal(sponsorshipFor({ reason: 'conflicting' }, { company_name: 'Google' }), 'UNKNOWN');
});

test('Mina uses its own model-scoped key and v1 chat route', () => {
  const { modelOptions } = require('../src/services/model-options');
  const mina = { MINA_BASE_URL: 'https://example.org/v1/', MINA_API_KEY: 'project-test' };
  const options = modelOptions(mina);
  assert.equal(options.endpoint, 'https://example.org/v1/chat/completions');
  assert.equal(options.model, 'qwen3:8b');
  assert.equal(options.key, mina.MINA_API_KEY);
  assert.throws(() => modelOptions({ ...mina, MINA_BASE_URL: 'http://example.org/v1' }));
  assert.throws(() => modelOptions({ MINA_BASE_URL: mina.MINA_BASE_URL }));
  assert.equal(modelOptions({ ...mina, MINA_BASE_URL: 'http://127.0.0.1:8091/v1' }).mina, true);
  const generic = modelOptions({ ...mina, AI_MODEL_URL: 'https://other.example/chat/completions', AI_MODEL: 'other' });
  assert.equal(generic.key, undefined);
  assert.equal(generic.model, 'other');
});

test('Mina retries a rejected answer once and validates the replacement evidence', async () => {
  const row = samples[2];
  const wrong = { ...row.expected, reason: 'silent' };
  const options = { model: 'qwen3:8b', mina: true, timeout: 90000 };
  let calls = 0;
  const tag = await classify(row, options, async (posting, settings, correction) => {
    calls++;
    if (!correction) return wrong;
    assert.deepEqual(correction.result, wrong);
    assert.match(correction.problem, /empty quote/);
    assert.ok(settings.timeout <= options.timeout);
    return row.expected;
  });
  assert.equal(calls, 2);
  assert.equal(tag.sponsorship, 'NO');
  await assert.rejects(classify(row, options, async () => wrong), /empty quote/);
});
