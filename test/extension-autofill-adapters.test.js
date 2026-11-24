'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const A = require('../extension/autofill-adapters');
const F = require('../extension/autofill-fields');
function fixture(ats, html) {
  const { document, window } = parseHTML('<html><body>' + html + '</body></html>');
  return { document, window, adapter: A.create(document, ats) };
}
test('Lever reads question titles separately from alternatives and preserves prefilled controls', async () => {
  const { adapter, document } = fixture(
    'lever',
    '<form id="application-form"><li class="application-question"><label><div class="application-label">LinkedIn URL</div><input name="urls[LinkedIn]"></label></li>' +
      '<li class="application-question"><div class="application-label">Do you currently require sponsorship?</div><label><input type="radio" name="cards[abc][field1]">Yes</label><label><input type="radio" name="cards[abc][field1]">No</label></li>' +
      '<li class="application-question"><div class="application-label">Privacy acknowledgement</div><input required type="checkbox"></li>' +
      '<textarea name="h-captcha-response"></textarea><div class="h-captcha"><input></div><button>Submit Application</button></form>'
  );
  const [link, radio, privacy] = adapter.collect();
  assert.equal(adapter.collect().length, 3);
  assert.deepEqual(radio.options, ['Yes', 'No']);
  radio.members[1].checked = true;
  assert.equal(await adapter.write(radio, ['Yes']), false);
  assert.equal(await adapter.write(privacy, ['Yes']), false);
  const seen = [];
  for (const name of ['input', 'change', 'blur']) document.addEventListener(name, () => seen.push(name));
  Object.defineProperty(link.el, 'value', {
    get() {
      return this.getAttribute('value') || '';
    },
    set() {
      throw Error('React tracker called');
    },
  });
  assert.ok(await adapter.write(link, ['https://example.invalid']));
  assert.deepEqual(seen, ['input', 'change', 'blur']);
  assert.equal(await adapter.write(link, ['new value']), false);
});
test('Ashby discovers systemfield and custom yes/no controls but excludes the companion checkbox', async () => {
  const question = 'Do you have a minimum of 7 years of experience building software?';
  const { adapter, document } = fixture(
    'ashby',
    '<div class="ashby-application-form-field-entry"><label for="_systemfield_name">Legal Name</label><input id="_systemfield_name"></div>' +
      '<div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_42">' +
      question +
      '</label>' +
      '<div class="ashby-application-form-input-yesno"><button aria-pressed="false" data-option="yes">Yes</button><button aria-pressed="false" data-option="no">No</button><input type="checkbox"></div></div><button>Submit</button>'
  );
  const [name, yn] = adapter.collect();
  assert.equal(adapter.collect().length, 2);
  assert.equal(F.classify(name).path, 'fullName');
  assert.ok(yn.required);
  assert.deepEqual(F.resolve(yn, {}), []);
  let clicks = 0;
  document.addEventListener('click', (e) => {
    clicks++;
    e.target.setAttribute('aria-pressed', 'true');
  });
  assert.ok(await adapter.write(yn, F.resolve(yn, {}, [{ question, answer: 'No' }])));
  assert.equal(adapter.read(yn), 'No');
  assert.equal(await adapter.write(yn, ['Yes']), false);
  assert.equal(clicks, 1);
});
test('Workday opens its listbox, picks one exact option, and excludes implicit submit buttons', async () => {
  const { adapter, document } = fixture(
    'workday',
    '<form data-automation-id="applicationForm"><label for="state">State</label>' +
      '<button type="button" id="state" aria-controls="states" aria-haspopup="listbox">Select One</button>' +
      '<label for="country">Country</label><button id="country" aria-haspopup="listbox">Select One</button><button type="submit">Next</button></form>'
  );
  const [state, country] = adapter.collect();
  document.getElementById('state').onclick = () => {
    const list = document.createElement('div');
    list.id = 'states';
    list.setAttribute('role', 'listbox');
    list.innerHTML = '<div role="option">North Carolina</div><div role="option">California</div>';
    document.body.append(list);
    list.onclick = (e) => {
      state.el.textContent = e.target.textContent;
      list.remove();
    };
  };
  assert.ok(await adapter.write(state, ['California']));
  assert.equal(adapter.read(state), 'California');
  let submit = false;
  country.el.onclick = () => {
    submit = true;
  };
  assert.equal(await adapter.write(country, ['US']), false);
  assert.equal(submit, false);
});
test('Greenhouse react-select opens from keyboard and preserves a previous selection', async () => {
  const { adapter, window, document } = fixture(
    'greenhouse',
    '<form id="application-form"><label for="field">What is your current visa status?</label>' +
      '<div class="select__control"><input id="field" role="combobox" aria-controls="list"></div></form>'
  );
  window.KeyboardEvent = window.Event;
  const [d] = adapter.collect();
  d.el.addEventListener('keydown', () => {
    const list = document.createElement('div');
    list.id = 'list';
    list.innerHTML = '<div role="option">F-1 OPT</div>';
    document.body.append(list);
    list.onclick = (e) => {
      const selected = document.createElement('div');
      selected.className = 'select__single-value';
      selected.textContent = e.target.textContent;
      d.el.before(selected);
      list.remove();
    };
  });
  assert.ok(await adapter.write(d, ['F-1 OPT']));
  assert.equal(adapter.read(d), 'F-1 OPT');
  assert.equal(await adapter.write(d, ['F-1 OPT']), false);
});
for (const ats of ['greenhouse', 'lever', 'ashby', 'workday']) {
  test(ats + ' expands only the requested education rows and binds separate records', async () => {
    const { adapter, document } = fixture(
      ats,
      '<form id="application-form" data-automation-id="applicationForm"><div class="education--container" data-field-path="education">' +
        '<div class="education--form"><label>School<input></label></div><button type="button">Add another</button><button>Next</button></div></form>'
    );
    const button = document.querySelector('button');
    let clicks = 0;
    button.onclick = () => {
      clicks++;
      button.before(document.querySelector('.education--form').cloneNode(true));
    };
    const profile = { education: [{ school: 'One' }, { school: 'Two' }] };
    await adapter.expand(profile);
    await adapter.expand(profile);
    assert.equal(clicks, 1);
    assert.deepEqual(
      adapter.collect().map((d) => [...F.resolve(d, profile)]),
      [['One'], ['Two']]
    );
  });
}
test('skips credential forms and file attachment if the user picks a file during fetch', async () => {
  const { adapter } = fixture(
    'ashby',
    '<div class="ashby-application-form-field-entry"><label>Resume</label><input type="file" id="_systemfield_resume"></div>' +
      '<form><div data-field-path="email"><input type="email"></div><input type="password"></form>'
  );
  const [resume] = adapter.collect();
  assert.equal(adapter.collect().length, 1);
  assert.equal(
    await adapter.write(resume, [], async () => {
      resume.el.files = [{ name: 'mine.pdf' }];
      return {};
    }),
    false
  );
  assert.equal(adapter.read(resume), 'mine.pdf');
});

