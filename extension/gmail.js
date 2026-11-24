'use strict';

// Gmail, for the codes and links job sites email mid-application (Greenhouse
// "security code", Workday "verify your account"). Imported by the worker.
//
// - Read-only Gmail access (gmail.readonly), connected from the popup with
//   Google's own consent screen. The access token stays in session storage
//   (content scripts can't read it) and is never sent anywhere but Google.
// - Searches only mail from the job site itself (myworkday.com, Greenhouse),
//   received in the last 15 minutes, for the company whose page is asking.
// - Gives the page only a code of the shape it asked for; verify links are
//   opened by the worker itself and never handed to the page.
(() => {
  const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  const TOKEN = 'gmailToken';
  const USED = 'gmailUsed';
  const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const RECONNECT = 'Reconnect Gmail in the extension popup to fill codes.';
  let flow = null;

  const clientId = () => self.JOB_CONFIG?.gmailClientId || '';

  async function authorize(interactive, hint) {
    if (!clientId()) throw new Error('Gmail isn’t set up in this copy of the extension yet.');
    if (flow) return flow;
    flow = (async () => {
      const state = crypto.randomUUID();
      const params = new URLSearchParams({
        client_id: clientId(),
        response_type: 'token',
        redirect_uri: chrome.identity.getRedirectURL(),
        scope: SCOPE,
        state,
        include_granted_scopes: 'false',
      });
      if (hint) params.set('login_hint', hint);
      if (!interactive) params.set('prompt', 'none');
      const redirect = await chrome.identity.launchWebAuthFlow({
        url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params,
        interactive,
        ...(interactive ? {} : { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000 }),
      });
      const back = new URLSearchParams(new URL(redirect).hash.slice(1));
      if (back.get('state') !== state) throw new Error('Gmail sign-in was interrupted. Try again.');
      if (back.get('error')) throw new Error(back.get('error') === 'access_denied' ? 'Gmail access wasn’t allowed.' : 'Reconnect Gmail in the extension popup.');
      if (!(back.get('scope') || '').split(' ').includes(SCOPE)) throw new Error('Gmail read access wasn’t granted. Connect again and allow it.');
      const token = back.get('access_token');
      const expires = Number(back.get('expires_in')) || 3600;
      const profile = await (await fetch(API + '/profile', { headers: { Authorization: 'Bearer ' + token } })).json();
      const saved = { token, until: Date.now() + (expires - 60) * 1000, email: profile.emailAddress || hint || '' };
      await chrome.storage.session.set({ [TOKEN]: saved });
      await chrome.storage.local.set({ gmailEmail: saved.email });
      return saved;
    })();
    try {
      return await flow;
    } finally {
      flow = null;
    }
  }

  async function token() {
    if (!clientId()) throw new Error('Gmail isn’t set up in this copy of the extension yet.');
    const saved = (await chrome.storage.session.get(TOKEN))[TOKEN];
    if (saved?.token && saved.until > Date.now()) return saved.token;
    const { gmailEmail } = await chrome.storage.local.get('gmailEmail');
    if (!gmailEmail) throw new Error('Connect Gmail in the extension popup to read codes automatically.');
    // Silent sign-in failed (signed out, access removed): only the popup can fix
    // that, so the page stops looking and says so.
    try {
      return (await authorize(false, gmailEmail)).token;
    } catch {
      throw new Error(RECONNECT);
    }
  }

  async function gmail(path) {
    let t = await token();
    let res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + t } });
    if (res.status === 401) {
      await chrome.storage.session.remove(TOKEN);
      t = await token();
      res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + t } });
    }
    if (!res.ok) throw new Error('Gmail answered ' + res.status + '.');
    return res.json();
  }

  const b64 = (s) => {
    const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  };
  // Plain text of a message (HTML reduced to text; hrefs kept separately).
  function body(payload) {
    const texts = [],
      hrefs = [];
    (function walk(part) {
      if (!part) return;
      const type = (part.mimeType || '').toLowerCase();
      if (part.body?.data && (type === 'text/plain' || type === 'text/html')) {
        const raw = b64(part.body.data);
        if (type === 'text/html') {
          for (const m of raw.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) hrefs.push(m[1].replace(/&amp;/g, '&'));
          texts.push(raw.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));
        } else texts.push(raw);
      }
      (part.parts || []).forEach(walk);
    })(payload);
    const text = texts.join('\n').replace(/[ \t]+/g, ' ');
    for (const m of text.matchAll(/https:\/\/[^\s<>"')]+/g)) hrefs.push(m[0]);
    return { text, hrefs };
  }
  const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || '';

  // The job site's own mail, newest first, from the last 15 minutes.
  async function recent(site, tenant) {
    const from = site === 'workday' ? 'from:myworkday.com' : 'from:(greenhouse.io OR greenhouse-mail.io)';
    const list = await gmail('/messages?maxResults=5&q=' + encodeURIComponent(from + ' newer_than:1d'));
    const used = (await chrome.storage.session.get(USED))[USED] || [];
    const out = [];
    for (const { id } of list.messages || []) {
      if (used.includes(id)) continue;
      const msg = await gmail('/messages/' + id + '?format=full');
      if (Number(msg.internalDate) < Date.now() - 15 * 60_000) continue;
      // Workday mail comes from <tenant>@myworkday.com: only this company's.
      if (site === 'workday') {
        const local = /<?([^<@\s]+)@myworkday\.com>?/i.exec(header(msg, 'from'))?.[1]?.toLowerCase();
        if (!local || local !== tenant) continue;
      }
      out.push({ id, ...body(msg.payload) });
    }
    return out;
  }
  async function markUsed(id) {
    const used = (await chrome.storage.session.get(USED))[USED] || [];
    await chrome.storage.session.set({ [USED]: [...used.slice(-50), id] });
  }

  // A code of the shape the page asked for, next to a word like "code".
  function pickCode(text, { length, charset }) {
    const unit = charset === 'digits' ? '\\d' : '[A-Za-z0-9]';
    const size = length ? `{${length}}` : '{4,10}';
    const token = new RegExp(`^${unit}${size}$`);
    // The first code-shaped word (with a digit in it) within 80 characters
    // after "code", "passcode", "PIN" or "one-time".
    for (const m of text.matchAll(/\b(?:code|passcode|pin|one[- ]time)\b/gi)) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const found = after.split(/[^A-Za-z0-9]+/).find((w) => token.test(w) && /\d/.test(w));
      if (found) return found;
    }
    // A line holding nothing but the code.
    const alone = new RegExp(`^\\s*(${unit}${size})\\s*$`, 'm').exec(text);
    return alone && /\d/.test(alone[1]) ? alone[1] : null;
  }

  async function findCode(site, tenant, shape) {
    for (const m of await recent(site, tenant)) {
      const code = pickCode(m.text, shape);
      if (code) {
        await markUsed(m.id);
        return code;
      }
    }
    return null;
  }

  // Opens this company's Workday verification link in a background tab and
  // closes it shortly after it loads. The page never sees the link.
  async function openVerifyLink(tenant) {
    for (const m of await recent('workday', tenant)) {
      const link = m.hrefs.find((h) => {
        try {
          const u = new URL(h);
          return u.protocol === 'https:' && JobApplicationPages.workdayTenant(h) === tenant && /verif|activat|confirm/i.test(u.pathname + u.search);
        } catch {
          return false;
        }
      });
      if (!link) continue;
      await markUsed(m.id);
      const tab = await chrome.tabs.create({ url: link, active: false });
      const close = () => chrome.tabs.remove(tab.id).catch(() => {});
      const listener = (id, info) => {
        if (id !== tab.id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(close, 10000);
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(close, 60000);
      return true;
    }
    return false;
  }

  async function disconnect() {
    const saved = (await chrome.storage.session.get(TOKEN))[TOKEN];
    if (saved?.token)
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=' + encodeURIComponent(saved.token),
      }).catch(() => {});
    await chrome.storage.session.remove([TOKEN, USED]);
    await chrome.storage.local.remove('gmailEmail');
  }

  async function status() {
    const { gmailEmail } = await chrome.storage.local.get('gmailEmail');
    return { available: !!clientId(), email: gmailEmail || null };
  }

  self.AutofillGmail = { authorize, disconnect, status, findCode, openVerifyLink, pickCode };
})();
