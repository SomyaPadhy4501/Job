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
      school: 'school|university|school name|school or university',
      degree: 'degree',
      field: 'discipline|field of study|major',
      gpa: 'gpa',
    },
    experience: {
      company: 'company|company name|employer',
      title: 'job title|position title',
      location: 'location',
      description: 'role description|job description',
    },
  };
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

  function classify(d) {
    const label = key(d.label);
    const ids = [d.automationId, d.name, d.id].filter(Boolean).map(idKey);
    const context = [label, ...ids, d.safetyText, ...(d.options || [])].join(' ');
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
        for (const [field, labels] of Object.entries({
          ...names,
          startDate: 'start date|from',
          endDate: 'end date|to',
        })) {
          if (labels.split('|').includes(label)) return { kind: 'row', field };
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
        value = profile[d.row.section]?.[d.row.index]?.[c.field];
        break;
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
    const acceptable = new Set(values.map(key));
    const matches = options.map((label, i) => (acceptable.has(key(label)) ? i : -1)).filter((i) => i >= 0);
    return matches.length === 1 ? matches[0] : -1;
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

  const api = { clean, classify, resolve, pick, pickPlace, placeQuery, usDate, savedAnswer, rankResumes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutofillFields = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
