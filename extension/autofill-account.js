'use strict';

// Sign-in and create-account pages on job sites other than Workday
// (autofill-login.js has Workday): iCIMS, Taleo, SuccessFactors, Oracle,
// SmartRecruiters, Phenom, Avature and other application systems, and a
// company's own career site. Uses the one job-site email and password saved
// on the job board (Autofill page; the same login as Workday).
//
// - On a known application system: the email (and on sign-up the password
//   twice, plus your name) is filled as soon as the form shows. Sign in is
//   pressed once, only after you've interacted with the page; on sign-up a
//   notice offers Create account, which you press.
// - On any other job site: a notice asks first; nothing is filled until you
//   press Fill on it.
// - Never ticks a terms or consent box, never touches a CAPTCHA, never fills
//   a field you already typed in, stops after a failed sign-in until the
//   password changes on the job board. Top frame only.
(() => {
  if (window !== window.top || globalThis.__jobAccount) return;
  globalThis.__jobAccount = true;
  const P = globalThis.JobApplicationPages;
  const host = location.hostname;
  const known = !!P?.applySystem?.(host);
  const JOBS = /career|\bjobs?\b|apply|application|candidate|talent|recruit|hiring|requisition|vacanc|opportunit/i;
  if (!known && !JOBS.test(host + ' ' + location.pathname + ' ' + document.title)) return;

  const visible = (el) => !!el && el.isConnected && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const handled = new WeakSet();
  let note = null;
  let busy = false;
  let typed = false;
  document.addEventListener('input', (e) => e.isTrusted && e.target?.matches?.('input') && (typed = true), true);

  async function ask(type, params = {}) {
    const r = await chrome.runtime.sendMessage({ type: 'autofill:' + type, ...params });
    if (!r?.ok) throw new Error(r?.error || 'The extension could not answer.');
    return r.data;
  }

  function set(el, value) {
    if (!value || el.value) return false;
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

  function press(button) {
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      button.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
    }
    button.click();
  }

  function say(message, actions = []) {
    if (!note) {
      const box = document.createElement('div');
      const root = box.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        ':host{all:initial;position:fixed;left:20px;bottom:20px;z-index:2147483647}' +
        'div{font:13px/1.45 Inter,system-ui,sans-serif;color:#1a1d26;background:#fff;border:1px solid #e6e8ee;border-radius:12px;' +
        'padding:12px 14px;max-width:340px;box-shadow:0 12px 32px rgba(15,23,42,.14)}' +
        'strong{display:block;margin-bottom:4px}p{margin:0 0 8px}' +
        'button{font:600 12.5px Inter,system-ui,sans-serif;margin:0 6px 0 0;padding:6px 10px;border-radius:8px;border:1px solid #d4d7e0;background:#fff;cursor:pointer}' +
        'button.main{background:#0a65cc;border-color:#0a65cc;color:#fff}';
      const inner = document.createElement('div');
      inner.setAttribute('role', 'status');
      root.append(style, inner);
      document.body.append(box);
      note = { host: box, box: inner };
    }
    const title = document.createElement('strong');
    title.textContent = 'Job board autofill';
    const p = document.createElement('p');
    p.textContent = message;
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

  const describe = (el) =>
    [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute('aria-label'), text(el.labels?.[0]), text(el.closest('label'))]
      .join(' ')
      .toLowerCase();
  const CAPTCHA =
    'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]';
  const SIGN_UP = /create (?:an? |your )?account|create (?:a )?profile|register|sign ?up|new (?:user|candidate)|join (?:our )?talent/i;
  const SIGN_IN = /sign ?in|log ?in|login|returning (?:user|candidate)|existing (?:user|candidate)/i;

  // The sign-in or sign-up form on the page now, if any.
  function findForm() {
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(
      (el) => visible(el) && !el.disabled && !el.readOnly
    );
    if (!passwords.length) return null;
    const scope = passwords[0].closest('form') || passwords[0].closest('[role="dialog"],main,section,div[class*="login" i],div[class*="register" i]') || document.body;
    const pw = passwords.filter((el) => scope.contains(el));
    if (!pw.length || pw.length > 3) return null;
    const inputs = [...scope.querySelectorAll('input')].filter(
      (el) => visible(el) && !el.disabled && !el.readOnly && /^(?:text|email|tel|)$/i.test(el.getAttribute('type') || '')
    );
    const emails = inputs.filter((el) => el.type === 'email' || /e-?mail|user ?name|username|login|user id|userid/.test(describe(el)));
    const field = (re) => inputs.find((el) => re.test(describe(el)) && !emails.includes(el));
    const buttons = [...scope.querySelectorAll('button,input[type="submit"],[role="button"]')].filter(visible);
    const words = (b) => text(b) || b.value || b.getAttribute('aria-label') || '';
    const confirmBox = pw.length >= 2 || /confirm|re-?enter|retype|verify/.test(describe(pw[pw.length - 1]));
    const scopeText = text(scope).slice(0, 3000);
    const signUp = confirmBox || (SIGN_UP.test(scopeText) && !SIGN_IN.test(buttons.map(words).join(' ')));
    const submit = buttons.find((b) => (signUp ? SIGN_UP : SIGN_IN).test(words(b)) && !/forgot|reset|google|linkedin|apple|facebook|microsoft|indeed/i.test(words(b)));
    return {
      scope,
      signUp,
      passwords: pw,
      emails,
      first: field(/first ?name|given name|fname/),
      last: field(/last ?name|family name|surname|lname/),
      submit,
      captcha: !!scope.querySelector(CAPTCHA) || !!document.querySelector(CAPTCHA),
    };
  }

  async function credentials(confirmed) {
    let secret;
    try {
      secret = await ask('sitePassword', confirmed ? { confirmed: true } : {});
    } catch (err) {
      say(err.message);
      return null;
    }
    if (!secret?.password) {
      say('Set your job-site email and password on the job board (Autofill page → Workday accounts) to sign in and create accounts automatically.');
      return null;
    }
    let profile = null;
    try {
      profile = await ask('getProfile');
    } catch {}
    const email = secret.email || profile?.profile?.contact?.email || profile?.user?.email || '';
    return { email, password: secret.password, auto: secret.autoSignIn, identity: profile?.profile?.identity || {} };
  }

  async function fill(form, confirmed) {
    const creds = await credentials(confirmed);
    if (!creds || !form.scope.isConnected) return;
    if (form.emails.some((el) => el.value) || form.passwords.some((el) => el.value)) return; // You (or the browser) filled it.
    for (const el of form.emails) set(el, creds.email);
    for (const el of form.passwords) set(el, creds.password);
    if (form.signUp) {
      set(form.first, creds.identity.firstName);
      set(form.last, creds.identity.lastName);
      const terms = [...form.scope.querySelectorAll('input[type="checkbox"]')].filter((b) => visible(b) && !b.checked);
      const create = () => {
        hide();
        const open = [...form.scope.querySelectorAll('input[type="checkbox"][required],input[type="checkbox"][aria-required="true"]')].filter(
          (b) => visible(b) && !b.checked
        );
        if (open.length) {
          open[0].style.outline = '3px solid #0a65cc';
          return say('Tick the required box (terms or privacy), then press Create account again.', [['Create account', create, true]]);
        }
        if (form.submit?.isConnected) {
          press(form.submit);
          watch(form, true);
        }
      };
      if (form.captcha || !form.submit)
        return say('Email and password are filled in. Finish the check on the page (if any), then create the account yourself.');
      if (form.submit) form.submit.style.outline = '3px solid #0a65cc';
      return say(
        terms.length
          ? 'Email and password are filled in. Tick the terms box if you agree, then Create account.'
          : 'Email and password are filled in with your job-site login. Create the account?',
        [['Create account', create, true]]
      );
    }
    const mayPress =
      known &&
      creds.auto &&
      !typed &&
      !form.captcha &&
      form.submit &&
      document.visibilityState === 'visible' &&
      navigator.userActivation?.hasBeenActive;
    if (!form.submit || form.captcha) return say('Email and password are filled in. Sign in yourself.');
    if (!mayPress) {
      form.submit.style.outline = '3px solid #0a65cc';
      return say(
        creds.auto ? 'Email and password are filled in. Sign in?' : 'Signing in failed here before, so it wasn’t tried again. Check the password, then sign in.',
        [['Sign in', () => { hide(); press(form.submit); watch(form, false); }, true]]
      );
    }
    press(form.submit);
    watch(form, false);
  }

  // Signed in or created: the password boxes go away. Still there after
  // ~10 s: say so, and stop automatic attempts until the password changes.
  function watch(form, created) {
    const started = Date.now();
    const timer = setInterval(async () => {
      const gone = form.passwords.every((el) => !visible(el));
      if (gone) {
        clearInterval(timer);
        hide();
        if (!created) await ask('loginResult', { result: 'ok' }).catch(() => {});
        else say('Account created with your job-site login. If the site emails a code or a link, it is filled or opened from Gmail for you.');
        return;
      }
      if (Date.now() - started < 10000) return;
      clearInterval(timer);
      await ask('loginResult', { result: 'failed' }).catch(() => {});
      say(
        created
          ? 'The site didn’t create the account. You may already have one here, or the password doesn’t fit its rules.'
          : 'Signing in didn’t work. No account here yet, or a different password?'
      );
    }, 500);
  }

  function step() {
    if (busy) return;
    const form = findForm();
    if (!form || handled.has(form.passwords[0])) return;
    handled.add(form.passwords[0]);
    if (form.passwords.some((el) => el.value) || form.emails.some((el) => el.value)) return;
    if (known) {
      busy = true;
      fill(form, false).finally(() => (busy = false));
      return;
    }
    say(
      form.signUp
        ? 'Create your account here with your job-site email and password?'
        : 'Sign in here with your job-site email and password?',
      [
        [
          'Fill',
          () => {
            hide();
            busy = true;
            fill(form, true).finally(() => (busy = false));
          },
          true,
        ],
      ]
    );
  }

  let pending = 0;
  new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(step, 400);
  }).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(step, 600);
})();
