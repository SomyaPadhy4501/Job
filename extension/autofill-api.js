'use strict';

// Imported by the MV3 worker. Content scripts never receive the bearer token.
(() => {
  const CACHE = 'autofillProfile',
    TTL = 10 * 60_000;
  let revision = 0;
  const popup = chrome.runtime.getURL('popup.html');
  const previewPage = chrome.runtime.getURL('preview.html');
  function origin(url) {
    const u = new URL(url);
    if (
      u.username ||
      u.password ||
      !(
        u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
      )
    ) {
      throw new Error('Use an HTTPS portal URL or a loopback development server.');
    }
    return u.origin;
  }

  // Per-company sign-in attempts (session storage: content scripts can't read it).
  const LEDGER = 'workdayLogins';
  // Workday's usual rules, plus length: one password opens many accounts.
  function sitePasswordProblem(p) {
    if (p.length < 12) return 'Use at least 12 characters.';
    if (p.length > 128) return 'Use at most 128 characters.';
    if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p) || !/[^A-Za-z0-9]/.test(p))
      return 'Use upper and lower case letters, a number and a symbol.';
    return '';
  }

  // Extension-origin IndexedDB is separate from the content script's origin:
  // no page or content script can read what's kept here.
  function credentials(update, key = 'account') {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('job-autofill', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('connection');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result,
          tx = db.transaction('connection', update ? 'readwrite' : 'readonly');
        const store = tx.objectStore('connection');
        const req = update ? store.put(update, key) : store.get(key);
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }
  async function handle(msg, sender) {
    if (sender.id !== chrome.runtime.id) throw new Error('Unsupported sender.');
    // The extension's own pages: the popup, and the resume preview tab.
    const isPopup = sender.url === popup || sender.url.startsWith(previewPage);
    const url = new URL(sender.url);
    // Pages may ask only from the four ATS hosts, or from a site you allowed
    // with "Autofill this page" in the popup (an optional host permission).
    if (!isPopup) {
      const allowed =
        url.protocol === 'https:' &&
        sender.tab &&
        (JobApplicationPages.ats(url.hostname) ||
          (await chrome.permissions?.contains?.({ origins: [url.origin + '/*'] })));
      if (!allowed) throw new Error('Unsupported site.');
    }
    const { portalUrl } = await chrome.storage.local.get({ portalUrl: 'https://job-two-xi.vercel.app' });
    if (msg.type === 'autofill:configure') {
      if (!isPopup) throw new Error('Use the extension popup.');
      await credentials({
        origin: msg.token ? origin(portalUrl) : '',
        token: String(msg.token || '').trim(),
        binding: crypto.randomUUID(),
      });
      revision++;
      await chrome.storage.session.remove(CACHE);
      return {};
    }
    // "Preview" beside a resume in the panel: opens the file in a new tab,
    // next to the application. The tab fetches it itself (preview.js).
    if (msg.type === 'autofill:previewResume') {
      if (typeof msg.id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(msg.id)) throw new Error('Invalid resume.');
      await chrome.tabs.create({
        url: previewPage + '#' + encodeURIComponent(msg.id),
        ...(sender.tab ? { index: sender.tab.index + 1, openerTabId: sender.tab.id } : {}),
      });
      return {};
    }
    // ─── The job site password (one, chosen by the user) ─────────────────
    // Kept only here, in this worker's IndexedDB. Set from the popup; given
    // only to the top frame of a Workday page, never to other sites.
    if (msg.type === 'autofill:sitePasswordStatus') {
      if (!isPopup) throw new Error('Use the extension popup.');
      const saved = await credentials(undefined, 'sitePassword');
      return { set: !!saved?.password, updatedAt: saved?.updatedAt || null };
    }
    if (msg.type === 'autofill:setSitePassword') {
      if (!isPopup) throw new Error('Use the extension popup.');
      const password = String(msg.password ?? '');
      if (password) {
        const problem = sitePasswordProblem(password);
        if (problem) throw new Error(problem);
      }
      await credentials(password ? { password, updatedAt: new Date().toISOString() } : { password: '' }, 'sitePassword');
      // A new password may work where the old one failed.
      await chrome.storage.session.remove(LEDGER);
      return {};
    }
    if (msg.type === 'autofill:sitePassword' || msg.type === 'autofill:loginResult') {
      const tenant = JobApplicationPages.workdayTenant(sender.url);
      if (
        isPopup ||
        JobApplicationPages.ats(url.hostname) !== 'workday' ||
        !tenant ||
        sender.frameId !== 0 ||
        (sender.documentLifecycle && sender.documentLifecycle !== 'active')
      )
        throw new Error('The job site password is only for Workday sign-in pages.');
      const ledger = (await chrome.storage.session.get(LEDGER))[LEDGER] || {};
      const entry = ledger[tenant] || { grants: [], failed: false };
      const now = Date.now();
      if (msg.type === 'autofill:loginResult') {
        entry.failed = msg.result === 'failed';
        ledger[tenant] = entry;
        await chrome.storage.session.set({ [LEDGER]: ledger });
        return {};
      }
      const saved = await credentials(undefined, 'sitePassword');
      if (!saved?.password) return { password: null };
      // At most 3 fills per company per 10 minutes; after a failed sign-in,
      // no automatic attempt until the password changes.
      entry.grants = entry.grants.filter((t) => now - t < 10 * 60_000);
      if (entry.grants.length >= 3) throw new Error('Too many sign-in attempts here. Sign in yourself.');
      entry.grants.push(now);
      ledger[tenant] = entry;
      await chrome.storage.session.set({ [LEDGER]: ledger });
      return { password: saved.password, autoSignIn: !entry.failed };
    }
    // ─── Gmail: codes and verify links (gmail.js) ───────────────────────
    // Gmail is connected on the portal (Alerts & Connectors); here only the
    // job page asking is checked, then the portal is asked for the code.
    let gmailAsk = null;
    if (msg.type === 'autofill:gmailStatus') {
      if (!isPopup) throw new Error('Use the extension popup.');
      gmailAsk = { kind: 'status' };
    }
    if (msg.type === 'autofill:findCode' || msg.type === 'autofill:openVerifyLink') {
      const site = JobApplicationPages.ats(url.hostname);
      if (isPopup || !['workday', 'greenhouse'].includes(site))
        throw new Error('Codes are read only for Workday and Greenhouse pages.');
      const tenant = JobApplicationPages.workdayTenant(sender.url);
      if (site === 'workday' && !tenant) throw new Error('Unknown Workday company.');
      if (msg.type === 'autofill:openVerifyLink') {
        if (site !== 'workday' || sender.frameId !== 0) throw new Error('Only Workday sign-in pages open verify links.');
        gmailAsk = { kind: 'link', tenant };
      } else {
        const length = Number.isInteger(msg.length) && msg.length >= 4 && msg.length <= 10 ? msg.length : 0;
        const charset = msg.charset === 'digits' ? 'digits' : 'alnum';
        gmailAsk = { kind: 'code', site, tenant, shape: { length, charset } };
      }
    }
    // Answers typed into an application, held between steps and "submit" and
    // the next page, so the save prompt survives a page change and a
    // multi-step form (Workday) offers every step's answers. Per tab, 30
    // minutes; offered only once the application was submitted.
    if (msg.type === 'autofill:holdAnswers' || msg.type === 'autofill:takeAnswers') {
      const key = 'pendingAnswers:' + sender.tab.id;
      const held = (await chrome.storage.session.get(key))[key];
      const fresh = held && Date.now() - held.at < 30 * 60_000 ? held : null;
      if (msg.type === 'autofill:takeAnswers') {
        if (!fresh?.submitted) return null;
        await chrome.storage.session.remove(key);
        return fresh;
      }
      // Nothing is held for a browser that isn't connected to an account.
      if (!(await credentials())?.token) return {};
      const merged = new Map((fresh?.answers || []).map((a) => [a.question, a]));
      for (const a of Array.isArray(msg.answers) ? msg.answers : []) {
        if (typeof a?.question !== 'string' || typeof a?.answer !== 'string') continue;
        const question = a.question.slice(0, 500);
        merged.delete(question);
        merged.set(question, { question, answer: a.answer.slice(0, 4000) });
      }
      const answers = [...merged.values()].slice(-50);
      if (answers.length)
        await chrome.storage.session.set({
          [key]: {
            answers,
            company: String(msg.company || fresh?.company || '').slice(0, 100),
            submitted: !!msg.submitted || !!fresh?.submitted,
            at: Date.now(),
          },
        });
      return {};
    }
    const auth = await credentials();
    if (!auth?.token || auth.origin !== origin(portalUrl))
      throw new Error('Connect the autofill token for this portal in the extension popup.');
    if (msg.binding && msg.binding !== auth.binding) throw new Error('Account changed. Reopen Autofill.');
    // `say`: show the portal's own error message (short, plain text), for
    // answers the user can act on ("Connect Gmail in Alerts & Connectors").
    async function request(path, init, optional = false, say = false) {
      const res = await fetch(auth.origin + '/api/autofill/' + path, {
        ...init,
        headers: { Authorization: 'Bearer ' + auth.token, ...(init?.headers || {}) },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(20000),
      });
      if (optional && res.status === 404) return null;
      if (res.status === 401) {
        await chrome.storage.session.remove(CACHE);
        throw new Error('Token rejected. Reconnect autofill in the extension popup with a new token from the portal Settings page.');
      }
      if (!res.ok) {
        const said = say ? await res.json().then((d) => d?.error, () => null) : null;
        if (typeof said === 'string' && said.length <= 200) throw new Error(said);
        throw new Error('Portal request failed (HTTP ' + res.status + ').');
      }
      return res;
    }
    if (gmailAsk?.kind === 'status') return AutofillGmail.status(request);
    if (gmailAsk?.kind === 'link') return { opened: await AutofillGmail.openVerifyLink(request, gmailAsk.tenant) };
    if (gmailAsk?.kind === 'code')
      return { code: await AutofillGmail.findCode(request, gmailAsk.site, gmailAsk.tenant, gmailAsk.shape) };
    if (msg.type === 'autofill:getProfile') {
      const version = revision;
      const cached = (await chrome.storage.session.get(CACHE))[CACHE];
      let data = cached?.binding === auth.binding && cached.until > Date.now() && cached.data;
      if (!data) {
        data = await (await request('profile')).json();
        if (
          !data.user?.email ||
          !Array.isArray(data.resumes) ||
          !Array.isArray(data.answers) ||
          !data.profile
        )
          throw new Error('Invalid profile response.');
        if (version !== revision || (await credentials())?.binding !== auth.binding)
          throw new Error('Connection changed. Reopen Autofill.');
        await chrome.storage.session.set({
          [CACHE]: { data, until: Date.now() + TTL, binding: auth.binding },
        });
      }
      return { ...data, binding: auth.binding };
    }
    // The apply queue, read only, for the popup. A job page can't ask: which
    // jobs you plan to apply to is nobody else's business. Older portals
    // without the route give no list.
    if (msg.type === 'autofill:applyQueue') {
      if (!isPopup) throw new Error('Unsupported sender.');
      const res = await request('queue', undefined, true);
      const data = res ? await res.json() : null;
      if (!data) return { items: null };
      const web = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
      const items = (Array.isArray(data.items) ? data.items : [])
        .filter((i) => typeof i?.id === 'string' && typeof i.title === 'string')
        .slice(0, 50)
        .map((i) => ({
          id: i.id,
          company: String(i.company || '').slice(0, 200),
          title: i.title.slice(0, 300),
          status: String(i.status || ''),
          applyUrl: web(i.applyUrl),
        }));
      return { items };
    }
    if (msg.binding !== auth.binding) throw new Error('Reopen Autofill to refresh your connection.');
    // Optional server-side ranking. A portal without the route answers 404 and
    // the content script ranks by tags itself.
    if (msg.type === 'autofill:rankResumes') {
      if (typeof msg.title !== 'string') throw new Error('Invalid job title.');
      const title = msg.title.replace(/\s+/g, ' ').trim().slice(0, 300);
      const res = await request('resumes?title=' + encodeURIComponent(title), undefined, true);
      if (!res) return { resumes: null };
      const data = await res.json();
      if (!Array.isArray(data?.resumes)) throw new Error('Invalid resume ranking response.');
      return { resumes: data.resumes.filter((r) => typeof r?.id === 'string') };
    }
    // The ATS's own question list for this page (labels, required flags).
    // The page asking is the page looked up; a portal without the route or a
    // page with no public schema gives no fields.
    if (msg.type === 'autofill:formSchema') {
      const res = await request('form-schema?url=' + encodeURIComponent(sender.url), undefined, true);
      const data = res ? await res.json() : null;
      const fields = (Array.isArray(data?.fields) ? data.fields : [])
        .filter((f) => typeof f?.name === 'string' && typeof f?.label === 'string')
        .slice(0, 200)
        .map((f) => ({ name: f.name, label: f.label.slice(0, 500), required: f.required === true }));
      return { fields };
    }
    if (msg.type === 'autofill:getResume') {
      if (typeof msg.id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(msg.id))
        throw new Error('Invalid resume.');
      const res = await request('resumes/' + encodeURIComponent(msg.id) + '/file');
      const bytes = new Uint8Array(await res.arrayBuffer());
      let raw = '';
      for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const disposition = res.headers.get('Content-Disposition') || '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const filename = encoded
        ? decodeURIComponent(encoded[1])
        : /filename="?([^";]+)/i.exec(disposition)?.[1];
      return { base64: btoa(raw), fileName: filename, mimeType: res.headers.get('Content-Type') };
    }
    if (msg.type === 'autofill:saveAnswers') {
      if (!Array.isArray(msg.answers) || !msg.answers.length) throw new Error('Choose answers to save.');
      const answers = msg.answers.map(({ question, answer, company }) => {
        if (typeof question !== 'string' || typeof answer !== 'string' || !question.trim() || !answer.trim())
          throw new Error('Invalid answer.');
        // An answer with a company is used for that company only.
        return typeof company === 'string' && company.trim()
          ? { question, answer, company: company.trim().slice(0, 100) }
          : { question, answer };
      });
      const result = await (
        await request('answers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answers }),
        })
      ).json();
      if (typeof result?.saved !== 'number') throw new Error('Invalid save response.');
      revision++;
      await chrome.storage.session.remove(CACHE);
      return { saved: result.saved };
    }
    throw new Error('Unknown autofill request.');
  }
  // "Share job listings I browse": rows the capture script found on a careers
  // page, sent with the user's own token. The portal checks and forwards them;
  // the owner's collect token never reaches this browser.
  // True when the account is connected to this job board: listings and the
  // Workday collection go through it (the server holds the collect token).
  globalThis.AutofillShareReady = async () => {
    const { portalUrl } = await chrome.storage.local.get({ portalUrl: 'https://job-two-xi.vercel.app' });
    const auth = await credentials().catch(() => null);
    return !!auth?.token && auth.origin === origin(portalUrl);
  };

  globalThis.AutofillShare = async (pageUrl, rows) => {
    const { portalUrl } = await chrome.storage.local.get({ portalUrl: 'https://job-two-xi.vercel.app' });
    const auth = await credentials();
    if (!auth?.token || auth.origin !== origin(portalUrl))
      throw new Error('Connect the autofill token in the popup to share listings.');
    const total = { inserted: 0, updated: 0, rejected: 0, refused: 0 };
    // At most 200 rows and about 200 KB a request: the API takes 256 KB, and
    // Workday rows carry full descriptions.
    const chunks = [];
    let cur = [], bytes = 0;
    for (const row of rows) {
      const n = new TextEncoder().encode(JSON.stringify(row)).length;
      if (cur.length && (cur.length >= 200 || bytes + n > 200_000)) {
        chunks.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(row);
      bytes += n;
    }
    if (cur.length) chunks.push(cur);
    for (const jobs of chunks) {
      const res = await fetch(auth.origin + '/api/capture/jobs', {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageUrl, jobs }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Sharing failed (' + res.status + ').');
      for (const k of Object.keys(total)) total[k] += Number(body[k]) || 0;
    }
    return total;
  };

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (typeof msg?.type !== 'string' || !msg.type.startsWith('autofill:')) return;
    handle(msg, sender).then(
      (data) => reply({ ok: true, data }),
      (e) => reply({ ok: false, error: e.message })
    );
    return true;
  });
})();
