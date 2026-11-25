'use strict';

// Shared by the isolated capture script and the worker. URL checks are also
// repeated after asynchronous operations because ATS navigation can be in-place.
(function (root) {
  function ats(host) {
    if (/(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(host)) return 'workday';
    return (
      {
        'boards.greenhouse.io': 'greenhouse',
        'job-boards.greenhouse.io': 'greenhouse',
        'jobs.lever.co': 'lever',
        'jobs.ashbyhq.com': 'ashby',
      }[host] || ''
    );
  }
  function privatePage(href) {
    const url = new URL(href);
    if (
      /(?:^|\/)(?:apply|application|applications|userHome|candidateHome|login|signin)(?:\/|$)/i.test(
        url.pathname
      )
    )
      return true;
    const site = ats(url.hostname);
    if (site === 'workday') return /\/job\/|candidate|apply|register/i.test(url.pathname);
    if (site) return url.pathname.split('/').filter(Boolean).length > 1 || url.searchParams.has('gh_jid');
    return false;
  }
  // On supported ATS boards only public listing responses can cross from
  // page world to capture. This also covers prefetches before an SPA changes URL.
  function publicResponse(href, response) {
    if (privatePage(href)) return false;
    const page = new URL(href),
      site = ats(page.hostname);
    if (!site) return true;
    const url = new URL(response, page);
    if (url.origin !== page.origin) return false;
    if (site === 'workday') return /^\/wday\/cxs\/[^/]+\/[^/]+\/jobs$/.test(url.pathname);
    if (site === 'ashby') return ['ApiJobBoard', 'ApiJobBoardWithTeams'].includes(url.searchParams.get('op'));
    return /^\/(?:v0\/postings\/[^/]+|v1\/boards\/[^/]+\/jobs)$/.test(url.pathname);
  }
  // The Workday company a page belongs to: the host's first label on
  // myworkdayjobs.com ("nvidia" in nvidia.wd5.myworkdayjobs.com), the path on
  // myworkdaysite.com (wd1.myworkdaysite.com/en-US/recruiting/<tenant>/...).
  function workdayTenant(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return '';
    }
    if (/(?:^|\.)myworkdayjobs\.com$/.test(url.hostname)) return url.hostname.split('.')[0].toLowerCase();
    if (/(?:^|\.)myworkdaysite\.com$/.test(url.hostname)) {
      const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?recruiting\/([^/]+)/i.exec(url.pathname);
      return m ? m[1].toLowerCase() : '';
    }
    return '';
  }
  // The Greenhouse job board a page belongs to: the first path segment on
  // (job-)boards.greenhouse.io/<board>/jobs/..., or `for` on the embedded form
  // (job-boards.greenhouse.io/embed/job_app?for=<board>). Codes are matched to
  // the company with it, since every Greenhouse company mails from one address.
  function greenhouseBoard(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return '';
    }
    if (ats(url.hostname) !== 'greenhouse') return '';
    const first = url.pathname.split('/').filter(Boolean)[0] || '';
    const board = (first === 'embed' || !first ? url.searchParams.get('for') || '' : first).toLowerCase();
    return /^[a-z0-9_-]{1,64}$/.test(board) ? board : '';
  }
  // ─── Application systems, for autofill, sign-in and emailed codes ───────
  // Not used by listing capture (see `ats` above). Each system: the hosts its
  // application pages live on, and the domains its emails come from. A code
  // or link from Gmail is used on a page only when the email came from the
  // page's own system, or from the employer's own domain.
  const SYSTEMS = {
    workday: { hosts: ['myworkdayjobs.com', 'myworkdaysite.com', 'myworkday.com'], mail: ['myworkday.com'] },
    greenhouse: { hosts: ['greenhouse.io'], mail: ['greenhouse.io', 'greenhouse-mail.io'] },
    lever: { hosts: ['lever.co'], mail: ['lever.co'] },
    ashby: { hosts: ['ashbyhq.com'], mail: ['ashbyhq.com'] },
    icims: { hosts: ['icims.com'], mail: ['icims.com'] },
    smartrecruiters: { hosts: ['smartrecruiters.com'], mail: ['smartrecruiters.com'] },
    taleo: { hosts: ['taleo.net'], mail: ['taleo.net', 'oracle.com'] },
    oracle: { hosts: ['oraclecloud.com'], mail: ['oraclecloud.com', 'oracle.com'] },
    successfactors: {
      hosts: ['successfactors.com', 'successfactors.eu', 'sapsf.com', 'sapsf.eu', 'sapsf.cn'],
      mail: ['successfactors.com', 'successfactors.eu', 'sapsf.com', 'sap.com'],
    },
    jobvite: { hosts: ['jobvite.com'], mail: ['jobvite.com'] },
    workable: { hosts: ['workable.com'], mail: ['workable.com', 'workablemail.com'] },
    bamboohr: { hosts: ['bamboohr.com'], mail: ['bamboohr.com'] },
    breezy: { hosts: ['breezy.hr'], mail: ['breezy.hr'] },
    jazzhr: { hosts: ['applytojob.com', 'jazzhr.com'], mail: ['applytojob.com', 'jazzhr.com'] },
    recruitee: { hosts: ['recruitee.com'], mail: ['recruitee.com'] },
    teamtailor: { hosts: ['teamtailor.com'], mail: ['teamtailor.com', 'teamtailor-mail.com'] },
    personio: { hosts: ['personio.de', 'personio.com'], mail: ['personio.de', 'personio.com'] },
    rippling: { hosts: ['rippling.com', 'rippling-ats.com'], mail: ['rippling.com'] },
    eightfold: { hosts: ['eightfold.ai'], mail: ['eightfold.ai'] },
    avature: { hosts: ['avature.net'], mail: ['avature.net'] },
    phenom: { hosts: ['phenompeople.com'], mail: ['phenompeople.com', 'phenom.com'] },
    paylocity: { hosts: ['paylocity.com'], mail: ['paylocity.com'] },
    ukg: { hosts: ['ultipro.com', 'ukg.net', 'ukg.com'], mail: ['ultipro.com', 'ukg.com', 'ukg.net'] },
    adp: { hosts: ['adp.com'], mail: ['adp.com'] },
    dayforce: { hosts: ['dayforcehcm.com'], mail: ['dayforcehcm.com', 'ceridian.com', 'dayforce.com'] },
    cornerstone: { hosts: ['csod.com'], mail: ['csod.com'] },
    paycom: { hosts: ['paycomonline.net', 'paycomonline.com'], mail: ['paycomonline.com', 'paycomonline.net'] },
    gem: { hosts: ['gem.com'], mail: ['gem.com'] },
    wellfound: { hosts: ['wellfound.com'], mail: ['wellfound.com'] },
    dover: { hosts: ['dover.com', 'dover.io'], mail: ['dover.com'] },
    pinpoint: { hosts: ['pinpointhq.com'], mail: ['pinpointhq.com'] },
    comeet: { hosts: ['comeet.com', 'comeet.co'], mail: ['comeet.com', 'comeet.co'] },
    freshteam: { hosts: ['freshteam.com'], mail: ['freshteam.com'] },
    zoho: { hosts: ['zohorecruit.com', 'zohorecruit.eu'], mail: ['zohorecruit.com', 'zohorecruit.eu'] },
    trinet: { hosts: ['trinethire.com'], mail: ['trinethire.com', 'trinet.com'] },
    applicantpro: { hosts: ['applicantpro.com'], mail: ['applicantpro.com'] },
    clearcompany: { hosts: ['clearcompany.com'], mail: ['clearcompany.com'] },
    hirebridge: { hosts: ['hirebridge.com'], mail: ['hirebridge.com'] },
    amazon: { hosts: ['amazon.jobs'], mail: ['amazon.jobs', 'amazon.com'] },
  };
  const within = (host, domain) => host === domain || host.endsWith('.' + domain);
  // The application system a host belongs to, or ''.
  function applySystem(host) {
    const h = String(host || '').toLowerCase();
    for (const [name, s] of Object.entries(SYSTEMS)) if (s.hosts.some((d) => within(h, d))) return name;
    return '';
  }
  // The site's own domain: the last two labels, three under a two-part
  // country suffix (careers.acme.co.uk → acme.co.uk).
  const TWO_PART = /^(?:co|com|org|net|ac|gov|edu|ne|or)\.[a-z]{2}$/;
  function siteDomain(host) {
    const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    if (labels.length < 2 || labels.every((l) => /^\d+$/.test(l))) return '';
    const two = labels.slice(-2).join('.');
    return TWO_PART.test(two) && labels.length >= 3 ? labels.slice(-3).join('.') : two;
  }
  // Where this page's emails may come from: its system's mail domains, plus
  // the employer's own domain on a company-hosted page.
  function mailDomains(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return [];
    }
    if (url.protocol !== 'https:') return [];
    const system = applySystem(url.hostname);
    if (system) return [...SYSTEMS[system].mail];
    const own = siteDomain(url.hostname);
    return own ? [own] : [];
  }
  // Where an emailed "verify your account" link for this page may point: its
  // system's hosts, or the employer's own domain.
  function linkHosts(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return [];
    }
    if (url.protocol !== 'https:') return [];
    const system = applySystem(url.hostname);
    if (system) return [...SYSTEMS[system].hosts];
    const own = siteDomain(url.hostname);
    return own ? [own] : [];
  }
  // Whether a link's host is one of these domains or below one.
  function hostWithin(href, domains) {
    try {
      const h = new URL(href).hostname.toLowerCase();
      return domains.some((d) => within(h, d));
    } catch {
      return false;
    }
  }
  const api = Object.freeze({
    ats,
    applySystem,
    greenhouseBoard,
    hostWithin,
    linkHosts,
    mailDomains,
    privatePage,
    publicResponse,
    siteDomain,
    workdayTenant,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobApplicationPages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