test('experience rows with opaque IDs are scoped by section heading and employer label', async () => {
  const { adapter, document } = fixture(
    'lever',
    '<form id="application-form"><section><h3>Work experience</h3>' +
      '<fieldset><label>Company name<input></label><label>Job title<input></label></fieldset>' +
      '<button type="button">Add another</button></section></form><button>Add another</button>'
  );
  const profile = {
    experience: [
      { company: 'Example', title: 'Intern' },
      { company: 'Demo', title: 'Engineer' },
    ],
  };
  const button = document.querySelector('section button');
  button.onclick = () => button.before(document.querySelector('fieldset').cloneNode(true));
  await adapter.expand(profile);
  assert.deepEqual(
    adapter.collect().map((d) => [...F.resolve(d, profile)]),
    [['Example'], ['Intern'], ['Demo'], ['Engineer']]
  );
});

test('never clicks an option nested in a submit button', async () => {
  const { adapter, document } = fixture(
    'workday',
    '<form data-automation-id="jobApplicationPage"><label for="state">State</label>' +
      '<button type="button" id="state" aria-haspopup="listbox" aria-controls="states">Select One</button>' +
      '<div id="states" role="listbox"><button type="submit"><span role="option">California</span></button></div></form>'
  );
  let clicks = 0;
  document.querySelector('[type="submit"]').onclick = () => clicks++;
  assert.equal(await adapter.write(adapter.collect()[0], ['California']), false);
  assert.equal(clicks, 0);
});

