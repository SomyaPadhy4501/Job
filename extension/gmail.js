'use strict';

// Gmail, for the codes and links job sites email mid-application (Greenhouse
// "security code", Workday "verify your account"). Imported by the worker.
//
// - Gmail is connected on the job board (Alerts & Connectors), with
//   Google's authorization-code flow, PKCE and OpenID Connect. The Gmail
//   grant stays on the server; this extension never holds a Google token.
// - The worker asks the portal (with the autofill token) for one code or one
//   Workday verify link. The portal reads only mail from that job site,
//   received in the last 15 minutes, for the company whose page is asking.
// - The page gets only a code of the shape it asked for; verify links are
//   opened by the worker itself and never handed to the page.
(() => {
  const USED = 'gmailUsed';
  const VERIFY = /verif|activat|confirm/i;
  // A link that changes your mail settings or application is never opened.
  const NOT_VERIFY = /unsubscri|opt-?out|preference|withdraw|decline|delete|remove|cancel/i;

  // Left over from 1.19 and earlier, when the extension held a Gmail token.
  chrome.storage.session.remove('gmailToken').catch(() => {});
  chrome.storage.local.remove('gmailEmail').catch(() => {});

  async function used() {
    const ids = (await chrome.storage.session.get(USED))[USED];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string').slice(-50) : [];
  }
  async function markUsed(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(id)) return;
    await chrome.storage.session.set({ [USED]: [...(await used()).slice(-49), id] });
  }

  async function ask(request, path, body) {
    const res = await request(
      'gmail/' + path,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      false,
      true
    );
    return res.json();
  }

  // `request` is autofill-api.js's authenticated call to the portal.
  // `tenant`: the Workday tenant or Greenhouse board; `company`: the name on
  // the page (Greenhouse), so the portal only takes that company's mail.
  // `domains` (site 'other'): where this page's mail may come from, its
  // application system's mail domains or the employer's own domain.
  async function findCode(request, site, tenant, { length, charset }, company = '', domains = []) {
    const r = await ask(request, 'code', {
      site,
      ...(tenant ? { tenant } : {}),
      ...(company ? { company } : {}),
      ...(domains.length ? { domains } : {}),
      ...(length ? { length } : {}),
      charset,
      skip: await used(),
    });
    const code = r?.code;
    // Only the shape the page asked for, whatever the portal says.
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,10}$/.test(code)) return null;
    if ((length && code.length !== length) || (charset === 'digits' && !/^\d+$/.test(code))) return null;
    await markUsed(r.messageId);
    return code;
  }

  // Opens this company's Workday verification link in a background tab and
  // closes it shortly after it loads. The page never sees the link.
  // `other` (any site but Workday): { domains, hosts, company }: mail from
  // the page's own domains, a link only to the page's own hosts.
  async function openVerifyLink(request, tenant, other = null) {
    const r = await ask(
      request,
      'verify-link',
      other
        ? { site: 'other', domains: other.domains, hosts: other.hosts, ...(other.company ? { company: other.company } : {}), skip: await used() }
        : { tenant, skip: await used() }
    );
    let url;
    try {
      url = new URL(r?.link);
    } catch {
      return false;
    }
    // Checked again here: https, this company's own site, a verify path.
    const own = other
      ? JobApplicationPages.hostWithin(url.href, other.hosts)
      : JobApplicationPages.workdayTenant(url.href) === tenant;
    if (url.protocol !== 'https:' || url.username || url.password || !own || !VERIFY.test(url.pathname + url.search) || NOT_VERIFY.test(url.pathname + url.search))
      return false;
    await markUsed(r.messageId);
    const tab = await chrome.tabs.create({ url: url.href, active: false });
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

  self.AutofillGmail = { findCode, openVerifyLink };
})();
