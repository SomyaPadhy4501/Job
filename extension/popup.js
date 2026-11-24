const $ = (id) => document.getElementById(id);
const defaults = { enabled: true, portalUrl: 'https://job-two-xi.vercel.app', token: '', boards: [], autoOpen: true, autoEveryHours: 3, autoClose: true, allowSensitive: false, lastRunAt: '', log: [] };

function renderLog(log) {
  if (!log.length) return;
  $('log').replaceChildren(
    ...log.map((e) => {
      const d = document.createElement('div');
      const when = new Date(e.at).toLocaleString();
      d.textContent = e.note
        ? `${when} · ${e.host} · ${e.found} boards opened`
        : e.error
        ? `${when} · ${e.host} · ${e.found} found · ${e.error}`
        : `${when} · ${e.host} · ${e.found} found → ${e.inserted} new, ${e.updated} updated, ${e.rejected} filtered` +
          (e.sample ? ` (e.g. ${e.sample})` : '');
      d.className = e.error ? 'bad' : 'ok';
      return d;
    })
  );
}

chrome.storage.local.get(defaults).then((s) => {
  $('enabled').checked = s.enabled;
  $('portalUrl').value = s.portalUrl;
  $('token').value = s.token;
  $('boards').value = s.boards.join('\n');
  $('autoOpen').checked = s.autoOpen;
  $('autoEveryHours').value = s.autoEveryHours;
  $('autoClose').checked = s.autoClose;
  $('allowSensitive').checked = s.allowSensitive;
  $('lastRun').textContent = s.lastRunAt
    ? `Last automatic run: ${new Date(s.lastRunAt).toLocaleString()}`
    : 'Automatic run has not happened yet.';
  if (!s.token) $('lastRun').textContent = 'Add your collect token, then Save, to start the daily run.';
  renderLog(s.log);
});

$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));

$('save').addEventListener('click', async () => {
  // LinkedIn / Indeed / Glassdoor can't be scheduled boards — see extract.js.
  const boards = $('boards').value.split('\n').map((x) => x.trim())
    .filter((x) => /^https?:\/\//.test(x) && !/(linkedin|indeed|glassdoor)\.com/i.test(x));
  await chrome.storage.local.set({
    portalUrl: $('portalUrl').value.trim().replace(/\/+$/, ''),
    token: $('token').value.trim(),
    boards,
    autoOpen: $('autoOpen').checked,
    autoEveryHours: Math.min(24, Math.max(1, Number($('autoEveryHours').value) || 3)),
    autoClose: $('autoClose').checked,
    allowSensitive: $('allowSensitive').checked,
  });
  $('save').textContent = 'Saved';
  showConnection();
  setTimeout(() => ($('save').textContent = 'Save'), 1200);
});

$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openBoards' }));

chrome.storage.onChanged.addListener((c) => c.log && renderLog(c.log.newValue || []));

async function autofill(type, params) {
  const response = await chrome.runtime.sendMessage({type:'autofill:' + type, ...params});
  if (!response?.ok) throw new Error(response?.error || 'Could not reach the service worker.');
  return response.data;
}
async function showConnection() {
  const picker = $('defaultResume');
  picker.replaceChildren(new Option('Account default',''));
  picker.disabled = true;
  try {
    const data = await autofill('getProfile');
    const {autofillDefault} = await chrome.storage.local.get('autofillDefault');
    for (const resume of data.resumes) picker.add(new Option(resume.title || resume.fileName,resume.id));
    picker.value = data.resumes.some(r => r.id === autofillDefault) ? autofillDefault : '';
    picker.disabled = false;
    $('account').textContent = 'Connected as ' + data.user.email;
  } catch (err) { $('account').textContent = err.message; }
}
async function configure(token) {
  try {
    // Connecting saves the job board address too: one button, no separate Save.
    const portal = $('portalUrl').value.trim().replace(/\/+$/, '');
    if (token) {
      if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(portal)) throw new Error('Enter the job board address (https://…).');
      await chrome.storage.local.set({ portalUrl: portal });
    }
    await autofill('configure',{token});
    await chrome.storage.local.remove('autofillDefault');
    $('autofillToken').value = '';
    await showConnection();
  } catch (err) { $('account').textContent = err.message; }
}
$('connect').onclick = () => {
  const token = $('autofillToken').value.trim();
  if (token) configure(token);
};
$('disconnect').onclick = () => configure('');
$('defaultResume').onchange = () => chrome.storage.local.set({autofillDefault:$('defaultResume').value});
showConnection();

