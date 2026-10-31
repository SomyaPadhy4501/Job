// Isolated-world content script. Receives JSON bodies from hook.js, reads
// JSON-LD / __NEXT_DATA__ from the DOM, runs the generic extractor, and hands
// usable rows to the background worker. Never makes a request of its own.
(() => {
  const {
    extractFromJson, extractFromJsonLd, usable, companyFromHost, companyFromUrl, cleanSiteName,
    KNOWN_TEMPLATES, isPlaceholder, rowId, fillTemplate, learnTemplate, candidateTemplates,
  } = globalThis.JobExtract;

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
  async function flush() {
    const c = ctx();
    let rows = usable([
      ...pendingJson.flatMap((j) => extractFromJson(j, c)),
      ...extractFromJsonLd(pendingLd, c),
    ]).map((r) => ({ ...r, company_name: r.company_name || c.company }));
    pendingJson = [];
    pendingLd = [];
    if (!rows.length) return;
    try {
      rows = await repairLinks(rows);
    } catch {
      /* keep placeholders — a working Apply link to the search page beats none */
    }
    chrome.runtime.sendMessage({ type: 'jobs', pageUrl: location.href, rows });
  }

  // ─── Real links for id-only rows ────────────────────────────────────────
  //
  // Order: a pattern remembered for this site → one learned from links the
  // page rendered → a format confirmed from real data → common conventions,
  // each verified with one request for a real job and one for a made-up id.
  // A verified or learned pattern is remembered, so this costs requests once
  // per site, not once per day.
  async function repairLinks(rows) {
    const broken = rows.filter(isPlaceholder);
    if (!broken.length) return rows;
    const key = `linkTemplate:${location.hostname}`;
    const stored = (await chrome.storage.local.get(key))[key];

    let tpl = stored || learnTemplate(rows) || KNOWN_TEMPLATES[location.hostname] || null;
    if (!tpl) {
      for (const cand of candidateTemplates(location.href)) {
        // eslint-disable-next-line no-await-in-loop
        if (await verifyTemplate(cand, broken[0])) { tpl = cand; break; }
      }
    }
    if (!tpl) return rows;
    if (tpl !== stored) await chrome.storage.local.set({ [key]: tpl });
    return rows.map((r) => (isPlaceholder(r) ? { ...r, apply_url: fillTemplate(tpl, r) } : r));
  }

  async function probe(url) {
    try {
      const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
      const text = res.ok ? (await res.text()).slice(0, 400_000).toLowerCase() : '';
      return { ok: res.ok, finalUrl: res.url, text };
    } catch {
      return { ok: false, finalUrl: '', text: '' };
    }
  }

  // Accept a pattern only if the real job's page loads AND either names the
  // job, or a made-up id under the same pattern does NOT load the same way —
  // many sites answer every path with the same app shell, which would
  // otherwise "verify" any guess.
  async function verifyTemplate(tpl, row) {
    const real = await probe(fillTemplate(tpl, row));
    if (!real.ok) return false;
    if (real.text.includes(String(row.job_title).toLowerCase())) return true;
    const fake = await probe(fillTemplate(tpl, { ...row, external_id: `x:${rowId(row)}9090909` }));
    const sameShell = fake.ok && fake.finalUrl.replace(/\d+/g, '') === real.finalUrl.replace(/\d+/g, '') &&
      Math.abs(fake.text.length - real.text.length) < 200;
    return !sameShell && real.text.includes(rowId(row).toLowerCase());
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