test('values already on the form are never overwritten, for every control type', async () => {
  const { adapter, document } = fixture(
    'greenhouse',
    '<form id="application-form">' +
      '<label for="first_name">First name</label><input id="first_name" value="Typed">' +
      '<label for="city">City</label><select id="city"><option value="">Select</option><option value="b" selected>Boston</option><option value="n">NYC</option></select>' +
      '<label for="visa">What is your current visa status?</label><div class="select__control"><div class="select__single-value">H-1B</div><input id="visa" role="combobox" aria-controls="vl"></div>' +
      '<div class="field-wrapper"><label>Are you willing to relocate?</label><label><input type="radio" name="r" value="y" checked>No</label><label><input type="radio" name="r" value="n">Yes</label></div>' +
      '<label for="essay">Why do you want to work here?</label><textarea id="essay">My own words</textarea>' +
      '</form>'
  );
  let clicks = 0;
  document.addEventListener('click', () => clicks++);
  const fields = adapter.collect();
  assert.equal(fields.length, 5);
  const p = {
    identity: { firstName: 'Pat' },
    address: { city: 'NYC' },
    workAuth: { visaStatus: 'f1_opt' },
    preferences: { relocate: true },
  };
  const answers = [{ question: 'Why do you want to work here?', answer: 'Saved' }];
  for (const d of fields) {
    assert.ok(adapter.read(d), d.label + ' reads as answered');
    assert.equal(adapter.available(d), false, d.label);
    assert.equal(await adapter.write(d, F.resolve(d, p, answers)), false, d.label);
  }
  assert.equal(document.getElementById('first_name').value, 'Typed');
  assert.equal(document.getElementById('city').value, 'b');
  assert.equal(document.querySelector('input[name=r]:checked').value, 'y');
  assert.equal(document.getElementById('essay').value, 'My own words');
  assert.equal(clicks, 0);
});

test('submit, navigation and destructive buttons are never clicked, even as options or "Add" rows', async () => {
  const labels = [
    'Submit application', 'Apply', 'Apply now', 'Next', 'Continue', 'Save and Continue', 'Review',
    'Back', 'Previous', 'Finish', 'Send', 'Sign in', 'Create Account', 'Remove', 'Delete', 'Done',
  ];
  const { adapter, document } = fixture(
    'workday',
    '<form data-automation-id="applicationForm"><label for="hear">How did you hear about us?</label>' +
      '<button type="button" id="hear" aria-haspopup="listbox" aria-controls="opts">Select One</button>' +
      '<div id="opts" role="listbox">' + labels.map((l) => '<div role="option">' + l + '</div>').join('') + '</div>' +
      labels.map((l) => '<button type="button">' + l + '</button>').join('') +
      '<button data-automation-id="bottom-navigation-next-button">Save</button></form>'
  );
  const clicked = [];
  let submits = 0;
  document.addEventListener('click', (e) => clicked.push(e.target.textContent));
  document.addEventListener('submit', () => submits++);
  const [hear] = adapter.collect();
  for (const l of labels) assert.equal(await adapter.write(hear, [l]), false, l);
  assert.deepEqual(clicked.filter((t) => t !== 'Select One'), []);
  // A yes/no style choice inside an implicit submit button is refused.
  const ashby = fixture(
    'ashby',
    '<form><div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title">Are you willing to relocate?</label>' +
      '<div class="ashby-application-form-input-yesno"><button data-option="yes">Yes</button><button data-option="no">No</button></div></div></form>'
  );
  let ashbyClicks = 0;
  ashby.document.addEventListener('click', () => ashbyClicks++);
  const [yn] = ashby.adapter.collect();
  assert.equal(await ashby.adapter.write(yn, ['Yes']), false);
  assert.equal(ashbyClicks, 0);
  assert.equal(submits, 0);
});

