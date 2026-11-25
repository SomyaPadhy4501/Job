'use strict';

// Fills the codes job sites email mid-application or at sign-up, from Gmail
// (gmail.js in the worker), on any job site.
// - A code box appears (Greenhouse's security code boxes, one box per digit
//   anywhere, a "verification code" field, autocomplete="one-time-code"):
//   look in Gmail at once, then every 1.5 s for 45 s and every 4 s after
//   that, for up to 3 minutes; fill the code. Never presses submit.
// - A site asks you to verify your email (Workday after Create Account, and
//   other job sites that send a link): the worker opens that site's own
//   verify link from Gmail in a background tab.
// Only on job pages: a known application system, or a page whose address or
// title is about jobs. The worker takes mail only from this page's own system
// or the employer's own domain, so another site's code never lands here.
// Nothing happens until Gmail is connected on the job board (Alerts & Connectors).
(() => {
  if (globalThis.__jobCodes) return;
  globalThis.__jobCodes = true;
  const P = globalThis.JobApplicationPages;
  const host = location.hostname;
  const workday = /(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(host);
  const greenhouse = /(?:^|\.)greenhouse\.io$/.test(host);
  const visible = (el) => !!el && el.isConnected && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const CODE =
    /verification code|security code|one[- ]time (?:pass)?(?:code|word)|\botp\b|passcode|confirmation code|access code|verify code|\d[- ]digit code|enter (?:the |your )?code|\bcode\b.*\b(?:sent|emailed)\b|\bpin\b/i;
  const NOT_CODE =
    /zip|postal|post code|phone|country code|area code|promo|coupon|gift|discount|referral|referrer|job code|requisition|req(?:uisition)? ?(?:id|code)|employee|source code|tax|ssn|routing|swift|iban|sort code|currency|language/i;
  const PAGE_CODE =
    /(?:enter|type|input) (?:the |your )?(?:\d[- ]digit )?(?:verification |security |one[- ]time |confirmation )?(?:code|passcode)|we(?:'ve| have)? (?:just )?(?:sent|emailed) (?:you )?(?:a|an|the) (?:\d[- ]digit )?(?:verification |security |one[- ]time )?code|code (?:was|has been) sent/i;
  const VERIFY = /verify (?:your )?(?:email|account|e-mail)|verification (?:email|link)|check your (?:email|inbox)/i;
  // Elsewhere only wording about verifying an account, never a plain
  // "check your email for updates" on a confirmation page.
  const VERIFY_ACCOUNT =
    /verify (?:your )?(?:email|e-mail|account)(?: address)?|verification (?:email|link)|(?:activate|confirm) your (?:account|email|e-mail)/i;
  const JOBS = /career|\bjobs?\b|apply|application|candidate|talent|recruit|hiring|requisition|vacanc|opportunit/i;
  let polling = false;
  let stopped = false;
  let note = null;
  let linkTried = false;

  // A job page: Workday or Greenhouse, another known application system,
  // or a site whose address or title is about jobs.
  function jobPage() {
    if (workday || greenhouse || P?.applySystem?.(host)) return true;
    return JOBS.test(location.hostname + ' ' + location.pathname + ' ' + document.title);
  }

  // The company the page is for, so a system that mails for many employers
  // only gives this company's code: Greenhouse titles its forms "Job
  // Application for <role> at <Company>"; others name it in og:site_name.
  function company() {
    const title = (document.title || '').replace(/\s+/g, ' ').trim();
    const at = / at ([^|–—-]{2,100})$/.exec(title);
    const meta = document.querySelector('meta[property="og:site_name"]')?.content;
    return (at ? at[1] : meta || '').trim().slice(0, 100);
  }

  async function ask(type, params = {}) {
    const r = await chrome.runtime.sendMessage({ type: 'autofill:' + type, ...params });
    if (!r?.ok) throw new Error(r?.error || 'The extension could not answer.');
    return r.data;
  }

  function set(el, value) {
    el.focus();
    let proto = Object.getPrototypeOf(el);
    while (proto) {
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d?.set) {
        d.set.call(el, value);
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    const win = el.ownerDocument.defaultView;
    const Input = typeof win.InputEvent === 'function' ? win.InputEvent : win.Event;
    el.dispatchEvent(new Input('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    el.dispatchEvent(new win.KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) }));
  }

  function say(text, cancel) {
    if (!note) {
      const box = document.createElement('div');
      const root = box.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial;position:fixed;left:20px;bottom:20px;z-index:2147483647}' +
        'div{font:13px/1.45 Inter,system-ui,sans-serif;color:#18191c;background:#fff;border:1px solid #d5d9df;border-radius:12px;' +
        'padding:10px 12px;max-width:320px;box-shadow:0 12px 32px rgba(15,23,42,.14)}' +
        'button{font:600 12.5px Inter,system-ui,sans-serif;margin-left:8px;padding:4px 10px;border-radius:8px;border:1px solid #aeb5be;background:#fff;cursor:pointer}';
      const inner = document.createElement('div');
      inner.setAttribute('role', 'status');
      root.append(style, inner);
      document.body.append(box);
      note = { host: box, box: inner };
    }
    const span = document.createElement('span');
    span.textContent = text;
    const b = document.createElement('button');
    b.textContent = cancel ? 'Cancel' : 'Close';
    b.onclick = (e) => {
      if (!e.isTrusted) return;
      if (cancel) stopped = true;
      note?.host.remove();
      note = null;
    };
    note.box.replaceChildren(span, b);
  }

  const textLike = (el) => /^(?:text|tel|number|password|)$/i.test(el.getAttribute('type') || '');
  const describe = (el) =>
    [
      el.getAttribute('aria-label'),
      el.labels?.[0]?.textContent,
      el.placeholder,
      el.closest('label')?.textContent,
      el.name,
      el.id,
      el.getAttribute('data-automation-id'),
    ].join(' ');

  // One box per character: Greenhouse's security boxes, or 4–8 one-character
  // inputs side by side anywhere.
  function splitBoxes() {
    const greenhouseBoxes = [...document.querySelectorAll('input[id^="security-input-"]')].filter(visible);
    if (greenhouseBoxes.length >= 4) return greenhouseBoxes;
    const singles = [...document.querySelectorAll('input[maxlength="1"]')].filter(
      (el) => visible(el) && textLike(el) && el.type !== 'password'
    );
    const groups = new Map();
    for (const el of singles) {
      // The nearest ancestor holding at least four of them is the group.
      let p = el.parentElement;
      for (let depth = 0; p && depth < 4; depth++, p = p.parentElement) {
        if (p.querySelectorAll('input[maxlength="1"]').length >= 4) break;
      }
      if (!p) continue;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(el);
    }
    for (const list of groups.values()) if (list.length >= 4 && list.length <= 8) return list;
    return [];
  }

  // One input for the whole code.
  function singleBox() {
    const inputs = [...document.querySelectorAll('input')].filter(
      (el) => visible(el) && !el.disabled && !el.readOnly && textLike(el) && el.type !== 'password'
    );
    const named = inputs.find((el) => {
      if (el.autocomplete === 'one-time-code') return true;
      const words = describe(el);
      return CODE.test(words) && !NOT_CODE.test(words);
    });
    if (named) return named;
    // "Enter the 6-digit code we sent you" above a single short input.
    if (!PAGE_CODE.test(document.body?.innerText?.slice(0, 20000) || '')) return null;
    const short = inputs.filter((el) => {
      const max = Number(el.getAttribute('maxlength')) || 0;
      return (max >= 4 && max <= 10) || el.inputMode === 'numeric';
    });
    return short.length === 1 && !NOT_CODE.test(describe(short[0])) ? short[0] : null;
  }

  function codeBoxes() {
    const split = splitBoxes();
    if (split.length) return split;
    const one = singleBox();
    return one ? [one] : [];
  }

  // Polls quickly at first (the email usually lands within seconds), then
  // more slowly, for up to 3 minutes.
  async function poll(work, until, waiting) {
    polling = true;
    stopped = false;
    const started = Date.now();
    try {
      say(waiting, true);
      while (!stopped && Date.now() - started < 180_000) {
        let result;
        try {
          result = await work(Date.now() - started);
        } catch (err) {
          // Gmail not connected (or not set up): say so once, then stay quiet.
          say(err.message, false);
          stopped = true;
          return;
        }
        if (stopped) return;
        if (result) return until(result);
        await new Promise((r) => setTimeout(r, Date.now() - started < 45_000 ? 1500 : 4000));
      }
      if (!stopped) say('No email from this site arrived in Gmail yet. Check your inbox yourself.', false);
    } finally {
      polling = false;
    }
  }

  function fill(boxes, code) {
    if (boxes.length > 1) {
      // Many one-digit widgets take a paste into the first box.
      const first = boxes[0];
      try {
        const data = new DataTransfer();
        data.setData('text/plain', code);
        first.focus();
        first.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      } catch {}
      if (!boxes.every((b, i) => b.value === code[i])) [...code].forEach((c, i) => boxes[i] && set(boxes[i], c));
    } else set(boxes[0], code);
  }

  function look() {
    if (polling || stopped || !jobPage()) return;
    const boxes = codeBoxes();
    if (boxes.length && boxes.every((b) => !b.value)) {
      const one = boxes[0];
      const length = boxes.length > 1 ? boxes.length : Number(one.getAttribute('maxlength')) || 0;
      const digits =
        boxes.length === 1
          ? one.inputMode === 'numeric' || one.type === 'number' || /^\[?\\?d|\[0-9\]/.test(one.getAttribute('pattern') || '')
          : boxes.every((b) => b.inputMode === 'numeric' || b.type === 'number' || b.type === 'tel');
      poll(
        async () =>
          (
            await ask('findCode', {
              length: length >= 4 && length <= 10 ? length : undefined,
              charset: digits ? 'digits' : 'alnum',
              company: company(),
            })
          ).code,
        (code) => {
          if (!boxes.every((b) => b.isConnected && !b.value)) return say('Code found in your Gmail, but the boxes changed. Enter it yourself.', false);
          fill(boxes, code);
          say('Code filled in from your Gmail. Check it, then continue yourself.', false);
        },
        'Looking for the code in your Gmail…'
      );
      return;
    }
    if (window !== window.top || linkTried) return;
    // Workday's own sign-in panel says "verify your account"; elsewhere the
    // page itself does, after a sign-up, with no form left to fill.
    const panel = workday ? document.querySelector('[data-automation-id="signInContent"]') : document.body;
    const text = (panel?.innerText || '').slice(0, 20000);
    if (!visible(panel) || greenhouse || !(workday ? VERIFY : VERIFY_ACCOUNT).test(text)) return;
    if (!workday && document.querySelector('input[type="password"]')) return;
    linkTried = true;
    poll(
      async () => (await ask('openVerifyLink', { company: company() })).opened,
      () =>
        say(
          workday
            ? 'Opened the verification link from your Gmail. When it says verified, sign in here.'
            : 'Opened the verification link from your Gmail in a background tab. Once it says verified, continue here.',
          false
        ),
      'Looking for the verification email in your Gmail…'
    );
  }

  let pending = 0;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(look, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(look, 600);
})();
