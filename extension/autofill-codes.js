'use strict';

// Fills the codes job sites email mid-application, from Gmail (gmail.js in
// the worker). Workday and Greenhouse pages only.
// - A code box appears (Greenhouse's security code boxes, a "verification
//   code" field, autocomplete="one-time-code"): look in Gmail every 5 s for up
//   to 3 minutes, then fill the code. Never presses submit.
// - Workday asks to verify the email after Create Account: the worker opens
//   this company's verify link from Gmail in a background tab.
// Nothing happens until Gmail is connected in the extension popup.
(() => {
  if (globalThis.__jobCodes) return;
  globalThis.__jobCodes = true;
  const workday = /(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(location.hostname);
  const visible = (el) => !!el && el.isConnected && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const CODE = /verification code|security code|one[- ]time (?:pass)?code|passcode|confirmation code|enter (?:the )?code/i;
  const VERIFY = /verify (?:your )?(?:email|account|e-mail)|verification (?:email|link)|check your (?:email|inbox)/i;
  let polling = false;
  let stopped = false;
  let note = null;

  async function ask(type, params = {}) {
    const r = await chrome.runtime.sendMessage({ type: 'autofill:' + type, ...params });
    if (!r?.ok) throw new Error(r?.error || 'The extension could not answer.');
    return r.data;
  }

  function set(el, value) {
    let proto = Object.getPrototypeOf(el);
    while (proto) {
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d?.set) {
        d.set.call(el, value);
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    for (const type of ['input', 'change']) el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function say(text, cancel) {
    if (!note) {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial;position:fixed;left:20px;bottom:20px;z-index:2147483647}' +
        'div{font:13px/1.45 Inter,system-ui,sans-serif;color:#18191c;background:#fff;border:1px solid #d5d9df;border-radius:12px;' +
        'padding:10px 12px;max-width:320px;box-shadow:0 12px 32px rgba(15,23,42,.14)}' +
        'button{font:600 12.5px Inter,system-ui,sans-serif;margin-left:8px;padding:4px 10px;border-radius:8px;border:1px solid #aeb5be;background:#fff;cursor:pointer}';
      const box = document.createElement('div');
      box.setAttribute('role', 'status');
      root.append(style, box);
      document.body.append(host);
      note = { host, box };
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

  // Greenhouse: one box per character. Elsewhere: one input.
  function codeBoxes() {
    const split = [...document.querySelectorAll('input[id^="security-input-"]')].filter(visible);
    if (split.length >= 4) return split;
    const one = [...document.querySelectorAll('input')].find((el) => {
      if (!visible(el) || el.value || !/^(?:text|tel|number|)$/i.test(el.getAttribute('type') || '')) return false;
      const label = [el.getAttribute('aria-label'), el.labels?.[0]?.textContent, el.placeholder, el.closest('label')?.textContent].join(' ');
      return el.autocomplete === 'one-time-code' || CODE.test(label);
    });
    return one ? [one] : [];
  }

  async function poll(work, until, waiting) {
    polling = true;
    stopped = false;
    const started = Date.now();
    try {
      say(waiting, true);
      while (!stopped && Date.now() - started < 180_000) {
        let result;
        try {
          result = await work();
        } catch (err) {
          // Gmail not connected (or not set up): say so once, then stay quiet.
          say(err.message, false);
          stopped = true;
          return;
        }
        if (result) return until(result);
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!stopped) say('No email from this site arrived in Gmail yet. Check your inbox yourself.', false);
    } finally {
      polling = false;
    }
  }

  function look() {
    if (polling || stopped) return;
    const boxes = codeBoxes();
    if (boxes.length && boxes.every((b) => !b.value)) {
      const one = boxes[0];
      const length = boxes.length > 1 ? boxes.length : Number(one.getAttribute('maxlength')) || 0;
      const digits = boxes.length === 1 && (one.inputMode === 'numeric' || one.type === 'number');
      poll(
        async () => (await ask('findCode', { length: length >= 4 && length <= 10 ? length : undefined, charset: digits ? 'digits' : 'alnum' })).code,
        (code) => {
          if (boxes.length > 1) [...code].forEach((c, i) => boxes[i] && set(boxes[i], c));
          else set(one, code);
          say('Code filled in from your Gmail. Check it, then continue yourself.', false);
        },
        'Looking for the code in your Gmail…'
      );
      return;
    }
    if (workday && window === window.top) {
      const panel = document.querySelector('[data-automation-id="signInContent"]');
      if (visible(panel) && VERIFY.test(panel.textContent || '')) {
        poll(
          async () => (await ask('openVerifyLink')).opened,
          () => say('Opened the verification link from your Gmail. When it says verified, sign in here.', false),
          'Looking for the verification email in your Gmail…'
        );
      }
    }
  }

  let pending = 0;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(look, 500);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(look, 800);
})();