test('password inputs and credential forms are never collected or written', async () => {
  const { adapter, document } = fixture(
    'workday',
    '<div data-automation-id="applicationForm"><label for="pw">Password</label><input type="password" id="pw">' +
      '<label for="email">Email</label><input id="email" type="email"></div>' +
      '<form data-automation-id="applicationForm"><label for="e2">Email</label><input id="e2"><input type="password"></form>'
  );
  const fields = adapter.collect();
  assert.deepEqual(fields.map((d) => d.el.id), ['email']);
  assert.ok(await adapter.write(fields[0], ['pat@example.invalid']));
  assert.equal(document.getElementById('pw').value, '');
  assert.equal(document.getElementById('e2').value, '');
});

test('acknowledgement checkboxes stay unticked and CAPTCHA widgets are skipped', async () => {
  const { adapter, document } = fixture(
    'greenhouse',
    '<form id="application-form"><div class="field-wrapper"><label><input type="checkbox" id="ack" required>I acknowledge the privacy notice</label></div>' +
      '<div class="g-recaptcha" data-sitekey="x"><textarea name="g-recaptcha-response"></textarea></div>' +
      '<div class="cf-turnstile"><input name="cf-turnstile-response"></div></form>'
  );
  const fields = adapter.collect();
  assert.equal(fields.length, 1);
  assert.equal(F.classify(fields[0]).kind, 'protected');
  assert.equal(await adapter.write(fields[0], ['Yes']), false);
  assert.ok(!document.getElementById('ack').checked && !document.getElementById('ack').hasAttribute('checked'));
});

test('final-value check notices a value the form reverted, and saved answers are the control\'s own', async () => {
  const { adapter, document } = fixture(
    'lever',
    '<form id="application-form"><li class="application-question"><label><div class="application-label">Phone</div><input name="phone"></label></li>' +
      '<li class="application-question"><div class="application-label">Have you worked here before?</div><label><input type="radio" name="q1">Yes</label><label><input type="radio" name="q1">No</label></li></form>' +
      '<form><input type="radio" name="q1" checked></form>'
  );
  const [phone, radio] = adapter.collect();
  assert.ok(await adapter.write(phone, ['2025550100']));
  assert.ok(adapter.holds(phone, ['2025550100']));
  document.querySelector('input[name=phone]').value = '';
  assert.equal(adapter.holds(phone, ['2025550100']), false);
  // A checked radio of the same name elsewhere blocks filling, but is not an answer to save.
  assert.equal(adapter.read(radio), 'Already selected');
  assert.equal(adapter.answer(radio), '');
  radio.members[1].checked = true;
  assert.equal(adapter.answer(radio), 'No');
});

test('an attachment counts as kept when the ATS replaced the input with an upload widget or file chip', () => {
  const { adapter, document } = fixture(
    'greenhouse',
    '<form id="application-form"><div class="field-wrapper"><div class="label">Resume/CV</div><label for="resume">Attach</label><input id="resume" type="file"></div></form>'
  );
  const [resume] = adapter.collect();
  assert.equal(adapter.holds(resume, ['cv.pdf']), false);
  const box = document.querySelector('.field-wrapper');
  box.innerHTML = '<div role="progressbar" aria-valuenow="40"></div>';
  assert.equal(resume.el.isConnected, false);
  assert.ok(adapter.holds(resume, ['cv.pdf']));
  box.innerHTML = '<span>cv.pdf</span><button type="button">Remove</button>';
  assert.ok(adapter.holds(resume, ['cv.pdf']));
  box.innerHTML = '<button type="button">Attach</button>';
  assert.equal(adapter.holds(resume, ['cv.pdf']), false);
});

