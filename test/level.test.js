'use strict';

// Level from what the posting says (levelVerdict in normalize.js). A seniority
// word in the title ("Staff", "Senior", "III") is not a verdict on its own: the
// posting's stated years or a new-grad track decide, for every employer and
// source. Internships and management titles are rejected whatever the posting
// says.

const test = require('node:test');
const assert = require('node:assert');
const { passesLevel, levelVerdict, levelRank, normalizeJob } = require('../src/services/normalize');
const { experienceProfile } = require('../src/services/experience');
const { reason } = require('../src/scripts/prune-rejected');
const workday = require('../src/collectors/workday');

const OPTS = { filterUSOnly: true, filterSoftwareOnly: true, entryLevelMode: 'permissive', retentionDays: 14 };
const raw = (over) => ({
  source: 'workday',
  company_name: 'Acme',
  job_title: 'Staff Software Engineer',
  location: 'Santa Clara, California, United States of America',
  apply_url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Santa-Clara/Software-Engineer_JR1',
  description: '',
  date_posted: new Date().toISOString(),
  ...over,
});
const kept = (over) => normalizeJob(raw(over), OPTS);
const verdict = (title, description) => levelVerdict({ title, description, years: experienceProfile(`${title}\n${description}`) });

test('a seniority word is kept when the posting asks for 0-2 years', () => {
  // Palo Alto Networks hires new grads as "Staff Software Engineer"; Walmart's
  // "Software Engineer III" asks for 2 years with a degree.
  const staff = kept({ description: "Bachelor's degree in Computer Science and 0-2 years of experience in software development." });
  assert.ok(staff);
  assert.strictEqual(staff.is_entry_level, 1);
  assert.ok(kept({
    job_title: 'Software Engineer III',
    description: "Option 1: Bachelor's degree in computer science and 2 years' experience in software engineering. Option 2: 4 years' experience in software engineering.",
  }));
});

test('a seniority word with nothing in range in the posting is dropped', () => {
  assert.strictEqual(kept({ description: 'Build the platform behind our products.' }), null, 'no years, no new-grad track');
  assert.strictEqual(kept({ description: '5+ years of experience building distributed systems.' }), null, 'over the cap');
  // "2+ years of Go" is in range, but the same posting asks for 8+ years.
  assert.strictEqual(
    kept({ job_title: 'Senior Software Engineer', description: '8+ years of software engineering experience. 2+ years of experience with Go.' }),
    null
  );
});

test('a new-grad track in the title or the description keeps a seniority-worded role', () => {
  assert.ok(kept({ job_title: 'Staff Software Engineer (New Grad)' }));
  const recent = kept({ description: 'This role is open to recent graduates of a BS or MS program.' });
  assert.ok(recent);
  assert.strictEqual(recent.is_entry_level, 1);
  assert.ok(kept({ description: 'Candidates graduating in 2027 are encouraged to apply.' }));
  // Company boilerplate about programmes is not a track for this role.
  assert.strictEqual(kept({ description: 'We run early career and university programs across the company.' }), null);
});

test('management and internships are rejected whatever the posting says', () => {
  for (const title of ['Engineering Manager', 'Director, Software Engineering', 'Chief of Staff', 'Distinguished Engineer']) {
    assert.strictEqual(passesLevel(title, 'permissive'), false, title);
  }
  assert.strictEqual(kept({ job_title: 'Software Engineering Manager', description: '0-2 years of experience.' }), null);
  assert.strictEqual(kept({ job_title: 'Software Engineer Intern', description: 'Students graduating in 2027.' }), null);
});

test('plain titles keep the 0-2 year cap and pass with nothing stated', () => {
  assert.ok(kept({ job_title: 'Software Engineer', description: 'Build APIs.' }));
  assert.strictEqual(kept({ job_title: 'Software Engineer', description: '3+ years of professional software development experience.' }), null);
  assert.ok(kept({ job_title: 'Member of Technical Staff', description: 'Train models.' }), '"Technical Staff" is not a Staff level');
});

test('the verdict names its reason', () => {
  assert.deepStrictEqual(verdict('Software Engineer', ''), { keep: true });
  assert.strictEqual(verdict('Staff Software Engineer', '0-1 years of experience').reason, 'asks for 0 years');
  assert.strictEqual(verdict('Senior Engineer', 'Open to new grads.').reason, 'new-grad track');
  assert.match(verdict('Staff Software Engineer', '').reason, /nothing in the posting/);
  assert.match(verdict('Software Engineer', '4+ years of experience').reason, /over 2 years/);
});

