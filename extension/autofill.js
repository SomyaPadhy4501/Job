'use strict';

(() => {
  // Runs once per frame: from the manifest on the four ATS hosts, and on any
  // other site after you allow it from the popup ("Autofill this page").
  if (globalThis.__jobAutofill) {
    if (globalThis.__jobAutofillOpen) globalThis.__jobAutofill.show();
    return;
  }
  const F = globalThis.AutofillFields;
  const hostName = location.hostname;
  const ats =
    hostName === 'jobs.lever.co'
      ? 'lever'
      : hostName === 'jobs.ashbyhq.com'
        ? 'ashby'
        : hostName.endsWith('.greenhouse.io')
          ? 'greenhouse'
          : /(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(hostName)
            ? 'workday'
            : 'generic';
  // Embedded forms (Stripe shows Greenhouse in an iframe sized to the whole
  // form, under its own page header) hide a pinned corner: there the button
  // sits in the page flow, just above the form.
  const framed = window !== window.top;
  const formTop = () =>
    document.querySelector('#application-form,#application_form,form:has(input,textarea,select)');
  const adapter = AutofillAdapters.create(document, ats);
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const element = (tag, value) => {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    return node;
  };
  const style = element(
    'style',
    (framed
      ? ':host{all:initial;display:block;position:relative;width:max-content;max-width:100%;margin:0 0 12px auto;'
      : ':host{all:initial;position:fixed;right:16px;bottom:16px;') +
      'z-index:2147483647;color:#182430;font:14px/1.45 system-ui,sans-serif}' +
      '*{box-sizing:border-box}button,select{font:inherit;padding:.45rem .65rem;border:1px solid #aebac5;border-radius:5px;background:white;color:inherit}' +
      'button{cursor:pointer}button:disabled{opacity:.55;cursor:default}button.main{background:#174464;color:white}' +
      'section{background:white;border:1px solid #9cabb7;border-radius:10px;padding:14px;width:min(360px,90vw);max-height:70vh;overflow:auto;box-shadow:0 3px 18px #0003}' +
      'label,select{display:block;width:100%;margin-bottom:6px}h2{font-size:16px;margin:0}ul{padding-left:18px;margin:6px 0}li{overflow-wrap:anywhere}li label{display:inline}.close{float:right}p{margin:8px 0}'
  );
  const open = element('button', 'Autofill'),
    panel = element('section');
  open.className = 'main';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Job application autofill');
  const close = element('button', 'Close'),
    picker = element('select');
  close.className = 'close';
  picker.id = 'resume';
  const label = element('label', 'Resume');
  label.htmlFor = picker.id;
  const fill = element('button', ats === 'workday' ? 'Fill this step' : 'Fill this page');
  fill.className = 'main';
  const status = element('p'),
    results = element('div'),
    save = element('button', 'Save my answers');
  status.setAttribute('role', 'status');
  panel.append(close, element('h2', 'Application autofill'), status, label, picker, fill, results, save);
  shadow.append(style, panel, open);
  function mount() {
    if (host.isConnected || !document.body) return;
    const form = framed && formTop();
    if (form?.parentNode) form.parentNode.insertBefore(host, form);
    else document.body.append(host);
  }
  mount();
  // Full-document React hydration can replace the initial body after idle.
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  let generation = 0,
    busy = false,
    account,
    previousStep = '',
    candidates = [];
  const marked = new Map();
  async function api(type, params = {}) {
    const r = await chrome.runtime.sendMessage({ type: 'autofill:' + type, ...params });
    if (!r?.ok) throw new Error(r?.error || 'Could not reach the autofill service.');
    return r.data;
  }
  function clearMarks() {
    for (const [el, { old, applied }] of marked) if (el.style.outline === applied) el.style.outline = old;
    marked.clear();
  }
  function step() {
    const active = document.querySelector(
      '[aria-current="step"],[data-automation-id="progressBarActiveStep"]'
    );
    const heading = document.querySelector('[data-automation-id="pageHeaderTitle"]');
    const firstField = ats === 'workday' && document.querySelector('[data-automation-id^="formField-"]');
    return [
      location.href,
      F.clean(active?.textContent),
      F.clean(heading?.textContent),
      firstField?.id || firstField?.dataset?.automationId,
    ].join('|');
  }
  function refresh() {
    results.replaceChildren();
    candidates = [];
    save.hidden = true;
    clearMarks();
  }
  function closePanel() {
    generation++;
    panel.hidden = true;
    open.hidden = false;
    busy = false;
    account = null;
    picker.disabled = save.disabled = false;
    picker.replaceChildren();
    refresh();
    open.focus();
  }
  close.onclick = (e) => {
    if (e.isTrusted) closePanel();
  };
  open.onclick = (e) => {
    if (e.isTrusted) show();
  };
  // Opening only loads your profile and resume list; nothing is filled until
  // you press "Fill this page".
  async function show() {
    if (!panel.hidden) return;
    const version = ++generation;
    panel.hidden = false;
    open.hidden = true;
    save.hidden = true;
    fill.disabled = true;
    close.focus();
    status.textContent = 'Loading profile…';
    try {
      const [data, settings] = await Promise.all([
        api('getProfile'),
        chrome.storage.local.get('autofillDefault'),
      ]);
      if (version !== generation) return;
      account = data;
      const title = F.clean(document.querySelector('h1')?.textContent || document.title);
      picker.add(new Option('Leave resume empty', ''));
      const ranked = await rank(data, title, settings.autofillDefault);
      if (version !== generation) return;
      for (const r of ranked) picker.add(new Option(r.title || r.fileName, r.id));
      picker.value = ranked[0]?.id || '';
      status.textContent = data.user.email + ' · pick the resume for this role, then fill.';
      previousStep = step();
      fill.disabled = false;
    } catch (err) {
      if (version === generation) status.textContent = err.message;
    }
  }
  globalThis.__jobAutofill = { show };
  // Started from the popup: only the frame holding the form opens its panel.
  if (globalThis.__jobAutofillOpen && adapter.collect().length) show();

  // The portal ranks resumes for the job title when it supports it; otherwise
  // (404, or an older portal) the tags are matched here against the page.
  async function rank(data, title, preferred) {
    const local = () =>
      F.rankResumes(data.resumes, title, document.body.innerText.slice(0, 30000), preferred);
    let server;
    try {
      server = (await api('rankResumes', { title, binding: data.binding })).resumes;
    } catch {
      return local();
    }
    if (!server) return local();
    const byId = new Map(data.resumes.map((r) => [r.id, r]));
    const ordered = server.map((r) => byId.get(r.id)).filter(Boolean);
    return [...new Set([...ordered, ...local()])];
  }
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  // Let an ATS's own resume parser finish before filling what is still empty.
  async function settle(active) {
    let last = Date.now();
    const watch = new MutationObserver(() => (last = Date.now()));
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    try {
      for (const start = Date.now(); active() && Date.now() - start < 5000 && Date.now() - last < 800; )
        await pause(100);
    } finally {
      watch.disconnect();
    }
  }
  const SENSITIVE = {
    sponsorship: 'From your work-authorization answers, check it',
    authorizedUS: 'From your work-authorization answers, check it',
    visa: 'From your visa status, check it',
    eeo: 'From your EEO choices, check it',
  };
  async function fileFor(resume, binding) {
    const file = await api('getResume', { id: resume.id, binding });
    const bytes = Uint8Array.from(atob(file.base64), (ch) => ch.charCodeAt(0));
    return new File([bytes], file.fileName || resume.fileName, { type: file.mimeType || resume.mimeType });
  }
  function render(records) {
    for (const group of ['Filled', 'Needs you', 'Skipped']) {
      const rows = records.filter((r) => r.group === group);
      if (!rows.length) continue;
      const list = element('ul');
      results.append(element('strong', group + ' (' + rows.length + ')'), list);
      for (const { d, reason, saveable } of rows) {
        const item = element('li');
        const description = d.label || d.name || d.automationId || 'Unlabelled field';
        item.textContent =
          (description.length > 180 ? description.slice(0, 177) + '…' : description) +
          (reason ? ' · ' + reason : '');
        if (saveable) {
          const box = element('input');
          box.type = 'checkbox';
          const choice = element('label');
          choice.append(box, ' Save my response');
          item.append(element('br'), choice);
          candidates.push({ d, box });
        }
        list.append(item);
        if (d.required && group !== 'Filled' && d.anchor.isConnected && !adapter.read(d)) {
          const old = d.anchor.style.outline;
          d.anchor.style.outline = '2px solid rgb(180, 96, 0)';
          marked.set(d.anchor, { old, applied: d.anchor.style.outline });
        }
      }
    }
    save.hidden = !candidates.length;
  }
  fill.onclick = async (e) => {
    if (!e.isTrusted || !account || busy) return;
    busy = true;
    fill.disabled = true;
    picker.disabled = true;
    const current = account,
      version = generation,
      initialStep = step();
    const active = () => version === generation && initialStep === step();
    refresh();
    status.textContent = 'Filling available fields…';
    try {
      // Recheck the account binding and refresh answers after a previous save.
      const data = await api('getProfile', { binding: current.binding });
      if (!active()) return;
      const resume = data.resumes.find((r) => r.id === picker.value);
      const records = [];
      const initial = adapter.collect();
      const attachments = initial.filter((d) => F.classify(d).kind === 'resume');
      const started = initial.some(
        (d) => ['text', 'email', 'tel', 'textarea', 'url'].includes(d.type) && adapter.read(d)
      );
      // Lever can parse an uploaded file directly into name/contact fields.
      // Attach first, and leave its parser to the user on a started form.
      for (const d of attachments) {
        let group = 'Needs you',
          reason,
          attached;
        if (adapter.read(d)) {
          group = 'Skipped';
          reason = 'File already attached';
        } else if (!resume || attachments.length !== 1) reason = 'Choose or attach a resume';
        else if (started && ats === 'lever') reason = 'Attach manually to review changes from resume parsing';
        else {
          try {
            const getFile = async () => (attached = await fileFor(resume, data.binding));
            if (await adapter.write(d, [], getFile, active)) {
              group = 'Filled';
              await settle(active);
            } else reason = 'Check the attachment';
          } catch (err) {
            reason = err.message;
          }
        }
        records.push({ d, group, reason, values: attached ? [attached.name] : [] });
      }
      if (!active()) return;
      await adapter.expand(data.profile, active);
      if (!active()) return;
      const fields = adapter.collect().filter((d) => F.classify(d).kind !== 'resume');
      const mixed = new Set(
        fields
          .filter((d) => d.row && adapter.read(d) && !F.resolve(d, data.profile).includes(adapter.read(d)))
          .map((d) => d.rowElement)
      );
      for (const d of fields) {
        if (!active()) return;
        const kind = F.classify(d).kind;
        const values = F.resolve(d, data.profile, data.answers);
        let group = 'Needs you',
          reason = '',
          saveable = false;
        if (!d.el.isConnected) {
          group = 'Skipped';
          reason = 'Form changed';
        } else if (adapter.read(d)) {
          group = 'Skipped';
          reason = 'Already answered';
        } else if (kind === 'protected') {
          group = d.required ? 'Needs you' : 'Skipped';
          reason = 'Complete personally';
        } else if (mixed.has(d.rowElement)) reason = 'Check the existing row';
        else if (values.length) {
          try {
            if (await adapter.write(d, values, null, active)) {
              group = 'Filled';
              reason = SENSITIVE[kind] || '';
            } else {
              reason = 'Check the value or choose an option';
              saveable = kind === 'question';
            }
          } catch {
            reason = 'Could not fill this control';
          }
        } else {
          reason = kind === 'question' ? 'No saved response' : 'No unambiguous profile answer';
          saveable = kind === 'question' && d.type !== 'file';
        }
        records.push({ d, group, reason, saveable, values });
      }
      // Final-value check, after the form has had a chance to re-render.
      await pause(400);
      if (!active()) return;
      for (const r of records) {
        if (r.group === 'Filled' && !adapter.holds(r.d, r.values)) {
          r.group = 'Needs you';
          r.reason = 'The form did not keep the filled value, check it';
          r.saveable = false;
        }
      }
      if (active()) {
        previousStep = initialStep;
        render(records);
        status.textContent = records.length
          ? 'Review your answers before continuing.'
          : 'No application fields found on this page.';
      }
    } catch (err) {
      if (version === generation) status.textContent = err.message;
    } finally {
      if (version === generation) {
        if (!active()) {
          refresh();
          status.textContent = 'Page changed. Review and fill this step.';
        }
        busy = false;
        fill.disabled = false;
        picker.disabled = false;
      }
    }
  };
  save.onclick = async (e) => {
    if (!e.isTrusted || !account || busy) return;
    if (previousStep !== step()) {
      refresh();
      status.textContent = 'Page changed. Fill this step first.';
      return;
    }
    // Collect only explicitly selected unresolved questions that still have
    // the same DOM control and label on this step.
    const now = new Map(adapter.collect().map((d) => [d.el, d]));
    const chosen = candidates
      .filter((c) => c.box.checked && !c.box.disabled)
      .flatMap((c) => {
        const current = now.get(c.d.el);
        if (!current || current.label !== c.d.label || F.classify(current).kind !== 'question') return [];
        const answer = adapter.answer(current);
        return answer ? [{ c, question: c.d.label, answer }] : [];
      });
    const answers = chosen.map(({ question, answer }) => ({ question, answer }));
    if (!answers.length) {
      status.textContent = 'Answer a listed question and check “Save my response”.';
      return;
    }
    const version = generation;
    busy = true;
    fill.disabled = save.disabled = true;
    try {
      const { saved } = await api('saveAnswers', { answers, binding: account.binding });
      if (version === generation) {
        for (const { c } of chosen) c.box.disabled = true;
        status.textContent =
          'Saved ' + saved + (saved === 1 ? ' answer' : ' answers') + ' to your answer bank.';
      }
    } catch (err) {
      if (version === generation) status.textContent = err.message;
    } finally {
      if (version === generation) {
        busy = false;
        fill.disabled = save.disabled = false;
      }
    }
  };
  if (ats === 'workday') {
    const observer = new MutationObserver(() => {
      if (panel.hidden || !account) return;
      const next = step();
      if (previousStep !== next) {
        previousStep = next;
        refresh();
        status.textContent = 'New application step. Select “Fill this step” when ready.';
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-current'],
    });
  }
})();