// Company-built forms (Tesla, Amazon, career sites): no known container.
const COMPANY_PAGE =
  '<header><form class="newsletter-signup__form"><label for="nl">Email</label><input id="nl" type="email"></form></header>' +
  '<main><h1>Software Engineer, New Grad</h1>' +
  '<form id="careers-apply" action="/careers/apply/submit">' +
  '<div class="form-group"><span class="label">First Name</span><input name="fn"></div>' +
  '<div class="form-group"><span class="label">Last Name</span><input name="ln"></div>' +
  '<div class="form-group"><input name="em" type="email" placeholder="Email"></div>' +
  '<div class="form-group"><label>Mobile <input name="ph" autocomplete="tel"></label></div>' +
  '<div class="form-group"><input name="c1" autocomplete="address-level2" aria-label="Where do you live"></div>' +
  '<div class="form-group"><span class="label">Resume</span><input type="file" name="resume"></div>' +
  '<div class="form-group"><span class="label">Will you now or in the future require sponsorship for employment visa status?</span>' +
  '<label><input type="radio" name="spon" value="yes">Yes</label><label><input type="radio" name="spon" value="no">No</label></div>' +
  '<div class="form-group"><span class="label">Why Tesla?</span><textarea name="why"></textarea></div>' +
  '<div class="form-group"><label><input type="checkbox" name="ack"> I certify the information is accurate</label></div>' +
  '<button type="submit">Submit application</button></form>' +
  '<form role="search"><input name="q" placeholder="Search jobs"><input name="loc" placeholder="Location"></form>' +
  '</main><footer><form><input type="email" placeholder="Email"><input placeholder="Name"></form></footer>';

test('company-built forms: the application form is found, decoy forms are ignored', () => {
  const { adapter } = fixture('generic', COMPANY_PAGE);
  const fields = adapter.collect();
  const names = fields.map((d) => d.name);
  assert.deepEqual(names, ['fn', 'ln', 'em', 'ph', 'c1', 'resume', 'spon', 'why', 'ack']);
  const profile = {
    identity: { firstName: 'Pat', lastName: 'Example' },
    contact: { email: 'pat@example.invalid', phone: '2025550100' },
    address: { city: 'Boston' },
    workAuth: { requiresSponsorshipNow: false, requiresSponsorshipFuture: true },
  };
  const by = Object.fromEntries(fields.map((d) => [d.name, d]));
  assert.equal(by.fn.label, 'First Name');
  assert.equal(by.em.label, 'Email', 'placeholder is the last resort');
  assert.deepEqual(F.resolve(by.fn, profile), ['Pat']);
  assert.deepEqual(F.resolve(by.ln, profile), ['Example']);
  assert.deepEqual(F.resolve(by.em, profile), ['pat@example.invalid']);
  assert.deepEqual(F.resolve(by.ph, profile), ['2025550100']);
  assert.deepEqual(F.resolve(by.c1, profile), ['Boston'], 'autocomplete hint when the label is unusual');
  assert.equal(F.classify(by.resume).kind, 'resume');
  assert.equal(F.classify(by.spon).kind, 'sponsorship');
  assert.deepEqual(F.resolve(by.spon, profile), ['Yes']);
  assert.equal(F.classify(by.why).kind, 'question', 'essays only from saved answers');
  assert.equal(F.classify(by.ack).kind, 'protected', 'attestations are never ticked');
});

test('company-built pages without an application form give nothing to fill', () => {
  const { adapter } = fixture(
    'generic',
    '<header><form class="newsletter"><input type="email" placeholder="Email"><input placeholder="Name"></form></header>' +
      '<main><h1>Careers</h1><form role="search"><input name="q"><input name="loc"><select name="team"><option>All</option></select></form>' +
      '<form><input name="user"><input type="password" name="pw"></form></main>'
  );
  assert.deepEqual(adapter.collect(), []);
});

