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
  let adapter = AutofillAdapters.create(document, ats);
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const element = (tag, value) => {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    return node;
  };
  // Light theme. Every element sets its own display, spacing and line height,
  // so nothing about the page around it can stack or squash the text.
  const style = element(
    'style',
    (framed
      ? ':host{all:initial;display:block;position:relative;width:max-content;max-width:100%;margin:0 0 12px auto;'
      : ':host{all:initial;position:fixed;top:0;right:0;') +
      'z-index:2147483647}' +
      '*{box-sizing:border-box;margin:0;padding:0;position:static;float:none;height:auto;min-height:0;max-width:100%;' +
      'font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.45;' +
      'letter-spacing:normal;text-transform:none;text-align:left;color:#1a1d26;background:none;border:0}' +
      '[hidden]{display:none!important}' +
      'section,.card{display:flex;flex-direction:column;gap:12px;background:#fff;border:1px solid #e6e8ee;border-radius:16px;' +
      'padding:16px;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 16px 40px rgba(15,23,42,.18)}' +
      (framed ? '' : 'section{position:fixed;top:16px;right:16px}.card{position:fixed;right:20px;bottom:20px}') +
      '.head{display:flex;align-items:center;gap:10px}.head h2{flex:1}' +
      'h2{display:block;font-size:16px;font-weight:700;letter-spacing:-.01em}' +
      '.mark{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:7px;' +
      'background:linear-gradient(135deg,#0a65cc,#3b9be6)}.mark svg{display:block;width:14px;height:14px}' +
      // The edge tab: a small handle on the right edge; framed forms get an inline pill instead.
      (framed
        ? '.tab{display:inline-flex;align-items:center;gap:8px;padding:9px 16px 9px 10px;border-radius:999px;color:#fff;' +
          'background:linear-gradient(90deg,#0a65cc,#3b9be6);font-weight:700;box-shadow:0 6px 18px rgba(10,101,204,.3);cursor:pointer}' +
          '.tab span{color:#fff}.tab .mark{background:rgba(255,255,255,.18)}'
        : '.tab{position:fixed;right:0;top:42%;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px 10px 10px;' +
          'background:#fff;border:1px solid #e6e8ee;border-right:0;border-radius:12px 0 0 12px;box-shadow:0 6px 20px rgba(15,23,42,.18);' +
          'cursor:pointer;transition:padding .15s}.tab:hover{padding-right:14px}.tab .mark{width:28px;height:28px;border-radius:8px}.tab .mark svg{width:16px;height:16px}' +
          '.tab .chev{display:block;color:#6b7280;font-size:18px;font-weight:600;line-height:14px}') +
      '.collapse{padding:4px 9px;border-color:transparent;color:#6b7280;font-size:18px;line-height:18px}.collapse:hover{background:#f6f8fb}' +
      'p.banner{padding:10px 12px;border-radius:12px;background:#f6f8fb;color:#1a1d26;font-size:13px}' +
      'button.pill{display:flex;width:100%;padding:12px 18px;border:0;border-radius:999px;font-size:15px;font-weight:700;color:#fff;' +
      'background:linear-gradient(90deg,#0a65cc,#3b9be6);box-shadow:0 8px 20px rgba(10,101,204,.28)}button.pill:hover{filter:brightness(1.05)}' +
      'button.pill:disabled{box-shadow:none}' +
      'p{display:block;color:#6b7280;font-size:12.5px}' +
      'label{display:block;font-size:12px;font-weight:600;color:#6b7280}' +
      'select{display:block;width:100%;padding:8px 10px;border:1px solid #d4d7e0;border-radius:8px;background:#fff;cursor:pointer}' +
      'button{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 14px;border:1px solid #d4d7e0;' +
      'border-radius:8px;background:#fff;font-weight:600;cursor:pointer}' +
      'button:hover{border-color:#a5a9b8}button:disabled{opacity:.55;cursor:default}' +
      'button.main{background:#0a65cc;border-color:#0a65cc;color:#fff}button.main:hover{background:#0851a3}' +
      'button.ghost{background:#fff;color:#0851a3;border-color:#cfe0f5}' +
      '.close{padding:4px 10px;font-weight:500;color:#6b7280}' +
      'strong{display:block;margin-top:4px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#0851a3}' +
      'ul{display:flex;flex-direction:column;gap:6px;list-style:none}' +
      'li{display:block;padding:8px 10px;border:1px solid #eef0f4;border-radius:8px;background:#fafbfd;overflow-wrap:anywhere}' +
      'li br{display:none}' +
      'li label,.check{display:flex;align-items:center;gap:6px;margin-top:6px;font-weight:500;color:#1a1d26}' +
      'input[type=checkbox]{display:inline-block;width:14px;height:14px;flex:none;accent-color:#0a65cc;border:1px solid #a5a9b8}' +
      '.row{display:flex;gap:8px;flex-wrap:wrap}.ok{color:#047857}' +
      '.resumes{display:flex;flex-direction:column;gap:4px}' +
      '.resume-row{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid #e6e8ee;border-radius:10px;' +
      'font-size:13px;font-weight:500;color:#1a1d26;cursor:pointer;margin:0}' +
      '.resume-row.on{border-color:#0a65cc;background:#f3f8fd}' +
      '.resume-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      'input[type=radio]{display:inline-block;width:14px;height:14px;flex:none;accent-color:#0a65cc;margin:0}' +
      'button.small{padding:3px 9px;font-size:12px;font-weight:600;color:#0851a3;border-color:#cfe0f5}'
  );
  // Static markup only (a pencil): nothing from the page goes in here.
  const mark = () => {
    const box = element('span');
    box.className = 'mark';
    box.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    return box;
  };
  const open = element('button'),
    panel = element('section');
  open.className = 'tab';
  open.setAttribute('aria-label', 'Open application autofill');
  open.title = 'Autofill (US SWE Jobs)';
  if (framed) open.append(mark(), element('span', 'Autofill'));
  else {
    const chev = element('span', '‹');
    chev.className = 'chev';
    chev.setAttribute('aria-hidden', 'true');
    open.append(mark(), chev);
  }
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Job application autofill');
  const close = element('button', framed ? 'Close' : '›');
  close.className = framed ? 'close' : 'collapse';
  close.setAttribute('aria-label', 'Close autofill');
  // The resume list: one row per resume, each with a Preview button that
  // opens the file in a new tab. Same interface the code used for the
  // <select> it replaces (value, disabled, add, replaceChildren).
  const picker = (() => {
    const box = element('div');
    box.className = 'resumes';
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', 'Resume');
    const rows = [];
    let value = '',
      disabled = false;
    const sync = () => {
      for (const r of rows) {
        r.radio.checked = r.id === value;
        r.radio.disabled = disabled;
        r.row.classList.toggle('on', r.id === value);
      }
    };
    return {
      box,
      get value() {
        return value;
      },
      set value(v) {
        value = v;
        sync();
      },
      get disabled() {
        return disabled;
      },
      set disabled(d) {
        disabled = d;
        sync();
      },
      replaceChildren() {
        rows.length = 0;
        box.replaceChildren();
      },
      add(option) {
        const id = option.value;
        const row = element('label');
        row.className = 'resume-row';
        const radio = element('input');
        radio.type = 'radio';
        radio.name = 'job-autofill-resume';
        radio.onchange = () => {
          if (radio.checked) {
            value = id;
            sync();
          }
        };
        row.append(radio, element('span', option.text));
        if (id) {
          const preview = element('button', 'Preview');
          preview.type = 'button';
          preview.className = 'small';
          preview.onclick = (e) => {
            e.preventDefault();
            if (e.isTrusted) chrome.runtime.sendMessage({ type: 'autofill:previewResume', id }).catch(() => {});
          };
          row.append(preview);
        }
        rows.push({ id, radio, row });
        box.append(row);
        sync();
      },
    };
  })();
  const label = element('label', 'Resume');
  const fill = element('button', ats === 'workday' ? 'Fill this step' : 'Fill this page');
  fill.className = 'pill';
  const status = element('p'),
    results = element('div');
  status.setAttribute('role', 'status');
  status.className = 'banner';
  const head = element('div');
  head.className = 'head';
  head.append(mark(), element('h2', 'US SWE Jobs'), close);
  panel.append(head, status, fill, label, picker.box, results);
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
    previousStep = '';
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
    clearMarks();
  }
  function closePanel() {
    generation++;
    panel.hidden = true;
    open.hidden = false;
    busy = false;
    account = null;
    picker.disabled = false;
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
      const [ranked, fields] = await Promise.all([
        rank(data, title, settings.autofillDefault),
        // Best effort: the form still fills from its markup without it.
        api('formSchema', { binding: data.binding }).then((r) => r.fields, () => []),
      ]);
      if (version !== generation) return;
      if (fields.length)
        adapter = AutofillAdapters.create(document, ats, new Map(fields.map((f) => [f.name, f])));
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
      for (const { d, reason } of rows) {
        const item = element('li');
        const description = d.label || d.name || d.automationId || 'Unlabelled field';
        item.textContent =
          (description.length > 180 ? description.slice(0, 177) + '…' : description) +
          (reason ? ' · ' + reason : '');
        list.append(item);
        if (d.required && group !== 'Filled' && d.anchor.isConnected && !adapter.read(d)) {
          const old = d.anchor.style.outline;
          d.anchor.style.outline = '2px solid rgb(180, 96, 0)';
          marked.set(d.anchor, { old, applied: d.anchor.style.outline });
        }
      }
    }
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
      // Education and experience come from the resume being attached: each
      // resume can list different jobs and points (set per resume on the
      // Profile page). Without one, the profile's own lists are used.
      const own = resume && data.history?.[resume.id];
      const profile = own
        ? {
            ...data.profile,
            education: own.education?.length ? own.education : data.profile.education,
            experience: own.experience?.length ? own.experience : data.profile.experience,
          }
        : data.profile;
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
      await adapter.expand(profile, active);
      if (!active()) return;
      const fields = adapter.collect().filter((d) => F.classify(d).kind !== 'resume');
      const mixed = new Set(
        fields
          .filter((d) => d.row && adapter.read(d) && F.pick([adapter.read(d)], F.resolve(d, profile)) !== 0)
          .map((d) => d.rowElement)
      );
      for (const d of fields) {
        if (!active()) return;
        const kind = F.classify(d).kind;
        const values = F.resolve(d, profile, data.answers);
        let group = 'Needs you',
          reason = '';
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
            }
          } catch {
            reason = 'Could not fill this control';
          }
        } else {
          // New custom questions: you answer them, and after you submit the
          // extension offers to save them (offerHeld below).
          reason =
            kind === 'question'
              ? 'New question: answer it, then save it after you submit'
              : kind === 'manual'
                ? 'Complete personally'
                : 'Not in your profile (add it there to fill this)';
        }
        records.push({ d, group, reason, values });
      }
      // Final-value check, after the form has had a chance to re-render.
      await pause(400);
      if (!active()) return;
      for (const r of records) {
        if (r.group === 'Filled' && !adapter.holds(r.d, r.values)) {
          r.group = 'Needs you';
          r.reason = 'The form did not keep the filled value, check it';
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
  // ─── After you submit: offer to save the new answers ─────────────────────
  // Watches passively (never blocks or delays anything). When you submit an
  // application yourself, the custom questions you answered (on every step of
  // a multi-step form) are held for a few minutes, so the offer survives a
  // page change. Once the submission is confirmed, the ones not already in
  // your answer bank are shown in a small card. Nothing is sent until you
  // click Save.
  function companyName() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (ats === 'ashby' || ats === 'lever') return parts[0] || '';
    if (ats === 'greenhouse')
      return new URLSearchParams(location.search).get('for') || (parts[0] !== 'embed' ? parts[0] : '') || '';
    if (ats === 'workday') return location.hostname.split('.')[0];
    return location.hostname.replace(/^(?:www|careers|jobs|apply)\./, '').split('.')[0];
  }
  // Custom questions answered on this page (or step). Compared with the answer
  // bank only when offering, so this works without the panel ever opening.
  function typedAnswers() {
    const seen = new Set();
    return adapter
      .collect()
      .filter((d) => F.classify(d).kind === 'question' && d.label)
      .map((d) => ({ question: F.clean(d.label).slice(0, 500), answer: F.clean(adapter.answer(d) || '').slice(0, 4000) }))
      .filter((a) => a.answer && !seen.has(a.question) && seen.add(a.question));
  }
  function hold(submitted) {
    const answers = typedAnswers();
    if (!answers.length && !submitted) return;
    chrome.runtime
      .sendMessage({ type: 'autofill:holdAnswers', answers, company: companyName(), submitted })
      .catch(() => {});
  }
  // Final submission, on any ATS's wording: "Submit application", "Send",
  // "Apply", "Finish", "Complete application". A step button ("Next", "Save
  // and continue") only holds that step's answers for later.
  const finalWords = /^(?:submit|send|apply|finish|complete)\b|\bsubmit\b|\b(?:send|complete|finish) (?:my |your )?application\b/i;
  const stepWords = /^(?:next|continue|save and continue|save & continue|review)\b/i;
  const confirmation =
    /thank you for (?:applying|your application|your interest)|application (?:has been |was )?(?:submitted|received)|(?:we(?:'ve| have)|we) received your application|successfully (?:submitted|applied)/i;
  let watching = 0;
  // Single-page forms (Ashby, Workday) stay on this document: offer once the
  // page confirms the submission, never while the form is still being edited.
  function watchForConfirmation() {
    const mine = ++watching;
    const pageText = () => document.body?.innerText || '';
    // Text already on the page (a job description's "thank you for your
    // interest") isn't a confirmation.
    const already = confirmation.test(pageText());
    let tries = 0;
    const check = () => {
      if (mine !== watching || offered) return;
      const formGone = !adapter.collect().some((d) => ['text', 'textarea', 'email', 'combo', 'select', 'yesno', 'radio'].includes(d.type));
      if ((!already && confirmation.test(pageText())) || formGone) return void offerHeld();
      if (++tries < 20) setTimeout(check, 1000);
    };
    setTimeout(check, 1500);
  }
  function onSubmitLike(e) {
    if (!e.isTrusted || busy) return;
    const b =
      e.type === 'click' ? e.target?.closest?.('button,input[type=submit],[role=button]') : e.submitter;
    const words = F.clean(b?.textContent || b?.value || b?.getAttribute?.('aria-label') || '');
    // A form submitted by its "Next" button is a step, not the application.
    if (e.type === 'submit' && stepWords.test(words)) return;
    if (e.type === 'click') {
      if (!b || !words) return;
      if (stepWords.test(words)) return hold(false);
      if (!finalWords.test(words)) return;
    }
    hold(true);
    watchForConfirmation();
  }
  window.addEventListener('submit', onSubmitLike, true);
  document.addEventListener('click', onSubmitLike, true);

  let offered = false;
  async function offerHeld() {
    if (offered || window !== window.top && !document.querySelector('form')) return;
    let pending;
    try {
      pending = await api('takeAnswers');
    } catch {
      return;
    }
    if (!pending?.answers?.length) return;
    let bank;
    try {
      bank = account || (await api('getProfile'));
    } catch {
      return;
    }
    pending.answers = pending.answers.filter((a) => F.savedAnswer(a.question, bank.answers || []) !== a.answer);
    if (!pending.answers.length || offered) return;
    offered = true;
    const card = element('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Save your answers');
    const n = pending.answers.length;
    const list = element('ul');
    const boxes = pending.answers.map((a) => {
      const item = element('li');
      const box = element('input');
      box.type = 'checkbox';
      box.checked = true;
      const lab = element('label');
      lab.append(box, a.question.length > 140 ? a.question.slice(0, 137) + '…' : a.question);
      const ans = element('p', a.answer.length > 160 ? a.answer.slice(0, 157) + '…' : a.answer);
      item.append(lab, ans);
      list.append(item);
      return { box, a };
    });
    const scope = element('label');
    scope.className = 'check';
    const scopeBox = element('input');
    scopeBox.type = 'checkbox';
    scope.append(scopeBox, pending.company ? 'Use only for ' + pending.company : 'Use only for this company');
    const msg = element('p', 'Next time a form asks the same question, it fills in by itself.');
    const keep = element('button', 'Save');
    keep.className = 'main';
    const skip = element('button', 'Not now');
    const row = element('div');
    row.className = 'row';
    row.append(keep, skip);
    const cardHead = element('div');
    cardHead.className = 'head';
    cardHead.append(element('h2', 'Save ' + n + (n === 1 ? ' new answer?' : ' new answers?')));
    card.append(cardHead, msg, list, scope, row);
    skip.onclick = (ev) => ev.isTrusted && card.remove();
    keep.onclick = async (ev) => {
      if (!ev.isTrusted) return;
      const chosen = boxes.filter((b) => b.box.checked).map((b) => ({
        ...b.a,
        ...(scopeBox.checked && pending.company ? { company: pending.company } : {}),
      }));
      if (!chosen.length) return card.remove();
      keep.disabled = skip.disabled = true;
      try {
        // A fresh page (after submit) hasn't loaded the account yet.
        const binding = bank.binding;
        const { saved } = await api('saveAnswers', { answers: chosen, binding });
        card.replaceChildren(element('h2', 'Saved ' + saved + (saved === 1 ? ' answer' : ' answers')));
        card.querySelector('h2').className = 'ok';
        setTimeout(() => card.remove(), 2500);
      } catch (err) {
        msg.textContent = err.message;
        keep.disabled = skip.disabled = false;
      }
    };
    shadow.append(card);
    open.hidden = true;
    panel.hidden = true;
  }
  // A page that follows a submit (Greenhouse's confirmation page) offers too.
  if (window === window.top) setTimeout(offerHeld, 1500);

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
