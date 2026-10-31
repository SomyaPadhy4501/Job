// Runs in the PAGE's JavaScript world (manifest "world": "MAIN") at
// document_start, so it is in place before the careers page fires its first
// request. It only observes: every response is cloned and passed through
// untouched. JSON bodies are handed to content.js via window.postMessage.
(() => {
  if (window.__jobCaptureHooked) return;
  window.__jobCaptureHooked = true;

  const MAX_BYTES = 15 * 1024 * 1024; // a full Tesla-size board is a few MB
  const post = (url, text) => {
    if (!text || text.length > MAX_BYTES) return;
    const c = text.trimStart()[0];
    if (c !== '{' && c !== '[') return;
    window.postMessage({ __jobCapture: true, url: String(url), text }, window.location.origin);
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const type = res.headers.get('content-type') || '';
      if (/json|text\/plain/.test(type)) {
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
  ];
  window.addEventListener('load', () => {
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
    this.addEventListener('load', () => {
      try {
        if (this.responseType === '' || this.responseType === 'text') post(url, this.responseText);
        else if (this.responseType === 'json' && this.response) post(url, JSON.stringify(this.response));
      } catch {
        /* never break the page */
      }
    });
    return origOpen.call(this, method, url, ...rest);
  };
})();