test('company-built forms keep what the user typed and never press submit', async () => {
  const { adapter, document } = fixture('generic', COMPANY_PAGE);
  const fields = adapter.collect();
  const fn = fields.find((d) => d.name === 'fn');
  fn.el.value = 'Patricia';
  assert.equal(await adapter.write(fn, ['Pat']), false);
  assert.equal(fn.el.value, 'Patricia');
  let submits = 0;
  document.addEventListener('submit', () => submits++);
  // (Radio clicks need a real browser; linkedom doesn't toggle them.)
  const email = fields.find((d) => d.name === 'em');
  assert.ok(await adapter.write(email, ['pat@example.invalid']));
  assert.equal(email.el.value, 'pat@example.invalid');
  assert.equal(submits, 0);
  assert.ok(!fields.some((d) => d.el.type === 'submit'), 'the submit button is never a field');
});

// ─── Education and experience from the profile ─────────────────────────────
const eduProfile = {
  education: [
    { school: 'Northeastern University', degree: 'M.S.', field: 'Computer Science', gpa: '3.8', startDate: '2024-09', endDate: '2026-05' },
  ],
  experience: [
    { company: 'Old Co', title: 'Analyst', startDate: '2022-06', endDate: '2023-12', current: false },
    { company: 'Acme', title: 'Software Engineer', startDate: '2024-01', endDate: '', current: true },
  ],
};

// linkedom has no select.value setter and no checkbox state: just enough of both.
function formPolyfill(window) {
  const Select = Object.getPrototypeOf(window.document.createElement('select'));
  Object.defineProperty(Select, 'value', {
    configurable: true,
    get() {
      return this.querySelector('option[selected]')?.getAttribute('value') || '';
    },
    set(v) {
      for (const o of this.querySelectorAll('option')) o.toggleAttribute('selected', o.getAttribute('value') === v);
    },
  });
  const Input = Object.getPrototypeOf(window.document.createElement('input'));
  Object.defineProperty(Input, 'checked', {
    configurable: true,
    get() {
      return this.hasAttribute('checked');
    },
    set(v) {
      this.toggleAttribute('checked', !!v);
    },
  });
  Input.click = function () {
    if (this.getAttribute('type') === 'checkbox') this.checked = !this.checked;
    this.dispatchEvent(new window.Event('click', { bubbles: true }));
  };
}
const selected = (sel) => sel.querySelector('option[selected]')?.textContent;

async function fillAll(adapter, profile) {
  const out = {};
  for (const d of adapter.collect()) {
    const values = F.resolve(d, profile);
    out[d.label || d.automationId] = values.length ? await adapter.write(d, values) : null;
  }
  return out;
}

test('Greenhouse education: degree and discipline selects, month and year selects, school typed', async () => {
  const opts = (list) => '<option value="">Select...</option>' + list.map((o, i) => `<option value="${i + 1}">${o}</option>`).join('');
  const { adapter, document, window } = fixture(
    'greenhouse',
    '<form id="application-form"><div class="education--container"><div class="education--form">' +
      '<div class="field-wrapper"><label for="school">School</label><input id="school"></div>' +
      `<div class="field-wrapper"><label for="degree">Degree</label><select id="degree">${opts(["Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Other'])}</select></div>` +
      `<div class="field-wrapper"><label for="discipline">Discipline</label><select id="discipline">${opts(['Computer Science', 'Engineering'])}</select></div>` +
      `<fieldset><legend>Start date</legend><label for="sm">Month</label><select id="sm">${opts(['January', 'September'])}</select><label>Year<input></label></fieldset>` +
      `<fieldset><legend>End date</legend><label for="em">Month</label><select id="em">${opts(['May', 'June'])}</select><label>Year<input></label></fieldset>` +
      '</div></div><button>Submit Application</button></form>'
  );
  formPolyfill(window);
  await fillAll(adapter, eduProfile);
  const value = (sel) => document.querySelector(sel);
  assert.equal(value('#school').value, 'Northeastern University');
  assert.equal(selected(value('#degree')), "Master's Degree");
  assert.equal(selected(value('#discipline')), 'Computer Science');
  const [startM, endM] = document.querySelectorAll('fieldset select');
  const [startY, endY] = document.querySelectorAll('fieldset input');
  assert.equal(selected(startM), 'September');
  assert.equal(startY.value, '2024');
  assert.equal(selected(endM), 'May');
  assert.equal(endY.value, '2026');
});

