// Isolated-world content script. Receives JSON bodies from hook.js, reads
// JSON-LD / __NEXT_DATA__ from the DOM, runs the generic extractor, and hands
// usable rows to the background worker. Never makes a request of its own.
(async () => {
  // Same gate as hook.js, plus any host on the user's own board list.
  const JOB_HOST = /^(?:careers?|jobs?|apply|talent|explore|work|join|hiring|opportunities)\.|(?:^|\.)(?:myworkdayjobs|ashbyhq|greenhouse|lever|smartrecruiters|workable|recruitee|pinpointhq|bamboohr|icims|avature|eightfold|oraclecloud|taleo|successfactors|jobvite|phenompeople|rippling|gem|linkedin|indeed|glassdoor)\.(?:com|io|co|net|ai)$/i;
  const JOB_PATH = /career|jobs?\b|\/job\/|search-results|positions|openings|vacanc|requisition/i;
  const looksLikeJobPage = JOB_HOST.test(location.hostname) || JOB_PATH.test(location.pathname);
  if (!looksLikeJobPage) {
    const { boards = [] } = await chrome.storage.local.get('boards');
    const onBoardList = boards.some((u) => { try { return new URL(u).hostname === location.hostname; } catch { return false; } });
    if (!onBoardList) return;
  }

  const {
    extractFromJson, extractFromJsonLd, usable, companyFromHost, companyFromUrl, cleanSiteName,
    KNOWN_TEMPLATES, isPlaceholder, rowId, fillTemplate, learnTemplate, candidateTemplates,
    KNOWN_DETAIL, descriptionFromJson, descriptionFromHtml, worthDetail, isSensitiveHost,
  } = globalThis.JobExtract;
  const SENSITIVE = isSensitiveHost(location.hostname);

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
    if (SENSITIVE) {
      // LinkedIn / Indeed / Glassdoor: only with the user's opt-in, and only
      // what this page already loaded — no probes, no detail requests.
      const { allowSensitive } = await chrome.storage.local.get({ allowSensitive: false });
      if (!allowSensitive) return;
      const tpl = KNOWN_TEMPLATES[location.hostname];
      if (tpl) rows = rows.map((r) => (isPlaceholder(r) ? { ...r, apply_url: fillTemplate(tpl, r) } : r));
      chrome.runtime.sendMessage({ type: 'jobs', pageUrl: location.href, rows });
      return;
    }
    try {
      rows = await repairLinks(rows);
    } catch {
      /* keep placeholders — a working Apply link to the search page beats none */
    }
    try {
      rows = await addDescriptions(rows);
    } catch {
      /* rows still go out; they just lack experience / restriction text */
    }
    chrome.runtime.sendMessage({ type: 'jobs', pageUrl: location.href, rows });
  }

  // ─── Descriptions for list-only boards ──────────────────────────────────
  //
  // Tesla's list (and others) carries no description, so the server can't
  // read "3+ years required", ITAR clauses or sponsorship lines. For rows that
  // will plausibly be kept, fetch the job's own page once and cache the text
  // in extension storage — every later run re-sends it, so an upsert never
  // overwrites a known description with an empty one.
  //
  // Bounded on purpose: ≤ 25 new jobs per board per run, ~1.2 s apart, from
  // the user's own tab, and never the same job twice.
  const DETAIL_PER_RUN = 25;
  const DETAIL_GAP_MS = 1200;
  const DESC_CACHE_MAX = 1500;
  // Every request is bounded, and so is the whole pass: a detail page that
  // never answers (Apple's did) must not hold the batch back forever.
  const REQUEST_TIMEOUT_MS = 10_000;
  const DETAIL_BUDGET_MS = 45_000;
  const timedFetch = (url, opts = {}) =>
    fetch(url, { ...opts, credentials: 'include', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  async function addDescriptions(rows) {
    const key = `desc:${location.hostname}`;
    const cache = (await chrome.storage.local.get(key))[key] || {};
    let fetched = 0;
    const deadline = Date.now() + DETAIL_BUDGET_MS;
    for (const r of rows) {
      if (r.description) continue;
      if (cache[r.external_id] != null) { r.description = cache[r.external_id]; continue; }
      if (fetched >= DETAIL_PER_RUN || Date.now() > deadline || !worthDetail(r)) continue;
      // eslint-disable-next-line no-await-in-loop
      if (fetched) await new Promise((res) => setTimeout(res, DETAIL_GAP_MS));
      fetched++;
      // eslint-disable-next-line no-await-in-loop
      const text = await fetchDescription(r);
      cache[r.external_id] = text; // '' too, so a page without one isn't retried daily
      if (text) r.description = text;
    }
    const ids = Object.keys(cache);
    if (ids.length > DESC_CACHE_MAX) for (const id of ids.slice(0, ids.length - DESC_CACHE_MAX)) delete cache[id];
    if (fetched) await chrome.storage.local.set({ [key]: cache });
    return rows;
  }

  async function fetchDescription(row) {
    const urls = [];
    if (KNOWN_DETAIL[location.hostname]) urls.push(fillTemplate(KNOWN_DETAIL[location.hostname], row));
    if (!isPlaceholder(row)) urls.push(row.apply_url);
    for (const url of urls) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await timedFetch(url);
        if (!res.ok) continue;
        // eslint-disable-next-line no-await-in-loop
        const body = await res.text();
        if (body.trimStart().startsWith('{')) {
          const d = descriptionFromJson(JSON.parse(body));
          if (d) return d;
        } else {
          const d = descriptionFromHtml(body);
          if (d) return d;
        }
      } catch { /* try the next source */ }
    }
    return '';
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
      const res = await timedFetch(url, { redirect: 'follow' });
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
