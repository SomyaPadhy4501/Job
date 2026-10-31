// Isolated-world content script. Receives JSON bodies from hook.js, reads
// JSON-LD / __NEXT_DATA__ from the DOM, runs the generic extractor, and hands
// usable rows to the background worker. Never makes a request of its own.
(() => {
  const { extractFromJson, extractFromJsonLd, usable, companyFromHost, companyFromUrl, cleanSiteName } = globalThis.JobExtract;

  function pageCompany() {
    const og = document.querySelector('meta[property="og:site_name"]')?.content;
    return companyFromUrl(location.href) || cleanSiteName(og) || companyFromHost(location.hostname);
  }

  // Recover a job URL from the rendered page. `token` is either an id (the
  // JSON gave {id, title, location} and left the link to the front end) or a
  // relative path (Workday's externalPath, which omits the site segment the
  // real link carries). Ids match as a whole token; paths match as a suffix.
  function findLink(token) {
    const s = String(token);
    if (s.length < 3) return '';
    const isPath = s.startsWith('/');
    const re = isPath
      ? null
      : new RegExp(`(^|[^0-9A-Za-z])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z]|$)`);
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const abs = new URL(href, location.href);
      if (isPath ? abs.pathname.endsWith(s) : re.test(href)) return abs.toString();
    }
    return '';
  }

  const ctx = () => ({ pageUrl: location.href, company: pageCompany(), findLink });

  // Responses usually arrive before the page has rendered its job links, and
  // findLink needs those links. So bodies are held, and extraction runs once
  // the page has been quiet for a moment.
  let pendingJson = [];
  let pendingLd = [];
  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, 2500);
  }
  function flush() {
    const c = ctx();
    const rows = usable([
      ...pendingJson.flatMap((j) => extractFromJson(j, c)),
      ...extractFromJsonLd(pendingLd, c),
    ]).map((r) => ({ ...r, company_name: r.company_name || c.company }));
    pendingJson = [];
    pendingLd = [];
    if (rows.length) chrome.runtime.sendMessage({ type: 'jobs', pageUrl: location.href, rows });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__jobCapture !== true) return;
    try {
      pendingJson.push(JSON.parse(e.data.text));
      schedule();
    } catch {
      /* not JSON after all */
    }
  });

  function scanDom() {
    const blocks = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { blocks.push(JSON.parse(s.textContent)); } catch { /* skip malformed */ }
    }
    pendingLd.push(...blocks);
    // Next.js pages ship their initial data inline rather than fetching it.
    const next = document.getElementById('__NEXT_DATA__');
    if (next) {
      try { pendingJson.push(JSON.parse(next.textContent)); } catch { /* skip */ }
    }
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanDom);
  else scanDom();
})();
