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
  const api = Object.freeze({ ats, privatePage, publicResponse });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobApplicationPages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
