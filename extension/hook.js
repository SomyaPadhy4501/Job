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
