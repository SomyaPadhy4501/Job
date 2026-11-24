'use strict';

// Pure decisions shared by the isolated content script and the Node fixtures.
(function (root) {
  const clean = (value) =>
    String(value ?? '')
      .normalize('NFKC')
      .trim()
      .replace(/\s+/g, ' ');
  const key = (value) =>
    clean(value)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/\bu\.s\.(?:a\.)?|\busa\b/g, 'united states')
      .replace(/(?:\s*\((?:optional|required)\)|[\s✱*?:.])+$/g, '')
      .trim();
  const idKey = (value) =>
    key(
      String(value || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_\[\]-]+/g, ' ')
    )
      .replace(/\blinked in\b/g, 'linkedin')
      .replace(/\bgit hub\b/g, 'github');
  const aliases = new Map();
  function alias(path, names) {
    for (const name of names.split('|')) aliases.set(name, path);
  }
  alias(
    'identity.firstName',
    'first name|legal first name|given name|given name(s)|legal name section first name'
  );
  alias('identity.middleName', 'middle name');
  alias('identity.lastName', 'last name|legal last name|family name|surname|legal name section last name');
  alias('fullName', 'legal name|full name|name|systemfield name');
  alias('identity.preferredName', 'preferred name|preferred first name');
  alias('identity.pronouns', 'pronouns|personal pronouns');
  alias('contact.email', 'email|e-mail|email address|systemfield email');
  alias('contact.phone', 'phone|phone number|mobile phone|telephone|mobile number');
  alias('contact.phoneCountryCode', 'phone country code|country phone code');
  alias('address.line1', 'address line 1|street address');
  alias('address.line2', 'address line 2|apartment');
  alias('address.city', 'city|town');
  alias('address.state', 'state|province|state/province');
  alias('address.postalCode', 'postal code|zip|zip code|zip/postal code');
  alias('address.country', 'country|country of residence');
  alias(
    'location',
    'current location|location|systemfield location|where are you currently located|where are you located|where are you currently based|where are you based'
  );
  alias('fullLocation', 'please indicate your current city, state, and country');
  // Greenhouse's "Location (City)" is a place search: the city alone is ambiguous.
  alias('location', 'location (city)');
  alias('currentCompany', 'org|current company|current employer');
  alias('skillList', 'skills|list your skills');
  alias('links.linkedin', 'linkedin|linkedin url|linkedin profile|urls linkedin');
  alias('links.github', 'github|github url|github profile|urls github');
  alias('links.portfolio', 'portfolio|portfolio url|urls portfolio');
  alias('links.website', 'website|personal website|website url');
  alias('preferences.relocate', 'are you willing to relocate|willing to relocate');
  alias(
    'preferences.earliestStart',
    'earliest start date|when can you start|when can you start a new role|when could you start|what is your earliest start date|earliest available start date|available start date'
  );
  alias('preferences.workMode', 'preferred work mode|work mode preference');
  alias('preferences.salaryExpectation', 'salary expectation|salary expectations|expected salary');
  alias('misc.over18', 'are you 18 years of age or older|are you at least 18 years old');
  alias(
    'misc.howDidYouHear',
    'how did you hear about us|how did you hear about this job|please tell us how you heard about this opportunity'
  );

  // HTML autocomplete tokens (the last token, after any section-/billing
  // prefix). Used only when the label isn't one listed above: company-built
  // forms often carry these even when their labels are unusual. Sponsorship,
  // EEO and protected questions are decided before this and never reach it.
  const autocompleteHints = {
    'given-name': 'identity.firstName',
    'additional-name': 'identity.middleName',
    'family-name': 'identity.lastName',
    name: 'fullName',
    nickname: 'identity.preferredName',
    email: 'contact.email',
    tel: 'contact.phone',
    'tel-national': 'contact.phone',
    'tel-country-code': 'contact.phoneCountryCode',
    'address-line1': 'address.line1',
    'street-address': 'address.line1',
    'address-line2': 'address.line2',
    'address-level2': 'address.city',
    'address-level1': 'address.state',
    'postal-code': 'address.postalCode',
    'country-name': 'address.country',
    organization: 'currentCompany',
  };
  function autocompletePath(value) {
    const tokens = clean(value).toLowerCase().split(' ').filter(Boolean);
    if (!tokens.length || tokens.includes('off') || tokens.includes('on')) return null;
    return autocompleteHints[tokens[tokens.length - 1]] || null;
  }

  const rows = {
    education: {
      school:
        'school|university|school name|school or university|college|institution|university name|school or university name',
      degree: 'degree|degree type|type of degree|degree level',
      field: 'discipline|field of study|major|area of study|major/field of study|field of study/major',
      gpa: 'gpa|overall result (gpa)|cumulative gpa|overall gpa|gpa (out of 4.0)|grade point average',
    },
    experience: {
      company: 'company|company name|employer|employer name|organization',
      title: 'job title|position title|title|position|role',
      location: 'location|city',
      description: 'role description|job description|description|responsibilities|description of responsibilities',
    },
  };
  const START_LABEL = /^(?:start date|from|start|date from|from date|start month|start year)$/;
  const END_LABEL =
    /^(?:end date|to|end|date to|to date|end month|end year|graduation date|expected graduation date|expected graduation|graduation|to \(actual or expected\)|completion date|end date \(or expected\))$/;
  const CURRENT_JOB =
    /^(?:i (?:currently )?work here|currently work here|i am currently working (?:here|in this role)|current(?:ly)? employed(?: here)?|current (?:job|role|position|employer)|present|still working here)$/;
  const protectedText =
    /captcha|turnstile|acknowledg|privacy|consent|certif(?:y|ication)|attest|signature|background.check|terms of|agree(?:ment)?\b|i (?:accept|affirm|confirm|declare|understand|authorize)|by (?:checking|submitting|selecting)/i;
  const sensitive =
    /sponsor|visa|work authori[sz]ation|authori[sz]ed to work|citizen|immigration|right to work|eligible to work|work permit|permitted to work/;
  const eeoText =
    /gender|hispanic|latin[oax]|ethnicity|race\b|veteran|disabilit|sexual orientation|self.identif/;
  const eeoKeys = {
    gender: /^(?:gender|gender identity|what is your gender)$/,
    race: /^(?:race|race\/ethnicity|race and ethnicity)$/,
    hispanicLatino: /^(?:are you hispanic\/latino|hispanic or latino|are you hispanic or latino)$/,
    veteran: /^(?:protected )?veteran\s*status$/,
    disability: /^(?:disability status|disability)$/,
  };

  // Match complete questions. A suffix about citizenship, another country, a
  // second qualification or an exception changes the proposition being asked.
  const time = '(?:now or in the future|now or at any time in the future|in the future|now|currently)';
  const sponsor = new RegExp(
    '^(?:do you|will you|(?:do|will) you now or (?:do|will) you) (?:' +
      time +
      ' )?' +
      '(?:require|need) (?:employment |employer |immigration |visa |work visa )?sponsorship(?: ' +
      time +
      ')?' +
      '(?: for (?:an? )?(?:employment visa status|work visa)| (?:to work|for employment) in (?:the )?(?:us|united states)| to work at [\\w.-]+)?' +
      // "...in this country" / "...where the job is located": every job on
      // this board is in the US, so these mean the US (marked "check it").
      '(?: in (?:this country|the country where (?:the|this) (?:job|role|position) is located))?$'
  );
  // "Will you require Stripe to sponsor you for a US work permit now or in
  // the future?": the employer named in the middle. US (or no country) only;
  // the whole question must match, so another country's permit never does.
  const sponsorYou = new RegExp(
    '^(?:do|will) you (?:' +
      time +
      " )?(?:require|need) (?:[a-z0-9.&'-]+(?: [a-z0-9.&'-]+){0,3} )?to sponsor you" +
      '(?: for (?:an? )?(?:(?:us|united states) )?(?:work permit|work visa|employment visa|visa|work authorization))?' +
      '(?: to work in (?:the )?(?:us|united states))?(?: ' +
      time +
      ')?$'
  );
  function authQuestion(q) {
    const prompt = q.replace(/\s*\(e\.g\.,? (?:h-?1b(?: visa)?(?: status)?)(?:,? etc\.?)?\)$/i, '').replace(/,\s+/g, ' ');
    if (sponsor.test(prompt) || sponsorYou.test(prompt)) {
      const now = /\bnow\b|\bcurrently\b/.test(prompt);
      const future = /\bfuture\b/.test(prompt);
      return {
        kind: 'sponsorship',
        when: now && future ? 'either' : now ? 'now' : future ? 'future' : 'unspecified',
      };
    }
    if (
      /^are you (?:currently )?(?:legally )?(?:authori[sz]ed|eligible) to work in (?:(?:the )?(?:us|united states(?: of america)?)|this country|the country where (?:the|this) (?:job|role|position) is located)$/.test(
        q
      )
    )
      return { kind: 'authorizedUS' };
    if (
      /^(?:(?:what is|please select) your (?:current )?)?(?:visa type|visa status|immigration status)$/.test(
        q
      )
    )
      return { kind: 'visa' };
    if (/^(?:opt end date|opt expiration date)$/.test(q))
      return { kind: 'profile', path: 'workAuth.optEndDate' };
    return null;
  }

  // ─── Education and experience, from the profile only ─────────────────────
  // Standalone questions ("What school do you attend?", "Degree", "GPA"…)
  // answered from the profile's education/experience entries. Nothing in the
  // profile → nothing filled; no level, school or major is ever guessed.
  const eduQuestions = [
    [
      'school',
      /^(?:(?:name of )?(?:your )?(?:school|university|college|institution|educational institution|school or university|university or college|school\/university|college\/university)(?: name)?|(?:what|which) (?:school|university|college) (?:do|did) you (?:attend|go to)|where (?:do|did) you (?:go to school|study))$/,
    ],
    [
      'highest',
      /^(?:(?:what is your )?highest (?:level of education|education level|level of degree|degree(?: earned| obtained| completed| received)?)(?: (?:completed|attained|achieved|obtained|earned))?|level of education|education level)$/,
    ],
    [
      'degree',
      /^(?:degree|degree type|type of degree|degree level|(?:your |current )?degree(?: program)?|what degree are you (?:pursuing|working towards|currently pursuing)|degree (?:pursuing|obtained|earned|in progress))$/,
    ],
    [
      'field',
      /^(?:major|field of study|area of study|discipline|course of study|program of study|concentration|(?:what is your )?(?:major|field of study)|major\/field of study|field of study\/major|major\(s\))$/,
    ],
    [
      'gpa',
      /^(?:(?:what is your )?(?:cumulative |overall |undergraduate |graduate )?(?:gpa|grade point average)(?: \(.*\))?|overall result \(gpa\))$/,
    ],
    [
      'endDate',
      /^(?:(?:expected |anticipated )?(?:date of )?graduation(?: date| month| year| month\/year| date \(.*\))?|when (?:do|will|did) you graduate|grad(?:uation)? year|class year|expected completion date|graduation date \(actual or expected\))$/,
    ],
  ];
  const jobQuestions = [
    ['title', /^(?:(?:your )?current (?:job )?title|current position|current role|most recent (?:job )?title|most recent position)$/],
    ['company', /^(?:most recent (?:employer|company))$/],
  ];
  function eduQuestion(label) {
    for (const [field, re] of eduQuestions) if (re.test(label)) return { kind: 'education', field };
    for (const [field, re] of jobQuestions) if (re.test(label)) return { kind: 'experience', field };
    return null;
  }

  // Degree levels, read from free text ("B.S.", "BTech", "Master of Science").
  const RANK = { highSchool: 1, associate: 2, bachelor: 3, master: 4, mba: 4, doctorate: 5, md: 5, jd: 5 };
  const ABBR = {
    bachelor: ['bs', 'bsc', 'ba', 'ab', 'sb', 'be', 'beng', 'btech', 'bse', 'bba', 'bfa', 'bcs', 'bscs', 'bsee', 'bcom', 'bca'],
    master: ['ms', 'msc', 'ma', 'sm', 'meng', 'mtech', 'mcs', 'mse', 'mph', 'mfa', 'mas', 'mscs', 'msee', 'mca', 'mim', 'mps'],
    mba: ['mba'],
    doctorate: ['phd', 'dphil', 'edd', 'dsc'],
    md: ['md'],
    jd: ['jd'],
    associate: ['aa', 'as', 'aas'],
  };
  const degreeNorm = (s) =>
    clean(s)
      .toLowerCase()
      .replace(/[’‘`]/g, "'")
      .replace(/'s\b/g, 's')
      .replace(/['.(),\-–—/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  function degreeLevel(text) {
    const t = degreeNorm(text);
    if (!t) return null;
    const head = t.split(/ (?:in|of|with) | - |,/)[0].replace(/ /g, '');
    for (const [level, list] of Object.entries(ABBR)) if (list.includes(head)) return level;
    if (/\b(?:doctor of medicine)\b/.test(t)) return 'md';
    if (/\bjuris doctor\b/.test(t)) return 'jd';
    if (/\bmaster of business administration\b/.test(t)) return 'mba';
    if (/\b(?:doctor of philosophy|doctorate|doctoral|phd)\b/.test(t)) return 'doctorate';
    if (/\bmasters?\b/.test(t)) return 'master';
    if (/\bbachelors?\b|\bundergraduate degree\b/.test(t)) return 'bachelor';
    if (/\bassociates?\b/.test(t)) return 'associate';
    if (/\bhigh school\b|\bsecondary school\b|\bged\b/.test(t)) return 'highSchool';
    return null;
  }
  // Same degree, other spellings (B.S. ↔ BS ↔ Bachelor of Science).
  const EQUIV = [
    ['B.S.', 'BS', 'B.Sc.', 'BSc', 'Bachelor of Science'],
    ['B.A.', 'BA', 'A.B.', 'Bachelor of Arts'],
    ['B.E.', 'BE', 'B.Eng.', 'BEng', 'Bachelor of Engineering'],
    ['B.Tech', 'B.Tech.', 'BTech', 'Bachelor of Technology'],
    ['M.S.', 'MS', 'M.Sc.', 'MSc', 'Master of Science'],
    ['M.A.', 'MA', 'Master of Arts'],
    ['M.Eng.', 'MEng', 'Master of Engineering'],
    ['M.Tech', 'M.Tech.', 'MTech', 'Master of Technology'],
    ['MBA', 'M.B.A.', 'Master of Business Administration', 'Master of Business Administration (M.B.A.)'],
    ['Ph.D.', 'PhD', 'Ph.D', 'Doctor of Philosophy', 'Doctor of Philosophy (Ph.D.)'],
    ['M.D.', 'MD', 'Doctor of Medicine', 'Doctor of Medicine (M.D.)'],
    ['J.D.', 'JD', 'Juris Doctor', 'Juris Doctor (J.D.)'],
  ];
  // The level in the wordings forms use for it.
  const GENERIC = {
    highSchool: ['High School', 'High School Diploma', 'High School or equivalent', 'High school diploma or GED', 'GED'],
    associate: ["Associate's Degree", "Associate's", 'Associates', 'Associate Degree', 'Associate'],
    bachelor: ["Bachelor's Degree", "Bachelor's", 'Bachelors', 'Bachelor', 'Bachelors Degree', 'Bachelor Degree'],
    master: ["Master's Degree", "Master's", 'Masters', 'Master', 'Masters Degree', 'Master Degree'],
    mba: ['Master of Business Administration (M.B.A.)', 'MBA', "Master's Degree", "Master's", 'Masters'],
    doctorate: ['Doctor of Philosophy (Ph.D.)', 'Doctorate', 'Doctoral Degree', 'Doctorate Degree', 'Ph.D.', 'PhD'],
    md: ['Doctor of Medicine (M.D.)', 'M.D.', 'MD'],
    jd: ['Juris Doctor (J.D.)', 'J.D.', 'JD'],
  };
  function degreeValues(text) {
    const own = clean(text);
    const level = degreeLevel(own);
    const head = own.split(/ (?:in|of) |,| - /i)[0];
    const equiv = EQUIV.find((list) => list.some((v) => degreeNorm(v) === degreeNorm(head) || degreeNorm(v) === degreeNorm(own))) || [];
    return tiered([[own], equiv, level ? GENERIC[level] : []], 'degree');
  }

  // Schools and majors: case, accents, "&"/"and", a leading "The", and
  // comma vs " - " don't matter. Nothing else is assumed.
  const nameNorm = (s) =>
    clean(s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/^the /, '')
      .replace(/[-–—,().\/:']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const FIELD_ABBR = {
    cs: 'Computer Science',
    'comp sci': 'Computer Science',
    ee: 'Electrical Engineering',
    ece: 'Electrical and Computer Engineering',
    ce: 'Computer Engineering',
    cse: 'Computer Science and Engineering',
    ds: 'Data Science',
    it: 'Information Technology',
    is: 'Information Systems',
    me: 'Mechanical Engineering',
  };
  function fieldValues(text) {
    const own = clean(text);
    const full = FIELD_ABBR[nameNorm(own)];
    return tiered([[own], full ? [full] : []], 'name');
  }

  // Months for selects that list "06", "6", "June" or "Jun".
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function monthNumber(s) {
    const t = clean(s).toLowerCase();
    const n = /^0?(\d{1,2})(?:\s|$|\b)/.exec(t);
    if (n && +n[1] >= 1 && +n[1] <= 12) return String(+n[1]);
    const i = MONTHS.findIndex((m) => t.startsWith(m) || new RegExp(`\\b${m}`).test(t));
    return i >= 0 ? String(i + 1) : '';
  }

  // Values in tiers: the first tier with exactly one matching option wins;
  // a tier matching two or more options stops (ambiguous: leave it empty).
  function tiered(tiers, match) {
    const kept = tiers.map((t) => t.filter((v) => clean(v))).filter((t) => t.length);
    const flat = [...new Set(kept.flat())];
    flat.tiers = kept;
    flat.match = match;
    return flat;
  }
  const norms = { degree: degreeNorm, name: nameNorm, month: monthNumber };

  // "2026-05" / "2026" / "2026-05-15", shown the way the control wants it.
  function datePart(value, d) {
    const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(clean(value));
    if (!m) return [];
    const [, y, mo, day] = m;
    const label = key(d.label);
    const ids = [d.automationId, d.boxId].filter(Boolean).join(' ').toLowerCase();
    const part = /month/.test(ids) || /^(?:month|start month|end month)$/.test(label)
      ? 'month'
      : /year/.test(ids) || /^(?:year|start year|end year|graduation year|grad year|class year)$/.test(label) || /\byear\b/.test(label) && !/month/.test(label)
        ? 'year'
        : '';
    if (part === 'year') return [y];
    if (part === 'month') return mo ? tiered([[mo]], 'month') : [];
    if (d.datePicker || d.type === 'date') return day ? [`${y}-${mo}-${day}`] : [];
    if (d.type === 'month') return mo ? [`${y}-${mo}`] : [];
    if (d.members) {
      // A select of whole dates is rare; only a plain year list fits.
      return [y];
    }
    const ph = clean(d.placeholder).toLowerCase();
    if (/^y{4}$/.test(ph)) return [y];
    if (!mo) return [];
    if (/^mm\s*\/\s*yy$/.test(ph)) return [`${mo}/${y.slice(2)}`];
    if (/^y{4}\s*-\s*mm$/.test(ph)) return [`${y}-${mo}`];
    if (/^mm\s*-\s*y{4}$/.test(ph)) return [`${mo}-${y}`];
    return [`${mo}/${y}`];
  }

  const dateKey = (s) => {
    const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(clean(s));
    return m ? `${m[1]}-${m[2] || '00'}-${m[3] || '00'}` : '';
  };
  const hasEdu = (e) => e && (clean(e.school) || clean(e.degree) || clean(e.field));
  // The entry still in progress, else the one that ended last (ties: the
  // higher degree, then the first listed).
  function primaryEducation(list) {
    const rank = (e) => RANK[degreeLevel(e.degree)] || 0;
    return (list || [])
      .filter(hasEdu)
      .map((e, i) => ({ e, i, open: !clean(e.endDate) && !!clean(e.startDate), end: dateKey(e.endDate) }))
      .sort((a, b) => (b.open - a.open) || b.end.localeCompare(a.end) || rank(b.e) - rank(a.e) || a.i - b.i)[0]?.e;
  }
  function highestEducation(list) {
    const ranked = (list || []).filter(hasEdu).filter((e) => degreeLevel(e.degree));
    if (!ranked.length) return null;
    const top = Math.max(...ranked.map((e) => RANK[degreeLevel(e.degree)]));
    return primaryEducation(ranked.filter((e) => RANK[degreeLevel(e.degree)] === top));
  }
  function currentJob(list) {
    const jobs = (list || []).filter((j) => j && (clean(j.company) || clean(j.title)));
    const current = jobs.filter((j) => j.current === true);
    const pool = current.length ? current : jobs;
    return [...pool].sort((a, b) => dateKey(b.startDate).localeCompare(dateKey(a.startDate)))[0];
  }

  function gpaValue(value, d) {
    const v = clean(value);
    const scaled = /^(\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?$/.exec(v);
    if (scaled && (d.type === 'number' || /out of|\/|scale/.test(key(d.label)))) return [scaled[1]];
    return v ? [v] : [];
  }

  // The values for one education or experience field.
  function eduValues(field, entry, d) {
    if (!entry) return [];
    const v = entry[field];
    if (field === 'current') return entry.current === true ? ['Checked'] : [];
    if (typeof v !== 'string' || !clean(v)) return [];
    if (field === 'degree') return degreeValues(v);
    if (field === 'school' || field === 'company') return tiered([[clean(v)]], 'name');
    if (field === 'field') return fieldValues(v);
    if (field === 'gpa') return gpaValue(v, d);
    if (field === 'startDate' || field === 'endDate') return datePart(v, d);
    return [clean(v)];
  }

  function classify(d) {
    const label = key(d.label);
    const ids = [d.automationId, d.name, d.id].filter(Boolean).map(idKey);
    const context = [label, ...ids, d.safetyText, ...(d.options || [])].join(' ');
    if (d.type === 'checkbox' && d.row?.section === 'experience' && CURRENT_JOB.test(label) && !protectedText.test(context))
      return { kind: 'row', field: 'current' };
    if (
      protectedText.test(context) ||
      /\bshare (?:my|your) (?:resume|contact|personal)/i.test(context) ||
      ['password', 'checkbox'].includes(d.type)
    )
      return { kind: 'protected' };
    if (d.type === 'file') {
      const resume = /^(?:resume(?:\/cv)?|cv|résumé|attach resume(?:\/cv)?)$/;
      if (ids.some((id) => id.includes('cover letter'))) return { kind: 'protected' };
      const resumeId = ids.some((id) => ['systemfield resume', 'resume'].includes(id));
      return {
        kind:
          resume.test(label) || (resumeId && /^(?:attach|upload|resume|)$/.test(label))
            ? 'resume'
            : 'protected',
      };
    }
    if (d.row) {
      const names = rows[d.row.section];
      if (names) {
        for (const [field, labels] of Object.entries(names)) {
          if (labels.split('|').includes(label)) return { kind: 'row', field };
        }
        if (START_LABEL.test(label)) return { kind: 'row', field: 'startDate' };
        if (END_LABEL.test(label)) return { kind: 'row', field: 'endDate' };
        const boxIds = [d.boxId].filter(Boolean).map(idKey).join(' ');
        if (/^(?:month|year)$/.test(label) || /date section (?:month|year)/.test(ids.join(' '))) {
          const group = [key(d.safetyText || ''), boxIds].join(' ');
          if (/\b(?:start|from)\b/.test(group)) return { kind: 'row', field: 'startDate' };
          if (/\b(?:end|to|graduation|expected|completion)\b/.test(group)) return { kind: 'row', field: 'endDate' };
        }
      }
      return { kind: 'manual' };
    }
    const auth = authQuestion(label);
    if (auth) return auth;
    if (sensitive.test(label)) return { kind: 'manual' };
    for (const [field, pattern] of Object.entries(eeoKeys)) {
      if (pattern.test(label)) return { kind: 'eeo', field };
    }
    if (eeoText.test(label) || d.eeo || ids.some((id) => id.startsWith('eeo '))) return { kind: 'manual' };
    const edu = eduQuestion(label);
    if (edu && d.type !== 'file') return edu;
    if (label === 'preferred name | what would you like us to call you')
      return { kind: 'profile', path: 'identity.preferredName' };
    const path =
      aliases.get(label) ||
      (!label && ids.map((id) => aliases.get(id)).find(Boolean)) ||
      (!aliases.has(label) && autocompletePath(d.autocomplete));
    if (path && d.type !== 'textarea') return { kind: 'profile', path };
    return { kind: label ? 'question' : 'manual' };
  }

  // Fuzzy only across presentation differences. Never drop substantive words,
  // numbers, negations or programming-language punctuation (C, C++, C#).
  function questionKey(text) {
    return clean(text)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/^please\s+/, '')
      .replace(/^could you (?:please )?(tell|describe|explain|list)\b/, '$1')
      .replace(/^what's\b/, 'what is')
      .replace(/[?.✱\s]+$/g, '');
  }
  function savedAnswer(question, answers) {
    const k = questionKey(question);
    const matches = new Set(
      (answers || [])
        .filter((a) => k && questionKey(a.question) === k)
        .map((a) => clean(a.answer))
        .filter(Boolean)
    );
    return matches.size === 1 ? matches.values().next().value : null;
  }

  const visaLabels = {
    citizen: ['US Citizen', 'United States Citizen', 'U.S. Citizen'],
    permanent_resident: ['Permanent Resident', 'Green Card Holder'],
    h1b: ['H-1B', 'H1B'],
    f1_opt: ['F-1 OPT', 'F1 OPT'],
    f1_stem_opt: ['F-1 STEM OPT', 'F1 STEM OPT'],
    f1_cpt: ['F-1 CPT', 'F1 CPT'],
    other: ['Other'],
  };
  // Profile enums map to the usual option wording; pick() still needs exactly one match.
  const workModeLabels = {
    onsite: ['On-site', 'Onsite', 'On site', 'In office', 'In-office', 'In person'],
    hybrid: ['Hybrid'],
    remote: ['Remote', 'Fully remote'],
    any: ['Any', 'No preference', 'Flexible', 'Open to any'],
  };
  const decline = [
    'Decline',
    'Decline to answer',
    'Prefer not to say',
    'Decline to self identify',
    'I do not want to answer',
    "I don't wish to answer",
    'I decline to self-identify for protected veteran status',
  ];
  function profileValue(profile, path) {
    if (path === 'skillList')
      return profile.skills?.filter((skill) => typeof skill === 'string' && clean(skill)).join(', ');
    if (path === 'fullName') {
      const { firstName, middleName, lastName } = profile.identity || {};
      return firstName && lastName && [firstName, middleName, lastName].filter(Boolean).join(' ');
    }
    if (path === 'location' || path === 'fullLocation') {
      const { city, state, country } = profile.address || {};
      if (path === 'fullLocation' && !(city && state && country)) return null;
      return city && [city, state, country].filter(Boolean).join(', ');
    }
    if (path === 'currentCompany') {
      const current = (profile.experience || []).filter((job) => job.current === true);
      return current.length === 1 ? current[0].company : null;
    }
    return path.split('.').reduce((v, k) => v?.[k], profile);
  }
  function sponsorship(when, auth) {
    const now = auth.requiresSponsorshipNow,
      future = auth.requiresSponsorshipFuture;
    if (when === 'now') return now;
    if (when === 'future') return future;
    if (when === 'unspecified' && now !== future) return null;
    if (now === true || future === true) return true;
    return now === false && future === false ? false : null;
  }
  function resolve(d, profile = {}, answers = []) {
    const c = classify(d);
    let value;
    switch (c.kind) {
      case 'profile':
        value = profileValue(profile, c.path);
        if (c.path === 'preferences.workMode') return workModeLabels[value] || [];
        break;
      case 'row':
        if (d.row.section === 'education' || d.row.section === 'experience')
          return eduValues(c.field, profile[d.row.section]?.[d.row.index], d);
        value = profile[d.row.section]?.[d.row.index]?.[c.field];
        break;
      case 'education': {
        const list = profile.education;
        const entry = c.field === 'highest' ? highestEducation(list) : primaryEducation(list);
        return eduValues(c.field === 'highest' ? 'degree' : c.field, entry, d);
      }
      case 'experience':
        return eduValues(c.field, currentJob(profile.experience), d);
      case 'authorizedUS':
        value = profile.workAuth?.authorizedUS;
        break;
      case 'sponsorship':
        value = sponsorship(c.when, profile.workAuth || {});
        break;
      case 'visa':
        return visaLabels[profile.workAuth?.visaStatus] || [];
      case 'eeo':
        value = profile.eeo?.[c.field];
        if (value === 'decline') return decline;
        break;
      case 'question':
        value = savedAnswer(d.label, answers);
        break;
      default:
        return [];
    }
    if (typeof value === 'boolean') return [value ? 'Yes' : 'No'];
    return (typeof value === 'number' || typeof value === 'string') && clean(value)
      ? [String(value).trim()]
      : [];
  }
  function pick(options, values) {
    const norm = norms[values.match] || key;
    for (const tier of values.tiers || [values]) {
      const acceptable = new Set(tier.map(norm).filter(Boolean));
      const matches = options.map((label, i) => (acceptable.has(norm(label)) ? i : -1)).filter((i) => i >= 0);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return -1;
    }
    return -1;
  }
  // Location search boxes list places as "City, State, Country". The profile
  // may say "CA" or "USA"; every part the profile gives must appear, and the
  // city must be the first part, so "San Francisco Bay Area" never matches.
  const usStates = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
    ct: 'connecticut', de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia',
    hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky',
    la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
    ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire',
    nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota',
    oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island',
    sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
    va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
  };
  const placePart = (part) => {
    const k = key(part)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/^united states of america$/, 'united states')
      .replace(/^us$/, 'united states');
    return Object.hasOwn(usStates, k) ? usStates[k] : k;
  };
  const placeParts = (value) => clean(value).split(',').map(placePart).filter(Boolean);
  function placeQuery(value) {
    return placeParts(value).length ? clean(value).split(',')[0].trim() : '';
  }
  function pickPlace(options, value) {
    const want = placeParts(value);
    if (!want.length) return -1;
    const matches = options
      .map((option, i) => {
        const have = placeParts(option);
        return have[0] === want[0] && want.slice(1).every((w) => have.slice(1).includes(w)) ? i : -1;
      })
      .filter((i) => i >= 0);
    return matches.length === 1 ? matches[0] : -1;
  }
  // Date pickers that take typed text (react-datepicker) read US order.
  function usDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(iso));
    return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
  }
  function rankResumes(resumes, title, page, preferred) {
    const words = (value) =>
      ' ' +
      clean(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
        .trim() +
      ' ';
    const heading = words(title),
      body = words(page);
    const synonyms = {
      swe: ['software engineer', 'software engineering'],
      ml: ['machine learning'],
      ai: ['artificial intelligence'],
    };
    const score = (r) =>
      (r.tags || []).filter(clean).reduce((sum, tag) => {
        const k = clean(tag).toLowerCase();
        const terms = [tag, ...(Object.hasOwn(synonyms, k) ? synonyms[k] : [])].map(words);
        return (
          sum + (terms.some((t) => heading.includes(t)) ? 4 : terms.some((t) => body.includes(t)) ? 1 : 0)
        );
      }, 0);
    return [...resumes].sort(
      (a, b) =>
        score(b) - score(a) ||
        Number(b.id === preferred) - Number(a.id === preferred) ||
        Number(!!b.isDefault) - Number(!!a.isDefault)
    );
  }

  const api = {
    clean,
    classify,
    resolve,
    pick,
    pickPlace,
    placeQuery,
    usDate,
    savedAnswer,
    rankResumes,
    degreeLevel,
    primaryEducation,
    highestEducation,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutofillFields = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
