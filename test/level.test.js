'use strict';

// Level-filter exceptions: Palo Alto Networks' "Staff" rung, and titles that
// name a new-grad track. The generic rule ("Staff" = senior) is load-bearing,
// so both directions are pinned: the exceptions pass, and everything around
// them still fails.

const test = require('node:test');
const assert = require('node:assert');
const { passesLevel, looksSeniorReject, normalizeJob } = require('../src/services/normalize');
const { reason } = require('../src/scripts/prune-rejected');
const workday = require('../src/collectors/workday');

const PANW = 'Palo Alto Networks';
const OPTS = { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'permissive', retentionDays: 14 };
const raw = (over) => ({
  source: 'workday',
  company_name: PANW,
  job_title: 'Staff Software Engineer',
  location: 'Santa Clara, California, United States of America',
  apply_url: 'https://paloaltonetworks.wd5.myworkdayjobs.com/en-US/panwexternalcareers/job/Santa-Clara/Staff-Software-Engineer_JR1',
  description: '',
  date_posted: new Date().toISOString(),
  ...over,
});

test('Palo Alto Networks: a bare "Staff" title is not senior', () => {
  for (const title of [
    'Staff Software Engineer',
    'Staff Software Engineer, Prisma Cloud',
    'Staff Machine Learning Engineer (Cortex)',
    'Staff Site Reliability Engineer',
  ]) {
    assert.strictEqual(passesLevel(title, 'permissive', PANW), true, title);
  }
  // Aggregators append the corporate suffix.
  assert.strictEqual(passesLevel('Staff Software Engineer', 'permissive', 'Palo Alto Networks, Inc.'), true);
});

test('Palo Alto Networks: the rungs above Staff, and managers, are still rejected', () => {
  for (const title of [
    'Senior Staff Software Engineer',
    'Sr. Staff Software Engineer',
    'Principal Software Engineer',
    'Staff Software Engineering Manager',
    'Staff Engineer, Tech Lead',
    'Distinguished Engineer',
  ]) {
    assert.strictEqual(passesLevel(title, 'permissive', PANW), false, title);
  }
});

test('"Staff" stays senior at every other employer', () => {
  for (const company of ['Google', 'Stripe', 'Nvidia', '', undefined]) {
    assert.strictEqual(passesLevel('Staff Software Engineer', 'permissive', company), false, String(company));
  }
  // A name that merely contains the words is not the employer.
  assert.strictEqual(passesLevel('Staff Software Engineer', 'permissive', 'Friends of Palo Alto Networks'), false);
});

test('a title that names a new-grad track passes despite "Staff", at any employer', () => {
  for (const title of [
    'Staff Software Engineer (New Grad)',
    'Staff Software Engineer - New College Graduate 2026',
    'Staff Engineer, University Graduate',
    'Early Career Staff Software Engineer',
  ]) {
    assert.strictEqual(passesLevel(title, 'permissive', 'Acme Corp'), true, title);
  }
  // Only the Staff word is lifted: the other seniority markers still reject.
  assert.strictEqual(passesLevel('Senior Software Engineer (New Grad)', 'permissive', 'Acme Corp'), false);
  assert.strictEqual(passesLevel('Engineering Manager, Early Career Program', 'permissive', 'Acme Corp'), false);
});

test('"Member of Technical Staff" and "Chief of Staff" are unchanged', () => {
  assert.strictEqual(looksSeniorReject('Member of Technical Staff'), false);
  assert.strictEqual(looksSeniorReject('Member of Technical Staff', PANW), false);
  assert.strictEqual(looksSeniorReject('Chief of Staff', PANW), true);
});

test('a Palo Alto Networks Staff role is kept or dropped on the years it asks for', () => {
  const entry = normalizeJob(
    raw({ description: "Bachelor's degree in Computer Science and 0-2 years of experience in software development." }),
    OPTS
  );
  assert.ok(entry, 'a 0-2 year Staff role is kept');
  assert.strictEqual(entry.is_entry_level, 1);
  assert.strictEqual(entry.yoe_min, 0);

  const unstated = normalizeJob(raw({ description: 'Build the platform behind Prisma Cloud.' }), OPTS);
  assert.ok(unstated, 'a Staff role that states no years is kept, like any plain title');
  assert.strictEqual(unstated.yoe_min, -1);

  const senior = normalizeJob(raw({ description: '5+ years of experience building distributed systems in Go or Java.' }), OPTS);
  assert.strictEqual(senior, null, 'the 0-2 year cap still drops a Staff role asking for 5+ years');

  assert.strictEqual(normalizeJob(raw({ company_name: 'Google' }), OPTS), null, 'Staff at Google is still senior');
});

test('prune-rejected keeps stored Palo Alto Networks Staff rows', () => {
  // The backfill workflow runs this over every stored row; without the employer
  // it would delete the rows the collectors now keep.
  const stored = (company_name) => ({
    source: 'workday',
    company_name,
    job_title: 'Staff Software Engineer',
    location: 'Santa Clara, California, United States of America',
    yoe_min: -1,
  });
  assert.strictEqual(reason(stored(PANW)), null);
  assert.strictEqual(reason(stored('Google')), 'senior / intern / supervisor');
});

test('workday: Palo Alto Networks Staff postings get a description request', () => {
  const posting = (title) => ({
    title,
    postedOn: 'Posted 2 Days Ago',
    locationsText: 'Santa Clara, California, United States of America',
  });
  const list = [posting('Staff Software Engineer'), posting('Senior Staff Software Engineer'), posting('Principal Software Engineer')];
  assert.deepStrictEqual(workday.pickCandidates(list, { displayName: PANW }).map((j) => j.title), ['Staff Software Engineer']);
  assert.deepStrictEqual(workday.pickCandidates(list, { displayName: 'Nvidia' }), []);
});

test('workday: every "Posted …" label gets a date, "30+ Days Ago" at its lower bound', () => {
  const ageDays = (s) => (Date.now() - new Date(workday.parsePostedOn(s)).getTime()) / 86_400_000;
  // The tolerances absorb a DST change inside the window (setDate keeps wall-clock time).
  assert.ok(Math.abs(ageDays('Posted Today')) < 0.05);
  assert.ok(Math.abs(ageDays('Posted Yesterday') - 1) < 0.1);
  assert.ok(Math.abs(ageDays('Posted 5 Days Ago') - 5) < 0.1);
  assert.ok(Math.abs(ageDays('Posted 30+ Days Ago') - 30) < 0.1);
  assert.strictEqual(workday.parsePostedOn(''), null);
  assert.strictEqual(workday.parsePostedOn('Hiring now'), null);
});

test('workday: a posting open 30+ days falls past retention instead of arriving as new', () => {
  const stale = normalizeJob(raw({ job_title: 'Software Engineer', date_posted: workday.parsePostedOn('Posted 30+ Days Ago') }), OPTS);
  assert.strictEqual(stale, null);
  const fresh = normalizeJob(raw({ job_title: 'Software Engineer', date_posted: workday.parsePostedOn('Posted Yesterday') }), OPTS);
  assert.ok(fresh);
  assert.ok(fresh.date_posted, 'dated by Workday, not left for the first-seen stamp');
});
