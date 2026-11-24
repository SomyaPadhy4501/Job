'use strict';

// Workday's sign-in and create-account step, with the one job site password
// the user set in the extension popup. Runs only on Workday hosts, in the top
// frame (its own manifest entry; never injected on other sites).
//
// - "Sign in with email" is chosen when Workday asks how to sign in.
// - Sign-in form: fills the profile email and the password, and presses
//   Sign In once, only after the user has interacted with the page (never in
//   an unattended window). If that fails, it offers Create account or Forgot
//   password, and makes no more automatic attempts until the password changes.
// - Create-account form: fills email, password and verify password, ticks
//   Workday's own "I agree" box and presses Create Account once (the user
//   asked for this; same conditions as Sign In). With a CAPTCHA on the form,
//   or anything off, it stops and asks instead. Then the verify-email link is
//   opened from Gmail by autofill-codes.js.
// Clicks are limited to Workday's sign-in controls, found by automation id,
// inside the sign-in panel. No CAPTCHA is ever touched.
(() => {
  if (window !== window.top || globalThis.__jobWorkdayLogin) return;
  globalThis.__jobWorkdayLogin = true;

  const $ = (root, id) => root.querySelector(`[data-automation-id="${id}"]`);
  const visible = (el) => !!el && el.isConnected && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const handled = new WeakSet();
  let note = null;
  let userTyped = false;
  let busy = false;

  async function ask(type, params = {}) {
    const r = await chrome.runtime.sendMessage({ type: 'autofill:' + type, ...params });
    if (!r?.ok) throw new Error(r?.error || 'The extension could not answer.');
    return r.data;
  }

  // Same approach as the autofill adapters: native setter, then events.
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
    for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
    return el.value === value;
  }

  // Workday puts a transparent "click_filter" over its buttons: press what is
  // actually at the button's centre, as long as it's inside the same panel.
  function press(button, panel) {
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2;
    let target = document.elementFromPoint(x, y);
    if (!target || !panel.contains(target)) target = button;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
    }
  }

  // A small notice in the corner (closed shadow root, own styles).
  function say(text, actions = []) {
    if (!note) {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial;position:fixed;left:20px;bottom:20px;z-index:2147483647}' +
        'div{font:13px/1.45 Inter,system-ui,sans-serif;color:#1a1d26;background:#fff;border:1px solid #e6e8ee;border-radius:12px;' +
        'padding:12px 14px;max-width:340px;box-shadow:0 12px 32px rgba(15,23,42,.14)}' +
        'strong{display:block;margin-bottom:4px}p{margin:0 0 8px}' +
        'button{font:600 12.5px Inter,system-ui,sans-serif;margin:0 6px 0 0;padding:6px 10px;border-radius:8px;border:1px solid #d4d7e0;background:#fff;cursor:pointer}' +
        'button.main{background:#0a65cc;border-color:#0a65cc;color:#fff}';
      const box = document.createElement('div');
      box.setAttribute('role', 'status');
      root.append(style, box);
      document.body.append(host);
      note = { host, box };
    }
    const title = document.createElement('strong');
    title.textContent = 'Job board autofill';
    const p = document.createElement('p');
    p.textContent = text;
    const buttons = actions.map(([label, fn, main]) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (main) b.className = 'main';
      b.onclick = (e) => e.isTrusted && fn();
      return b;
    });
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.onclick = (e) => e.isTrusted && hide();
    note.box.replaceChildren(title, p, ...buttons, close);
  }
  function hide() {
    note?.host.remove();
    note = null;
  }

  async function credentials() {
    let account;
    try {
      account = await ask('getProfile');
    } catch {
      say('Connect the extension to your job board account (extension popup) to sign in here automatically.');
      return null;
    }
    const email = account.profile?.contact?.email || account.user?.email;
    let secret;
    try {
      secret = await ask('sitePassword');
    } catch (err) {
      say(err.message);
      return null;
    }
    if (!secret?.password) {
      say('Set your job site password in the extension popup ("Job site password") to sign in to Workday automatically.');
      return null;
    }
    return { email, password: secret.password, auto: secret.autoSignIn };
  }

  function outline(el) {
    if (el) el.style.outline = '3px solid #0a65cc';
  }

  async function signIn(panel, email, password) {
    const creds = await credentials();
    if (!creds || !panel.isConnected) return;
    set(email, creds.email || '');
    set(password, creds.password);
    const button = $(panel, 'signInSubmitButton');
    const mayPress =
      creds.auto && !userTyped && document.visibilityState === 'visible' && navigator.userActivation?.hasBeenActive;
    if (!button) return;
    if (!mayPress) {
      outline(button);
      say(creds.auto ? 'Email and password are filled in. Click Sign In.' : 'Signing in failed here before, so it wasn’t tried again. Check the password, then click Sign In.', [
        ['Sign in', () => { hide(); press(button, panel); watch(panel); }, true],
      ]);
      return;
    }
    press(button, panel);
    watch(panel);
  }

  // Success: the sign-in panel goes away. Failure: still there after ~8 s
  // (with Workday's error message, or nothing new at all).
  function watch(panel) {
    const started = Date.now();
    const timer = setInterval(async () => {
      const gone = !visible(panel) || !document.contains(panel);
      if (gone) {
        clearInterval(timer);
        hide();
        await ask('loginResult', { result: 'ok' }).catch(() => {});
        return;
      }
      if (Date.now() - started < 8000) return;
      clearInterval(timer);
      await ask('loginResult', { result: 'failed' }).catch(() => {});
      const create = $(panel, 'createAccountLink');
      say('Signing in didn’t work. No account at this company yet, or a different password?', [
        ...(create ? [['Create account', () => { hide(); create.click(); }, true]] : []),
        ['Forgot password', () => { hide(); $(panel, 'forgotPasswordLink')?.click(); }],
      ]);
    }, 500);
  }

  // A real CAPTCHA (not Workday's "noCaptchaWrapper" around its buttons).
  function captcha(panel) {
    return !!panel.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-automation-id*="captcha" i]:not([data-automation-id="noCaptchaWrapper"])'
    );
  }

  async function createAccount(panel, email, password, verify) {
    const creds = await credentials();
    if (!creds || !panel.isConnected) return;
    set(email, creds.email || '');
    set(password, creds.password);
    set(verify, creds.password);
    const agree = $(panel, 'createAccountCheckbox');
    const button = $(panel, 'createAccountSubmitButton');
    const create = () => {
      // Workday's own terms box only, inside this panel.
      if (agree && !agree.checked) press(agree, panel);
      if (agree && !agree.checked) agree.click();
      if (agree && !agree.checked) {
        outline(agree.closest('[data-automation-id^="formField"]') || agree);
        say('Tick “I agree”, then click Create Account.');
        return;
      }
      press(button, panel);
      watchCreate(panel);
    };
    const mayPress =
      creds.auto &&
      !userTyped &&
      !!button &&
      !captcha(panel) &&
      document.visibilityState === 'visible' &&
      navigator.userActivation?.hasBeenActive;
    if (!mayPress) {
      outline(button);
      say(
        captcha(panel)
          ? 'Email and password are filled in. Solve the check on the page, tick “I agree”, then click Create Account.'
          : 'Email and password are filled in. Create the account with your job site password?',
        captcha(panel) || !button ? [] : [['Create account', () => { hide(); create(); }, true]]
      );
      return;
    }
    // Let Workday's form notice the typed values first.
    await new Promise((r) => setTimeout(r, 400));
    if (panel.isConnected) create();
  }

  // Created: the form goes away (Workday then asks to verify the email, or
  // signs in). Still there after ~10 s: say so, and try nothing more.
  function watchCreate(panel) {
    const started = Date.now();
    const timer = setInterval(async () => {
      const verify = panel.querySelector('input[type="password"][data-automation-id="verifyPassword"]');
      if (!visible(panel) || !document.contains(panel) || !visible(verify)) {
        clearInterval(timer);
        say('Account created with your job site password. If Workday asks you to verify your email, the link is opened from Gmail for you.');
        return;
      }
      if (Date.now() - started < 10000) return;
      clearInterval(timer);
      await ask('loginResult', { result: 'failed' }).catch(() => {});
      const signInLink = $(panel, 'signInLink');
      say('Workday didn’t create the account. You may already have one here, or the password doesn’t fit its rules.', [
        ...(signInLink ? [['Sign in instead', () => { hide(); signInLink.click(); }, true]] : []),
      ]);
    }, 500);
  }

  function step() {
    if (busy) return;
    const panel = $(document, 'signInContent');
    if (!visible(panel)) return;
    const email = panel.querySelector('input[data-automation-id="email"]');
    const password = panel.querySelector('input[type="password"][data-automation-id="password"]');
    const verify = panel.querySelector('input[type="password"][data-automation-id="verifyPassword"]');
    const byEmail = $(panel, 'SignInWithEmailButton');
    if (!email && visible(byEmail) && !handled.has(byEmail)) {
      handled.add(byEmail);
      if (navigator.userActivation?.hasBeenActive) byEmail.click();
      else say('Sign in with email to continue.', [['Sign in with email', () => { hide(); byEmail.click(); }, true]]);
      return;
    }
    if (!email || !password || handled.has(password)) return;
    handled.add(password);
    if (password.value || email.value) return; // The user (or the browser) already filled it.
    password.addEventListener('input', (e) => e.isTrusted && (userTyped = true));
    busy = true;
    (verify ? createAccount(panel, email, password, verify) : signIn(panel, email, password)).finally(() => {
      busy = false;
    });
  }

  let pending = 0;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(step, 300);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(step, 500);
})();