test('prune-rejected judges stored seniority-worded rows by their description', () => {
  const stored = (job_title, description) => ({
    source: 'workday',
    company_name: 'Acme',
    job_title,
    location: 'Santa Clara, California, United States of America',
    yoe_min: -1,
    description,
  });
  assert.strictEqual(reason(stored('Staff Software Engineer', "Bachelor's degree and 0-2 years of experience.")), null);
  assert.match(reason(stored('Staff Software Engineer', '')), /nothing in the posting/);
  assert.strictEqual(reason(stored('Software Engineering Manager', '')), 'intern / management');
  assert.strictEqual(reason(stored('Software Engineer', '')), null);
});

test('detail budgets go to likely-in-range titles first', () => {
  assert.strictEqual(levelRank('Software Engineer (New Grad)'), 0);
  assert.strictEqual(levelRank('Software Engineer'), 1);
  assert.strictEqual(levelRank('Staff Software Engineer'), 2);
  const posting = (title, postedOn) => ({ title, postedOn, locationsText: 'Santa Clara, California, United States of America' });
  const picked = workday.pickCandidates([
    posting('Staff Software Engineer', 'Posted Today'),
    posting('Software Engineer Manager', 'Posted Today'), // management: no request
    posting('Software Engineer', 'Posted 3 Days Ago'),
    posting('Software Engineer, New Grad', 'Posted 9 Days Ago'),
  ]);
  assert.deepStrictEqual(picked.map((j) => j.title), ['Software Engineer, New Grad', 'Software Engineer', 'Staff Software Engineer']);
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
  const stale = kept({ job_title: 'Software Engineer', date_posted: workday.parsePostedOn('Posted 30+ Days Ago') });
  assert.strictEqual(stale, null);
  const fresh = kept({ job_title: 'Software Engineer', date_posted: workday.parsePostedOn('Posted Yesterday') });
  assert.ok(fresh);
  assert.ok(fresh.date_posted, 'dated by Workday, not left for the first-seen stamp');
});

// ─── The years reader (experience.js), cases found on live boards 2026-11-23 ──

test('years: "looking for 8+ years" is a requirement, company history is not', () => {
  // Databricks "Staff Fullstack Engineer": the 8 was read as company history.
  assert.deepStrictEqual(
    experienceProfile('What we are looking for 8+ years of software engineering experience, with at least 2 years building'),
    { min: 2, max: null, top: 8, degree: null }
  );
  assert.strictEqual(experienceProfile('You have more than 5 years of experience shipping software.').min, 5);
  assert.strictEqual(experienceProfile('For 8 years, Scale has been the leading AI data foundry. 2+ years of experience required.').top, 2);
});

test('years: a range asks for its low end; a degree-bound requirement is kept apart', () => {
  assert.deepStrictEqual(experienceProfile('Senior engineer with 2-4 years of professional experience.'), { min: 2, max: 4, top: 2, degree: null });
  const walmart = experienceProfile("Option 1: Bachelor's degree in computer science and 2 years' experience in software engineering. Option 2: 4 years' experience in software engineering.");
  assert.strictEqual(walmart.degree, 2);
  assert.strictEqual(walmart.top, 4);
  assert.strictEqual(experienceProfile("Bachelor's degree from a 4-year program. 1+ years of experience.").degree, null, 'a degree length is not experience');
});

test('a seniority-worded role is judged on its main requirement, not a side skill', () => {
  // Palantir "Senior Software Engineer, Network Infrastructure" (2026-11-23).
  assert.strictEqual(
    kept({ job_title: 'Senior Software Engineer', description: '3+ years of professional software development experience. 1+ years of experience with networking.' }),
    null
  );
  // Rivian "Sr. Power Electronics Software Engineer": its only stated requirement is 2 years.
  assert.ok(kept({ job_title: 'Sr. Software Engineer, Power Electronics', description: '2+ years of professional experience in developing real-time embedded software.' }));
});

test('stripHtml reads markup that arrives escaped (Greenhouse content=true)', () => {
  const { stripHtml } = require('../src/services/normalize');
  assert.strictEqual(
    stripHtml('&lt;p&gt;What we want&lt;/p&gt;&lt;ul&gt;&lt;li&gt;8+&amp;nbsp;years of experience&lt;/li&gt;&lt;/ul&gt;'),
    'What we want 8+ years of experience'
  );
  assert.strictEqual(stripHtml('<p>C &amp; C++, &#8217;quotes&#x2019;</p>'), 'C & C++, ’quotes’');
});
