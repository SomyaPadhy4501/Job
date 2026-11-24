'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../extension/autofill-fields');
const pages = require('../extension/application-pages');
const profile = {
  identity: { firstName: 'Pat', lastName: 'Example' },
  workAuth: {
    authorizedUS: true,
    requiresSponsorshipNow: false,
    requiresSponsorshipFuture: true,
    visaStatus: 'f1_opt',
  },
  contact: { email: 'pat@example.invalid' },
  links: { linkedin: 'https://example.invalid/link' },
  eeo: { gender: 'decline' },
};
const field = (label, extra = {}) => ({ label, type: 'text', ...extra });
const answer = (label, p = profile) => F.resolve(field(label), p)[0];
test('sponsorship distinguishes present, future, either, and unknown', () => {
  for (const label of [
    'Do you now or will you in the future require immigration sponsorship to work at Cloudflare?',
    'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, etc.)?',
    'Will you require visa sponsorship now or in the future?',
    'Will you, now or in the future, require visa sponsorship to work in the United States?',
    'Will you require sponsorship in the future?',
  ])
    assert.equal(answer(label), 'Yes', label);
  assert.equal(answer('Do you currently require visa sponsorship?'), 'No');
  assert.equal(answer('Do you require visa sponsorship?'), undefined);
  const label = 'Will you require sponsorship now or in the future?';
  for (const [now, future, expected] of [
    [false, null, undefined],
    [null, true, 'Yes'],
    [null, null, undefined],
    [false, false, 'No'],
  ]) {
    assert.equal(
      answer(label, { workAuth: { requiresSponsorshipNow: now, requiresSponsorshipFuture: future } }),
      expected
    );
  }
});
test('negations, compound questions, exceptions and non-US scope require the applicant', () => {
  for (const label of [
    'Do you not require visa sponsorship?',
    'Will you never need sponsorship in the future?',
    'Can you work without sponsorship now or in the future?',
    'Will you be able to work without ever needing sponsorship?',
    'Can you confirm you do not require current or future sponsorship?',
    'Are you not legally authorized to work in the United States?',
    'Are you legally authorized to work in the US without sponsorship?',
    'Are you legally authorized to work in the country for which you are applying?',
    'Are you legally authorized to work in the United States and Canada?',
    'Are you currently based in the U.S. or Canada and/or currently authorized to work in one of these locations?',
    'Will you require immigration sponsorship to work in Canada?',
    'Which visa would you need in the future?',
    'Do you now require sponsorship and have a security clearance?',
    'If you require visa sponsorship, please explain.',
  ]) {
    const d = field(label);
    assert.deepEqual(F.resolve(d, profile, [{ question: label, answer: 'Yes' }]), [], label);
  }
});
test('work authorization and visa status are independent', () => {
  assert.equal(answer('Are you legally authorized to work in the U.S.?'), 'Yes');
  assert.equal(
    answer('Are you eligible to work in the United States?', { workAuth: { authorizedUS: false } }),
    'No'
  );
  assert.equal(
    answer('Are you eligible to work in the United States?', { workAuth: { visaStatus: 'citizen' } }),
    undefined
  );
  const opts = ['F-1 CPT', 'F-1 OPT', 'F-1 STEM OPT', 'H-1B'];
  assert.equal(F.pick(opts, F.resolve(field('What is your current visa status?'), profile)), 1);
  assert.equal(F.pick(['Yes, but only for 12 months', 'No'], ['Yes']), -1);
  assert.equal(F.pick(['F-1', 'F-1 STEM OPT'], ['F-1 OPT']), -1);
});
test('real identifiers, explicit EEO choices, and empty profile values', () => {
  for (const [d, val] of [
    [field('', { name: 'first_name' }), 'Pat'],
    [field('Legal Name', { id: '_systemfield_name' }), 'Pat Example'],
    [field('', { name: 'urls[LinkedIn]' }), profile.links.linkedin],
    [field('', { automationId: 'legalNameSection_firstName' }), 'Pat'],
    [field('Legal Name (if different than above)', { id: 'name' }), undefined],
    [field('Gender'), 'Decline'],
    [field('Race'), undefined],
    [field('Preferred Name'), undefined],
  ])
    assert.equal(F.resolve(d, profile)[0], val, JSON.stringify(d));
  assert.deepEqual(F.resolve(field('Race'), profile, [{ question: 'Race', answer: 'Decline' }]), []);
  assert.equal(F.pick(['Decline to answer', 'Decline'], F.resolve(field('Gender'), profile)), -1);
});
test('qualification checks, puzzles, essays and self ratings require the same saved question', () => {
  for (const question of [
    'Do you have a minimum of 7 years of experience building software?',
    'Rate your proficiency in C++',
    'Solve this puzzle',
    'Why do you want to work at Ramp?',
  ]) {
    const d = field(question);
    assert.deepEqual(F.resolve(d, profile), []);
    assert.deepEqual(F.resolve(d, profile, [{ question: 'Please   ' + question, answer: 'My own answer' }]), [
      'My own answer',
    ]);
  }
  for (const [a, b] of [
    ['Do you have 7+ years?', 'Do you have 7 years?'],
    ['Rate your C++', 'Rate your C#'],
    ['Why join X?', 'Why join Y?'],
    ['Have you worked here?', 'Have you never worked here?'],
  ]) {
    assert.equal(F.savedAnswer(a, [{ question: b, answer: 'yes' }]), null);
  }
  assert.equal(
    F.savedAnswer('Why?', [
      { question: 'Why?', answer: 'a' },
      { question: 'Please why?', answer: 'b' },
    ]),
    null
  );
});
test('protected fields cannot resolve via answer bank or identity fallback', () => {
  for (const d of [
    field('I certify that the information is correct'),
    field('Background-check consent'),
    field('Name', { name: 'eeo[disabilitySignature]' }),
    field('Privacy Policy', { type: 'checkbox' }),
    field('Email', { name: 'h-captcha-response' }),
    field('Do you agree to the terms?'),
  ]) {
    assert.deepEqual(F.resolve(d, profile, [{ question: d.label, answer: 'Yes' }]), []);
  }
});
test('resume ranking uses whole tags, title before body and preference on ties', () => {
  const resumes = [
    { id: 'a', tags: ['AI'], isDefault: true },
    { id: 'b', tags: ['Backend'] },
    { id: 'c', tags: ['AI'] },
  ];
  assert.deepEqual(
    F.rankResumes(resumes, 'Backend Engineer', 'AI research', 'c').map((r) => r.id),
    ['b', 'c', 'a']
  );
  assert.equal(F.rankResumes(resumes, 'Retail', '', 'b')[0].id, 'b');
});
test('capture excludes application, personal and embedded job routes and in-flight personal responses', () => {
  for (const href of [
    'https://jobs.lever.co/x/uuid/apply',
    'https://jobs.ashbyhq.com/x/uuid',
    'https://boards.greenhouse.io/embed/job_app?token=9',
    'https://job-boards.greenhouse.io/x/jobs/1',
    'https://x.myworkdayjobs.com/en-US/Jobs/userHome',
    'https://careers.example/apply',
  ]) {
    assert.equal(pages.privatePage(href), true, href);
    assert.equal(pages.publicResponse(href, '/jobs'), false);
  }
  const board = 'https://x.myworkdayjobs.com/en-US/Careers';
  assert.ok(pages.publicResponse(board, '/wday/cxs/x/Careers/jobs'));
  assert.equal(pages.publicResponse(board, '/wday/cxs/x/Careers/candidateProfile'), false);
  assert.equal(pages.publicResponse(board, 'https://other.invalid/wday/cxs/x/Careers/jobs'), false);
  assert.equal(pages.ats('jobs.lever.co.example.invalid'), '');
});
test('"now or in the future" sponsorship wordings all resolve from both profile answers', () => {
  const labels = [
    'Will you now, or in the future, require sponsorship for employment visa status (e.g., H-1B visa status)?',
    'Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa)?',
    'Will you now or will you in the future require sponsorship?',
    'Do you now, or will you in the future, require sponsorship to work in the US?',
    'Will you now or in the future require visa sponsorship to work in the U.S.?',
    'Do you require sponsorship now or in the future to work in the United States?',
    'Will you require visa sponsorship now or in the future to work in the US? (Optional)',
    'Will you now or at any time in the future require employment sponsorship?',
  ];
  const auth = (now, future) => ({ workAuth: { requiresSponsorshipNow: now, requiresSponsorshipFuture: future } });
  for (const label of labels) {
    assert.deepEqual(F.classify(field(label)), { kind: 'sponsorship', when: 'either' }, label);
    assert.equal(answer(label, auth(false, false)), 'No', label);
    assert.equal(answer(label, auth(true, false)), 'Yes', label);
    assert.equal(answer(label, auth(false, true)), 'Yes', label);
    // Unknown is never read as "No".
    assert.equal(answer(label, auth(false, null)), undefined, label);
    assert.equal(answer(label, auth(null, null)), undefined, label);
    assert.equal(answer(label, {}), undefined, label);
  }
  // Present-only and future-only wording use only their own answer.
  assert.equal(answer('Do you currently require sponsorship?', auth(false, null)), 'No');
  assert.equal(answer('Do you currently require sponsorship?', auth(null, false)), undefined);
  assert.equal(answer('Will you require sponsorship in the future?', auth(true, null)), undefined);
});
test('"Are you legally authorized…" uses only workAuth.authorizedUS and only for the US', () => {
  for (const label of [
    'Are you legally authorized to work in the United States?',
    'Are you legally authorized to work in the United States of America?',
    'Are you currently legally authorized to work in the U.S.?',
    'Are you legally eligible to work in the US?',
    'Are you authorized to work in the USA? *',
  ]) {
    assert.deepEqual(F.classify(field(label)), { kind: 'authorizedUS' }, label);
    assert.equal(answer(label, { workAuth: { authorizedUS: true } }), 'Yes', label);
    assert.equal(answer(label, { workAuth: { authorizedUS: false } }), 'No', label);
    assert.equal(answer(label, { workAuth: { authorizedUS: null } }), undefined, label);
    // Citizenship or a visa status never stands in for the explicit answer.
    assert.equal(answer(label, { workAuth: { visaStatus: 'citizen', requiresSponsorshipNow: false } }), undefined);
  }
});
test('non-US and multi-country authorization or sponsorship questions stay blank, even with a saved answer', () => {
  const p = {
    workAuth: { authorizedUS: true, requiresSponsorshipNow: false, requiresSponsorshipFuture: false },
  };
  for (const label of [
    'Are you legally authorized to work in Canada?',
    'Are you legally authorized to work in the United Kingdom?',
    'Are you authorized to work in the EU?',
    'Are you legally authorized to work in the country in which this job is located?',
    'Are you legally authorized to work in the US or Canada?',
    'Will you require sponsorship to work in the United Kingdom?',
    'Will you now or in the future require sponsorship to work in Germany?',
    'Do you require a visa to work in India?',
    'Do you have the right to work in the UK?',
    'Are you eligible to work in any country without sponsorship?',
    'Are you a US citizen?',
    'Do you or will you require sponsorship?',
  ]) {
    assert.notEqual(F.classify(field(label)).kind, 'question', label);
    assert.deepEqual(F.resolve(field(label), p, [{ question: label, answer: 'Yes' }]), [], label);
  }
});
test('unknown (null) profile values are never filled, explicit false is', () => {
  const p = {
    misc: { over18: null, howDidYouHear: null },
    preferences: { relocate: false, workMode: null, salaryExpectation: null },
    eeo: { gender: null, veteran: 'decline' },
  };
  assert.equal(answer('Are you 18 years of age or older?', p), undefined);
  assert.equal(answer('Are you willing to relocate?', p), 'No');
  assert.equal(answer('How did you hear about us?', p), undefined);
  assert.equal(answer('Salary expectations', p), undefined);
  assert.equal(answer('Gender', p), undefined);
  assert.ok(F.resolve(field('Veteran status'), p).includes('Decline to answer'));
  assert.equal(answer('Preferred work mode', p), undefined);
  assert.deepEqual(
    F.resolve(field('Preferred work mode'), { preferences: { workMode: 'onsite' } }).slice(0, 2),
    ['On-site', 'Onsite']
  );
  assert.equal(
    F.pick(['Remote', 'Hybrid', 'On-site'], F.resolve(field('Preferred work mode'), { preferences: { workMode: 'remote' } })),
    0
  );
});
test('passwords, consent and attestation controls are protected whatever the profile holds', () => {
  for (const d of [
    field('Email', { type: 'password' }),
    field('First name', { type: 'checkbox' }),
    field('I acknowledge that I have read the notice'),
    field('Do you consent to receiving SMS messages?'),
    field('By submitting, I attest that my answers are true'),
    field('Signature'),
    field('Are you legally authorized to work in the US?', { options: ['I agree', 'I do not agree'] }),
  ]) {
    assert.equal(F.classify(d).kind, 'protected', d.label);
    assert.deepEqual(F.resolve(d, { ...profile, identity: { firstName: 'Pat' } }, [{ question: d.label, answer: 'Yes' }]), []);
  }
});