test('an empty profile fills no education or experience field', async () => {
  const { adapter, document } = fixture(
    'greenhouse',
    '<form id="application-form"><div class="field-wrapper"><label for="s">School</label><input id="s"></div>' +
      '<div class="field-wrapper"><label for="g">GPA</label><input id="g"></div>' +
      '<div class="field-wrapper"><label for="m">Major</label><input id="m"></div></form>'
  );
  const result = await fillAll(adapter, {});
  assert.deepEqual(Object.values(result), [null, null, null]);
  assert.deepEqual([...document.querySelectorAll('input')].map((i) => i.value), ['', '', '']);
});

test('Workday My Experience: two jobs, Add, Workday month/year boxes, "I currently work here"', async () => {
  const job = (n) =>
    `<div data-automation-id="workExperience-${n}"><div data-automation-id="formField-jobTitle"><label for="t${n}">Job Title</label><input id="t${n}"></div>` +
    `<div data-automation-id="formField-companyName"><label for="c${n}">Company</label><input id="c${n}"></div>` +
    `<div data-automation-id="formField-currentlyWorkHere"><label for="w${n}">I currently work here</label><input type="checkbox" id="w${n}"></div>` +
    `<div data-automation-id="formField-startDate"><label>From</label><input aria-label="Month" data-automation-id="dateSectionMonth-input"><input aria-label="Year" data-automation-id="dateSectionYear-input"></div></div>`;
  const { adapter, document, window } = fixture(
    'workday',
    '<div data-automation-id="applyFlowPage"><div data-automation-id="workExperienceSection"><h3>Work Experience</h3>' +
      job(1) +
      '<button type="button" data-automation-id="Add">Add Another</button></div>' +
      '<button data-automation-id="bottom-navigation-next-button">Save and Continue</button></div>'
  );
  const add = document.querySelector('[data-automation-id="Add"]');
  add.onclick = () => add.insertAdjacentHTML('beforebegin', job(2));
  formPolyfill(window);
  await adapter.expand(eduProfile);
  assert.equal(document.querySelectorAll('[data-automation-id^="workExperience-"]').length, 2, 'one Add click');
  await fillAll(adapter, eduProfile);
  const v = (sel) => document.querySelector(sel);
  assert.equal(v('#t1').value, 'Analyst');
  assert.equal(v('#c2').value, 'Acme');
  assert.equal(v('#w1').checked, false);
  assert.equal(v('#w2').checked, true);
  const months = document.querySelectorAll('[data-automation-id="dateSectionMonth-input"]');
  const years = document.querySelectorAll('[data-automation-id="dateSectionYear-input"]');
  assert.deepEqual([months[0].value, years[0].value, months[1].value, years[1].value], ['06', '2022', '01', '2024']);
});

test('honeypot fields are never collected or filled', () => {
  const { adapter } = fixture(
    'workday',
    '<div data-automation-id="applyFlowPage"><div data-automation-id="formField-email"><label for="e">Email Address</label><input id="e"></div>' +
      '<label for="b">Enter website. This input is for robots only, do not enter if you\'re human.</label><input id="b" data-automation-id="beecatcher"></div>'
  );
  assert.deepEqual(adapter.collect().map((d) => d.el.id), ['e']);
});
