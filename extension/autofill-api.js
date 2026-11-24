'use strict';

// Imported by the MV3 worker. Content scripts never receive the bearer token.
(() => {
  const CACHE = 'autofillProfile',
    TTL = 10 * 60_000;
  let revision = 0;
  const popup = chrome.runtime.getURL('popup.html');
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

  // Extension-origin IndexedDB is separate from the content script's origin.
  function credentials(update) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('job-autofill', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('connection');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result,
          tx = db.transaction('connection', update ? 'readwrite' : 'readonly');
        const store = tx.objectStore('connection');
        const req = update ? store.put(update, 'account') : store.get('account');
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
    const isPopup = sender.url === popup;
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
    const auth = await credentials();
    if (!auth?.token || auth.origin !== origin(portalUrl))
      throw new Error('Connect the autofill token for this portal in the extension popup.');
    if (msg.binding && msg.binding !== auth.binding) throw new Error('Account changed. Reopen Autofill.');
    async function request(path, init, optional = false) {
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
      if (!res.ok) throw new Error('Portal request failed (HTTP ' + res.status + ').');
      return res;
    }
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
      const answers = msg.answers.map(({ question, answer }) => {
        if (typeof question !== 'string' || typeof answer !== 'string' || !question.trim() || !answer.trim())
          throw new Error('Invalid answer.');
        return { question, answer };
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
  globalThis.AutofillShare = async (pageUrl, rows) => {
    const { portalUrl } = await chrome.storage.local.get({ portalUrl: 'https://job-two-xi.vercel.app' });
    const auth = await credentials();
    if (!auth?.token || auth.origin !== origin(portalUrl))
      throw new Error('Connect the autofill token in the popup to share listings.');
    const total = { inserted: 0, updated: 0, rejected: 0, refused: 0 };
    for (let i = 0; i < rows.length; i += 200) {
      const res = await fetch(auth.origin + '/api/capture/jobs', {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageUrl, jobs: rows.slice(i, i + 200) }),
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