test('"require <employer> to sponsor you" wording: US or unstated only, timeframe respected', () => {
  const profile = { workAuth: { requiresSponsorshipNow: false, requiresSponsorshipFuture: true } };
  const radio = (label) => ({ label, type: 'radio', options: ['Yes', 'No'] });
  for (const q of [
    'Will you require Stripe to sponsor you for a US work permit now or in the future? *',
    'Do you now or in the future need Acme Corp to sponsor you for a visa to work in the United States?',
    'Will you require us to sponsor you for a work visa in the future?',
  ]) {
    assert.equal(F.classify(radio(q)).kind, 'sponsorship', q);
    assert.deepEqual(F.resolve(radio(q), profile), ['Yes'], q);
  }
  // No timeframe, and now/future differ: left for the applicant.
  assert.deepEqual(F.resolve(radio('Will you require us to sponsor you for a work visa?'), profile), []);
  for (const q of [
    'Will you require Stripe to sponsor you for a work permit in Canada now or in the future?',
    'Will you require Stripe to sponsor you for a UK work permit?',
  ])
    assert.notEqual(F.classify(radio(q)).kind, 'sponsorship', q);
});

test('"this country" and "the country where the job is located" read as the US; named countries stay blank', () => {
  const profile = { workAuth: { authorizedUS: true, requiresSponsorshipNow: false, requiresSponsorshipFuture: true } };
  const yesno = (label) => ({ label, type: 'yesno', options: ['Yes', 'No'] });
  assert.deepEqual(F.resolve(yesno('Are you authorized to work in the country where the job is located?'), profile), ['Yes']);
  assert.deepEqual(F.resolve(yesno('Are you legally authorized to work in this country?'), profile), ['Yes']);
  assert.deepEqual(
    F.resolve(yesno('Will you now or in the future require sponsorship for employment visa status in this country?'), profile),
    ['Yes']
  );
  for (const q of [
    'Are you authorized to work in Canada?',
    'Will you now or in the future require sponsorship for employment visa status in Canada?',
  ])
    assert.deepEqual(F.resolve(yesno(q), profile), [], q);
});

