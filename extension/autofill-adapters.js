'use strict';

(function (root) {
  const F =
    typeof module !== 'undefined' && module.exports ? require('./autofill-fields') : root.AutofillFields;
  const all = (el, selector) => [...el.querySelectorAll(selector)];
  const text = (el) => F.clean(el?.textContent);
  const attr = (el, name) => el?.getAttribute(name) || '';
  const typeOf = (el) =>
    (attr(el, 'type') || (el.localName === 'input' ? 'text' : el.localName)).toLowerCase();
  const navigation =
    /\b(?:submit|next|continue|finish|apply|review|send|save|done|back|previous|sign ?in|log ?in|register|create account|delete|remove|withdraw)\b/i;
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const captcha =
    '[data-sitekey],[id*="captcha" i],[name*="captcha" i],[class*="captcha" i],[class*="turnstile" i]';
  const wrapper =
    '.application-question,.ashby-application-form-field-entry,.field-wrapper,[data-automation-id^="formField"]';
  const controls =
    'input,textarea,select,button[aria-haspopup="listbox"],[role="button"][aria-haspopup="listbox"],.ashby-application-form-input-yesno';
  const roots = {
    greenhouse: '#application-form,#application_form',
    lever: '#application-form',
    ashby: '.ashby-application-form-field-entry,[data-field-path]',
    workday:
      '[data-automation-id="jobApplicationPage"],[data-automation-id="applyFlowPage"],[data-automation-id="workdayApplicationForm"],[data-automation-id="applicationForm"]',
  };
  // Company-built forms (Tesla, Amazon, …): no known container, so the
  // application form is the one with the most fillable controls, preferring a
  // resume upload. Newsletter, search, sign-in and cookie forms never count.
  const pageChrome = 'header,nav,footer,[role="search"],[role="banner"],[role="navigation"],[role="contentinfo"]';
  const notApplication = /newsletter|subscribe|search|log-?in|sign-?in|sign-?up|cookie|consent-banner|feedback/i;
  const genericBox =
    '.form-group,.form-field,.form-item,.field,.question,[class*="form-field" i],[class*="FormField"],[class*="question" i],[data-testid*="field" i]';
  function fillable(el) {
    const type = typeOf(el);
    return !['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password'].includes(type);
  }
  function genericRoot(doc) {
    const candidates = all(doc, 'form,[role="form"],main,[role="main"],[role="dialog"]').filter(
      (el) =>
        visible(el) &&
        !el.closest(pageChrome) &&
        !el.querySelector('input[type="password"]') &&
        !notApplication.test([el.id, attr(el, 'class'), attr(el, 'name'), attr(el, 'action'), attr(el, 'aria-label')].join(' '))
    );
    let best = null,
      bestScore = 0;
    for (const el of candidates) {
      const inputs = all(el, controls).filter((c) => fillable(c) && visible(c) && !c.closest(pageChrome));
      if (inputs.length < 2) continue;
      const score = inputs.length + (el.querySelector('input[type="file"]') ? 6 : 0) +
        (/(?:first name|last name|resume|cv|apply|application)/i.test(text(el).slice(0, 4000)) ? 3 : 0);
      // A form inside a larger candidate wins ties: it is the tighter scope.
      if (score > bestScore || (score === bestScore && best?.contains(el))) {
        best = el;
        bestScore = score;
      }
    }
    return bestScore >= 3 ? best : null;
  }
  // The text next to a control on a form whose labels aren't linked to it:
  // the closest ancestor (a few levels up) that holds only this control.
  function nearbyLabel(el) {
    let p = el.parentElement;
    for (let depth = 0; p && depth < 4 && !p.matches('form,main,body'); depth++, p = p.parentElement) {
      const others = all(p, controls).filter(
        (c) => c !== el && fillable(c) && !(c.name && c.name === el.name && ['radio', 'checkbox'].includes(typeOf(c)))
      );
      if (others.length) return '';
      const label = all(p, 'label,legend,[class*="label" i],[class*="Label"]').find(
        (n) => n !== el && !n.contains(el) && text(n)
      );
      if (label) return text(label);
    }
    return '';
  }
  const rowSelectors = {
    education:
      '.education--form,[data-education-row],[data-automation-id^="education-"],[data-automation-id="educationSection"]',
    experience:
      '.employment--form,.experience--form,[data-experience-row],[data-automation-id^="workExperience-"],[data-automation-id="workExperienceSection"]',
  };
  const sections = {
    education:
      '.education--container,[data-section="education"],[data-automation-id="educationSectionContainer"],[data-automation-id="education"]',
    experience:
      '.employment--container,.experience--container,[data-section="experience"],[data-automation-id="workExperienceSectionContainer"],[data-automation-id="workExperience"]',
  };
  const placeholder = (s) =>
    /^(?:select(?: one| an option)?|please select|choose(?: one| an option)?|--)?[.\s…-]*$/i.test(s);
  function visible(el) {
    if (!el?.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"],fieldset[disabled]'))
      return false;
    const win = el.ownerDocument.defaultView;
    if (win.getComputedStyle) {
      for (let p = el; p?.nodeType === 1; p = p.parentElement) {
        const css = win.getComputedStyle(p);
        if (css.display === 'none' || css.visibility === 'hidden') return false;
      }
    }
    return true;
  }
  function safeButton(el) {
    if (
      !el ||
      el.closest(captcha) ||
      el.closest('a[href],[formaction],[disabled],[aria-disabled="true"],[type="submit"],input[type="image"]')
    )
      return false;
    const button = el.closest('button');
    if (button && (button.form || button.closest('form')) && attr(button, 'type').toLowerCase() !== 'button')
      return false;
    const action = button || el;
    // Navigation, submission and destructive actions stay with the user, even
    // when a site renders them as a plain button or a listbox option.
    return !navigation.test(
      [text(action), attr(action, 'aria-label'), action.id, attr(action, 'data-automation-id')].join(' ')
    );
  }
  function nativeSet(el, property, value) {
    // Bypass React's per-instance value tracker.
    let proto = Object.getPrototypeOf(el);
    while (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, property);
      if (descriptor?.set) {
        descriptor.set.call(el, value);
        return;
      }
      proto = Object.getPrototypeOf(proto);
    }
    el[property] = value;
  }
  // Location search boxes: the ATS needs a place picked from its suggestions,
  // so a typed value alone doesn't count.
  const placePaths = ['location', 'fullLocation', 'address.city'];
  function placeSearch(d) {
    return (
      d.el.localName === 'input' &&
      d.el.matches('[aria-autocomplete="list"],.location-input') &&
      placePaths.includes(F.classify(d).path)
    );
  }
  // react-datepicker inputs take typed MM/DD/YYYY text.
  const datePicker = (el) =>
    el.matches('.ashby-application-form-input-date,.react-datepicker__input-container input');
  function changed(el) {
    for (const event of ['input', 'change', 'blur'])
      el.dispatchEvent(new el.ownerDocument.defaultView.Event(event, { bubbles: true }));
  }
  function create(doc, ats, schema = new Map()) {
    const scope = roots[ats];
    let generic = null;
    function inScope(el) {
      if (ats === 'generic') return !!generic && generic.contains(el) && !el.closest(pageChrome);
      if (el.closest(scope)) return true;
      // Some Workday tenants use their own section IDs throughout the form.
      return (
        ats === 'workday' &&
        /\/apply(?:\/|$)/i.test(doc.location?.pathname || '') &&
        el.closest('form,[data-automation-id^="formField"],main') &&
        !el.closest('[data-automation-id*="signIn" i],form:has(input[type="password"])')
      );
    }
    function sectionFor(section) {
      const explicit = all(doc, sections[section]).filter(visible);
      if (explicit.length) return explicit.length === 1 ? explicit[0] : null;
      const heading =
        section === 'education'
          ? /^education(?: history)?$/i
          : /^(?:work experience|employment history|experience)$/i;
      const headings = all(doc, 'h2,h3,h4,legend').filter((el) => heading.test(text(el)) && visible(el));
      if (headings.length !== 1) return null;
      for (let p = headings[0].parentElement; p && !p.matches('body,main,form'); p = p.parentElement) {
        if (p.querySelector(controls) && all(p, 'button').some((b) => /^add(?: another)?$/i.test(text(b))))
          return p;
      }
      return null;
    }
    function rows(section) {
      const tagged = all(doc, rowSelectors[section]).filter(
        (el) => visible(el) && all(el, controls).some(inScope)
      );
      if (tagged.length)
        return tagged.filter((el) => !tagged.some((other) => el !== other && el.contains(other)));
      const area = sectionFor(section);
      if (!area) return [];
      // Where row IDs are opaque, recognize record groups by a school or
      // employer label inside a fieldset/row, within the named section.
      const primary =
        section === 'education'
          ? /^(?:school|school name|university)$/i
          : /^(?:employer|company|company name)$/i;
      const groups = all(area, 'fieldset,[role="group"],[data-row],.form-row,[data-field-path]').filter(
        (group) =>
          visible(group) &&
          group.querySelector(controls) &&
          all(group, 'label,.application-label').some((label) =>
            primary.test(text(label).replace(/[✱*]/g, '').trim())
          )
      );
      return groups.filter((el) => !groups.some((other) => el !== other && el.contains(other)));
    }
    function collect() {
      const fields = [],
        choiceSets = new Map();
      if (ats === 'generic') generic = genericRoot(doc);
      const labels = new Map(all(doc, 'label[for]').map((label) => [attr(label, 'for'), label]));
      const rowMap = new Map();
      for (const section of Object.keys(rowSelectors))
        rows(section).forEach((el, index) => rowMap.set(el, { section, index }));
      for (const el of all(doc, controls)) {
        if (!inScope(el) || el.closest(captcha) || el.closest('form')?.querySelector('input[type=password]'))
          continue;
        let type = typeOf(el);
        const buttons = el.matches('.ashby-application-form-input-yesno');
        if (!buttons && el.closest('.ashby-application-form-input-yesno')) continue;
        if (buttons) type = 'yesno';
        else if (el.matches('[role="combobox"],[aria-haspopup="listbox"]')) type = 'combo';
        if (
          ![
            'text',
            'url',
            'email',
            'tel',
            'number',
            'month',
            'date',
            'textarea',
            'file',
            'checkbox',
            'select',
            'radio',
            'combo',
            'yesno',
          ].includes(type)
        )
          continue;
        const box = el.closest(wrapper) || (ats === 'generic' ? el.closest(genericBox) : null);
        const anchor = type === 'file' ? box || el.closest('.application--questions') || el : el;
        if (
          !visible(anchor) ||
          el.disabled ||
          (el.readOnly && type !== 'combo') ||
          attr(el, 'aria-disabled') === 'true'
        )
          continue;
        const name = attr(el, 'name'),
          id = el.id || attr(box, 'data-field-path');
        const legend = el.closest('fieldset')?.querySelector('legend');
        const boxLabel =
          box?.querySelector('.application-label,.ashby-application-form-question-title') ||
          // On company-built forms the question is the text that wraps no
          // control; a choice's own <label> ("Yes") is not the question.
          (ats === 'generic' && box
            ? all(box, 'legend,[class*="label" i],[class*="Label"],h3,h4,p').find(
                (n) => !n.querySelector(controls) && !n.closest('label') && text(n)
              )
            : null) ||
          box?.querySelector('legend,label');
        const labelledBy = attr(el, 'aria-labelledby')
          .split(/\s+/)
          .filter((id) => id && id !== el.id)
          .map((id) => text(doc.getElementById(id)))
          .join(' ');
        const linked = labels.get(el.id);
        const label =
          (['radio', 'checkbox', 'yesno'].includes(type) && (text(boxLabel) || text(legend))) ||
          attr(el, 'aria-label') ||
          text(linked) ||
          labelledBy ||
          text(boxLabel) ||
          text(el.closest('label')) ||
          (ats === 'generic' ? nearbyLabel(el) || attr(el, 'placeholder') : '');
        const meta = schema.get(name || id) || {};
        const d = {
          el,
          anchor,
          box,
          type,
          name,
          id,
          label: label || meta.label || '',
          automationId:
            attr(el, 'data-automation-id') || attr(box, 'data-automation-id').replace(/^formField-/, ''),
          required: !!(
            el.required ||
            el.hasAttribute('required') ||
            attr(el, 'aria-required') === 'true' ||
            attr(el.closest('fieldset'), 'aria-required') === 'true' ||
            /[✱*]/.test(label) ||
            boxLabel?.className.includes('_required_') ||
            meta.required
          ),
          autocomplete: attr(el, 'autocomplete'),
          safetyText: [text(legend), text(boxLabel), labelledBy].join(' '),
          eeo: !!el.closest(
            '.eeoc__container,.eeoc__question__wrapper,[class*="demographic"],[data-qa*="eeo"]'
          ),
        };
        if (/captcha|turnstile/i.test([d.label, d.safetyText, d.automationId].join(' '))) continue;
        if (ats === 'lever' && boxLabel?.classList.contains('application-label')) d.label = text(boxLabel);
        if (['smsConsent', 'whatsAppConsent'].includes(name))
          d.label = name === 'smsConsent' ? 'SMS consent' : 'WhatsApp consent';
        if (
          type === 'file' &&
          /^(?:attach|upload)$/i.test(d.label) &&
          ['resume', 'cover_letter'].includes(id)
        ) {
          d.label = id === 'resume' ? 'Resume' : 'Cover letter';
        }
        if (el.closest('.phone-input__country')) d.label = 'Phone country code';
        for (let p = el; p; p = p.parentElement) {
          if (rowMap.has(p)) {
            d.row = rowMap.get(p);
            d.rowElement = p;
            break;
          }
        }
        if (type === 'radio' || type === 'checkbox') {
          const list = choiceSets.get(name) || [];
          const previous =
            name &&
            list.find(
              (f) => f.type === type && f.el.form === el.form && f.box === box && f.label === d.label
            );
          if (previous) {
            previous.members.push(el);
            continue;
          }
          d.members = [el];
          list.push(d);
          choiceSets.set(name, list);
        }
        if (buttons) d.members = all(el, 'button[data-option]');
        fields.push(d);
      }
      for (const d of fields) {
        if (d.type === 'select') d.members = all(d.el, 'option');
        if (d.members)
          d.options = d.members.map((m) =>
            m.localName === 'input' ? text(m.closest('label')) || attr(m, 'value') : text(m)
          );
      }
      return fields;
    }

    function read(d) {
      const el = d.el;
      if (d.type === 'file') {
        const uploaded = d.box?.querySelector(
          '.file-upload__filename,.filename,[data-automation-id="fileName"]'
        );
        return el.files?.[0]?.name || el.value || text(uploaded);
      }
      if (d.type === 'radio') {
        const selected = d.options[d.members.findIndex((m) => m.checked)];
        if (selected) return selected;
        const sibling =
          d.name &&
          all(doc, 'input[type="radio"]:checked').find((m) => m.name === d.name && m.form === el.form);
        return sibling ? 'Already selected' : '';
      }
      if (d.type === 'yesno') return text(d.members.find((m) => attr(m, 'aria-pressed') === 'true'));
      if (d.type === 'checkbox') return (d.members || [el]).some((m) => m.checked) ? 'Checked' : '';
      if (d.type === 'select') return el.value ? text(d.members.find((o) => o.selected)) || el.value : '';
      if (d.type === 'combo') {
        const selected =
          el
            .closest('.select__control')
            ?.querySelector('.select__single-value,.select__multi-value,[class*="-singleValue"]') ||
          d.box?.querySelector('[data-automation-id="selectedItem"],[data-automation-id="selectedItemList"]');
        const value = text(selected) || el.value || (el.matches('button,[role="button"]') ? text(el) : '');
        return placeholder(value) ? '' : value;
      }
      return el.value || '';
    }
    // The answer the user gave, for the answer bank: only an option of this
    // control itself (never the "Already selected" stand-in), never a file.
    function answer(d) {
      if (d.type === 'file' || d.type === 'checkbox') return '';
      if (d.type === 'radio') return d.options[d.members.findIndex((m) => m.checked)] || '';
      return F.clean(read(d));
    }
    // Final-value check: React forms can revert a programmatic value on the
    // next render, so a field counts as filled only if it still holds it.
    function holds(d, values) {
      if (d.type === 'file') {
        if (d.el.isConnected && read(d)) return true;
        // Greenhouse swaps the input for an upload widget, then a file chip.
        const box = d.box?.isConnected && d.box;
        return (
          !!box &&
          (!!box.querySelector('[role="progressbar"]') || values.some((v) => v && text(box).includes(v)))
        );
      }
      if (!d.el.isConnected) return false;
      if (placeSearch(d)) return F.pickPlace([read(d)], values[0]) === 0;
      if (datePicker(d.el)) return !!values[0] && read(d) === F.usDate(values[0]);
      const value = read(d);
      if (d.members || d.type === 'combo') return F.pick([value], values) === 0;
      return value === values[0];
    }
    function available(d) {
      return (
        visible(d.anchor) &&
        d.el.isConnected &&
        inScope(d.el) &&
        !d.el.disabled &&
        !d.el.closest(captcha) &&
        (!d.el.readOnly || d.type === 'combo') &&
        !['password', 'hidden', 'submit'].includes(typeOf(d.el)) &&
        !read(d)
      );
    }
    function menuFor(el) {
      const owned = doc.getElementById(attr(el, 'aria-controls') || attr(el, 'aria-owns'));
      if (owned) return owned;
      const nearby = el
        .closest('.select-shell,[data-automation-id^="formField"]')
        ?.querySelector('[role="listbox"]');
      return nearby || null;
    }
    async function combo(d, values, active) {
      const el = d.el;
      if (!safeButton(el) || !available(d)) return false;
      const before = new Set(all(doc, '[role="listbox"]').filter(visible));
      if (el.localName === 'button' || ats === 'workday') el.click();
      else if (el.matches('.select__input')) {
        for (const type of ['mousedown', 'mouseup', 'click']) {
          el.dispatchEvent(
            new doc.defaultView.MouseEvent(type, {
              button: 0,
              bubbles: true,
              cancelable: true,
              view: doc.defaultView,
            })
          );
        }
      } else {
        el.focus();
        const win = doc.defaultView;
        el.dispatchEvent(
          new win.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true })
        );
      }
      try {
        for (let n = 0; n < 12; n++) {
          let menu = menuFor(el);
          if (!menu && ats === 'workday' && attr(el, 'aria-expanded') === 'true') {
            const added = all(doc, '[role="listbox"]').filter((m) => !before.has(m) && visible(m));
            if (added.length === 1) menu = added[0];
          }
          if (!active()) return false;
          if (menu && available(d)) {
            const options = all(menu, '[role="option"]').filter((o) => visible(o) && safeButton(o));
            const index = F.pick(options.map(text), values);
            if (index >= 0) {
              options[index].click();
              await pause(35);
              return F.pick([read(d)], values) === 0;
            }
          }
          await pause(35);
        }
        return false;
      } finally {
        if (el.isConnected && attr(el, 'aria-expanded') === 'true') {
          el.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          el.blur();
        }
      }
    }
    async function search(d, values, active) {
      const el = d.el,
        win = doc.defaultView,
        value = values[0],
        query = F.placeQuery(value);
      if (!query || !available(d)) return false;
      const type = (v) => {
        nativeSet(el, 'value', v);
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
      };
      // react-select (Greenhouse) only opens its menu from a mouse press.
      if (el.matches('.select__input')) {
        for (const kind of ['mousedown', 'mouseup', 'click'])
          el.dispatchEvent(new win.MouseEvent(kind, { button: 0, bubbles: true, cancelable: true, view: win }));
      }
      el.focus();
      type(query);
      let picked = false;
      try {
        // Suggestions come from the ATS's server: allow ~3 s, and let a list
        // left over from an earlier query be replaced before giving up.
        for (let n = 0; n < 60; n++) {
          await pause(50);
          if (!active() || !el.isConnected) return false;
          const menu = menuFor(el);
          const options = menu ? all(menu, '[role="option"]').filter((o) => visible(o) && safeButton(o)) : [];
          const index = F.pickPlace(options.map(text), value);
          if (index < 0) continue;
          options[index].click();
          await pause(50);
          picked = F.pickPlace([read(d)], value) === 0;
          return picked;
        }
        return false;
      } finally {
        if (el.isConnected && attr(el, 'aria-expanded') === 'true')
          el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        // Don't leave a half-typed city behind for the user to notice.
        if (!picked && el.isConnected && el.value === query) type('');
        el.blur();
      }
    }
    async function write(d, values, getFile, active = () => true) {
      if (!active() || !available(d)) return false;
      const kind = F.classify(d).kind;
      if (kind === 'protected' || kind === 'manual') return false;
      if (kind === 'resume') {
        if (!getFile) return false;
        const file = await getFile();
        if (!active() || !available(d)) return false;
        const transfer = new doc.defaultView.DataTransfer();
        transfer.items.add(file);
        nativeSet(d.el, 'files', transfer.files);
        changed(d.el);
        return true;
      }
      if (!values.length) return false;
      if (placeSearch(d)) return search(d, values, active);
      if (d.type === 'combo') return combo(d, values, active);
      if (d.members) {
        const i = F.pick(d.options, values),
          m = d.members[i];
        if (!m?.isConnected || m.disabled || attr(m, 'aria-disabled') === 'true') return false;
        if (d.type === 'select') {
          if (d.el.multiple || !d.el.contains(m) || !m.value || F.pick([text(m)], values) !== 0) return false;
          nativeSet(d.el, 'value', m.value);
          changed(d.el);
        } else if (safeButton(m)) m.click();
        else return false;
        await pause(0);
        return F.pick([read(d)], values) === 0;
      }
      // A text search box can look filled even when the ATS needs a location ID.
      if (d.el.matches('[aria-autocomplete="list"],.location-input')) return false;
      if (datePicker(d.el)) {
        const shown = F.usDate(values[0]);
        if (!shown) return false;
        const win = doc.defaultView;
        d.el.focus();
        nativeSet(d.el, 'value', shown);
        d.el.dispatchEvent(new win.Event('input', { bubbles: true }));
        await pause(50);
        d.el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        d.el.blur();
        return d.el.value === shown;
      }
      nativeSet(d.el, 'value', values[0]);
      changed(d.el);
      return d.el.value === values[0];
    }
    async function expand(profile, active = () => true) {
      for (const section of Object.keys(sections)) {
        const target = Math.min(profile[section]?.length || 0, 30);
        for (let n = rows(section).length; n < target; n++) {
          const area = sectionFor(section);
          if (!active() || !area || !visible(area)) break;
          const buttons = all(area, 'button').filter(
            (b) =>
              visible(b) &&
              safeButton(b) &&
              /^add(?: another)?(?: education| work experience| experience)?$/i.test(text(b))
          );
          if (buttons.length !== 1 || !(inScope(buttons[0]) || all(area, controls).some(inScope))) break;
          buttons[0].click();
          for (let attempt = 0; rows(section).length === n && attempt < 10; attempt++) await pause(40);
          if (rows(section).length !== n + 1) break;
        }
      }
    }
    return { collect, read, write, expand, available, answer, holds };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutofillAdapters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
