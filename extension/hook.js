// Runs in the PAGE's JavaScript world (manifest "world": "MAIN") at
// document_start, so it is in place before the careers page fires its first
// request. It only observes: every response is cloned and passed through
// untouched. JSON bodies are handed to content.js via window.postMessage.
(() => {
  // Runs in the page's world, separate from the isolated capture consumer.
  // On an autofill host, only known public board endpoints may be observed.
  const ats = /(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$|^(?:jobs\.ashbyhq\.com|jobs\.lever\.co|(?:job-)?boards\.greenhouse\.io)$/i.test(location.hostname);
  function application() {
    return /\/(?:apply|application|applications|userHome|candidateHome|login|signin)(?:\/|$)/i.test(location.pathname) ||
      ats && (location.hostname.includes('myworkday') ? /\/job\/|candidate|apply|register/i.test(location.pathname) :
        location.pathname.split('/').filter(Boolean).length > 1 || new URLSearchParams(location.search).has('gh_jid'));
  }
  function publicResponse(href, response) {
    if (application()) return false;
    if (!ats) return true;
    const u = new URL(response,href);
    return u.origin === location.origin && (/^\/wday\/cxs\/[^/]+\/[^/]+\/jobs$/.test(u.pathname) ||
      ['ApiJobBoard','ApiJobBoardWithTeams'].includes(u.searchParams.get('op')) ||
      /^\/(?:v0\/postings\/[^/]+|v1\/boards\/[^/]+\/jobs)$/.test(u.pathname));
  }
  if (application()) return;
  // Job-page gate. Chrome's match patterns can only test the URL *path* for
  // words like "jobs", so jobs.apple.com/en-us/search and Phenom boards such as
  // careers.chewy.com/us/en/search-results never got the scripts (2026-10-31).
  // The manifest therefore matches every page and this gate switches the
  // scripts off at once anywhere that isn't plausibly a careers page.
  const JOB_HOST = /^(?:careers?|jobs?|apply|talent|explore|work|join|hiring|opportunities)\.|(?:^|\.)(?:myworkdayjobs|ashbyhq|greenhouse|lever|smartrecruiters|workable|recruitee|pinpointhq|bamboohr|icims|avature|eightfold|oraclecloud|taleo|successfactors|jobvite|phenompeople|rippling|gem|linkedin|indeed|glassdoor)\.(?:com|io|co|net|ai)$/i;
  const JOB_PATH = /career|jobs?\b|\/job\/|search-results|positions|openings|vacanc|requisition/i;
  const looksLikeJobPage = JOB_HOST.test(location.hostname) || JOB_PATH.test(location.pathname);
  if (!looksLikeJobPage || window.__jobCaptureHooked) return;
  window.__jobCaptureHooked = true;

  const MAX_BYTES = 15 * 1024 * 1024; // a full Tesla-size board is a few MB
  const post = (url, text) => {
    if (!publicResponse(location.href, url)) return;
    if (!text || text.length > MAX_BYTES) return;
    const c = text.trimStart()[0];
    if (c !== '{' && c !== '[') return;
    window.postMessage({ __jobCapture: true, url: String(url), text }, window.location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const start = location.href;
    const res = await origFetch.apply(this, args);
    try {
      const type = res.headers.get('content-type') || '';
      if (start === location.href && publicResponse(start, res.url || args[0]) && /json|text\/plain/.test(type)) {
        res.clone().text().then((t) => post(res.url || args[0], t)).catch(() => {});
      }
    } catch {
      /* never break the page */
    }
    return res;
  };

  // Some job systems never fetch their listings — they embed them in a page
  // global at render time. Phenom (Lowe's, Cigna, Chewy, Yelp, WBD…) puts the
  // first page of results in phApp.ddo; Next.js / Nuxt / Redux apps use the
  // others. Report whichever exist once the page has loaded.
  const GLOBALS = [
    () => window.phApp && window.phApp.ddo,
    () => window.__INITIAL_STATE__,
    () => window.__NUXT__,
    () => window.__APOLLO_STATE__,
    () => window.__PRELOADED_STATE__,
    () => window.__staticRouterHydrationData, // React Router SSR (jobs.apple.com)
    () => window.__remixContext,
  ];
  window.addEventListener('load', () => {
    if (!publicResponse(location.href, 'global')) return;
    for (const get of GLOBALS) {
      try {
        const v = get();
        if (v && typeof v === 'object') post('global', JSON.stringify(v));
      } catch {
        /* circular or inaccessible — skip */
      }
    }
  });

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const start = location.href;
    this.addEventListener('load', () => {
      try {
        if (start !== location.href || !publicResponse(start, url)) return;
        if (this.responseType === '' || this.responseType === 'text') post(url, this.responseText);
        else if (this.responseType === 'json' && this.response) post(url, JSON.stringify(this.response));
      } catch {
        /* never break the page */
      }
    });
    return origOpen.call(this, method, url, ...rest);
  };
})();