test('location search: the city must lead and every profile part must appear', () => {
  const options = [
    'San Francisco, California, United States',
    'San Francisco Bay Area, California, United States',
    'San Francisco de Macorís, Duarte, Dominican Republic',
    'San Francisco, Córdoba, Argentina',
  ];
  assert.strictEqual(F.pickPlace(options, 'San Francisco, CA, USA'), 0);
  assert.strictEqual(F.pickPlace(options, 'San Francisco, California, United States of America'), 0);
  // A bare city is ambiguous here, so nothing is picked.
  assert.strictEqual(F.pickPlace(options, 'San Francisco'), -1);
  assert.strictEqual(F.pickPlace(['Portland, Oregon, United States', 'Portland, Maine, United States'], 'Portland, ME'), 1);
  assert.strictEqual(F.pickPlace(['Bogotá, Colombia'], 'Bogota, Colombia'), 0);
  assert.strictEqual(F.placeQuery('San Francisco, CA, USA'), 'San Francisco');
  assert.strictEqual(F.placeQuery(''), '');
});

test('date pickers get US-order text; start-date questions read the profile', () => {
  assert.strictEqual(F.usDate('2027-01-15'), '01/15/2027');
  assert.strictEqual(F.usDate('soon'), '');
  assert.deepStrictEqual(F.classify({ label: 'When can you start a new role?', type: 'text' }), {
    kind: 'profile',
    path: 'preferences.earliestStart',
  });
  assert.deepStrictEqual(F.classify({ label: 'Where are you currently located?', type: 'combo' }), {
    kind: 'profile',
    path: 'location',
  });
});