// ─── Autofill on any site ──────────────────────────────────────────────────
// The four ATS hosts are in the manifest. Any other site needs your OK once
// (an optional host permission for that site only); after that the Autofill
// button appears there by itself, from a registered content script.
const FILES = ['autofill-fields.js', 'autofill-adapters.js', 'autofill.js'];
const scriptId = (pattern) => 'autofill-' + pattern.replace(/[^a-z0-9]+/gi, '-');
const builtIn = new Set(
  (chrome.runtime.getManifest().host_permissions || []).concat(
    ...chrome.runtime.getManifest().content_scripts.flatMap((c) => (c.js.includes('autofill.js') ? [c.matches] : []))
  )
);
let pendingFrames = [];

async function remember(patterns) {
  const existing = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));
  const fresh = patterns.filter((p) => !existing.has(scriptId(p)));
  if (fresh.length) {
    await chrome.scripting.registerContentScripts(
      fresh.map((p) => ({ id: scriptId(p), matches: [p], js: FILES, allFrames: true, runAt: 'document_idle' }))
    );
  }
}

async function openOnPage(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      globalThis.__jobAutofillOpen = true;
    },
  });
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: FILES });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\//.test(tab.url || '')) throw new Error('Open the application form (an https:// page) first.');
  return tab;
}

$('fillPage').onclick = async () => {
  $('allowFrames').hidden = true;
  try {
    const tab = await activeTab();
    const pattern = new URL(tab.url).origin + '/*';
    // Asked first, while the click still counts as your gesture.
    if (!(await chrome.permissions.request({ origins: [pattern] }))) {
      $('fillStatus').textContent = 'Not allowed, so nothing was changed on this site.';
      return;
    }
    await remember([pattern]);
    // Forms embedded from another site (an ATS iframe) need that site too.
    const [{ result: frames = [] } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        [...document.querySelectorAll('iframe[src]')]
          .map((f) => {
            try {
              return new URL(f.src, location.href).origin;
            } catch {
              return '';
            }
          })
          .filter((o) => o.startsWith('https://')),
    });
    pendingFrames = [];
    const knownAts = (host) =>
      /(?:^|\.)(?:myworkdayjobs|myworkdaysite)\.com$/.test(host) ||
      ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com'].includes(host);
    for (const origin of new Set(frames)) {
      if (knownAts(new URL(origin).hostname)) continue;
      const p = origin + '/*';
      if (!builtIn.has(p) && !(await chrome.permissions.contains({ origins: [p] }))) pendingFrames.push(p);
    }
    await openOnPage(tab.id);
    if (pendingFrames.length) {
      const hosts = pendingFrames.map((p) => new URL(p.replace('/*', '')).hostname).join(', ');
      $('allowFrames').textContent = 'Also allow the embedded form (' + hosts + ')';
      $('allowFrames').hidden = false;
      $('fillStatus').textContent = 'Opened Autofill. Part of this page comes from another site; allow it too if the form is there.';
    } else {
      $('fillStatus').textContent = 'Opened Autofill on the page: pick the resume, then press "Fill this page". Nothing is ever submitted for you.';
    }
    showSites();
  } catch (err) {
    $('fillStatus').textContent = err.message;
  }
};

$('allowFrames').onclick = async () => {
  try {
    if (!(await chrome.permissions.request({ origins: pendingFrames }))) return;
    await remember(pendingFrames);
    $('allowFrames').hidden = true;
    await openOnPage((await activeTab()).id);
    $('fillStatus').textContent = 'Opened Autofill on the embedded form too.';
    showSites();
  } catch (err) {
    $('fillStatus').textContent = err.message;
  }
};

async function showSites() {
  const { origins = [] } = await chrome.permissions.getAll();
  const mine = origins.filter((o) => !builtIn.has(o) && o.startsWith('https://') && o !== 'https://*/*');
  $('sitesBox').hidden = !mine.length;
  $('sites').replaceChildren(
    ...mine.map((pattern) => {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = pattern.replace(/^https:\/\//, '').replace(/\/\*$/, '');
      const remove = document.createElement('button');
      remove.textContent = 'Remove';
      remove.onclick = async () => {
        await chrome.scripting.unregisterContentScripts({ ids: [scriptId(pattern)] }).catch(() => {});
        await chrome.permissions.remove({ origins: [pattern] });
        showSites();
      };
      row.append(name, remove);
      return row;
    })
  );
}
showSites();

// "Share job listings I browse" (off until you turn it on).
chrome.storage.local.get({ shareListings: false }).then(({ shareListings }) => {
  $('shareListings').checked = shareListings;
});
$('shareListings').onchange = () => chrome.storage.local.set({ shareListings: $('shareListings').checked });
