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
  $('boards').value = s.boards.join('\n');
  $('autoOpen').checked = s.autoOpen;
  $('autoEveryHours').value = s.autoEveryHours;
  $('autoClose').checked = s.autoClose;
  $('allowSensitive').checked = s.allowSensitive;
  $('lastRun').textContent = s.lastRunAt
    ? `Last automatic run: ${new Date(s.lastRunAt).toLocaleString()}`
    : 'Automatic run has not happened yet.';
  renderLog(s.log);
  showReach();
});

// Captured listings reach the board through the connected account and "Share
// job listings I browse" (older installs: a saved collect token). Say when
// they can't, so a run doesn't only look like it worked.
async function showReach() {
  const { token, shareListings } = await chrome.storage.local.get({ token: '', shareListings: false });
  if (token) return;
  const connected = await autofill('getProfile').then(() => true, () => false);
  const missing = [!connected && 'connect your account above', !shareListings && 'turn on “Share job listings I browse”'].filter(Boolean);
  $('lastRun').style.color = missing.length ? '#cf222e' : '';
  if (missing.length) $('lastRun').textContent = 'Captured jobs can’t reach the board yet: ' + missing.join(' and ') + '.';
}

$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));

$('save').addEventListener('click', async () => {
  // LinkedIn / Indeed / Glassdoor can't be scheduled boards — see extract.js.
  const boards = $('boards').value.split('\n').map((x) => x.trim())
    .filter((x) => /^https?:\/\//.test(x) && !/(linkedin|indeed|glassdoor)\.com/i.test(x));
  await chrome.storage.local.set({
    portalUrl: $('portalUrl').value.trim().replace(/\/+$/, ''),
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

// Workday collection (workday-collect.js). Turning it on asks Chrome for
// access to *.myworkdayjobs.com; it needs a click, so it's asked here.
const WORKDAY_ORIGINS = ['https://*.myworkdayjobs.com/*'];
function showWorkday({ workdayEnabled, workdayRun, workdayLast }) {
  $('workdayEnabled').checked = !!workdayEnabled;
  let text = '';
  if (workdayRun) text = `Workday: reading employer ${workdayRun.index + 1} of ${workdayRun.tenants.length}, ${workdayRun.found} jobs so far.`;
  else if (workdayLast) {
    const when = new Date(workdayLast.finishedAt).toLocaleString();
    text = `Last Workday run ${when}: ${workdayLast.ok} of ${workdayLast.total} employers, ${workdayLast.found} jobs (${workdayLast.inserted} new).` +
      (workdayLast.stoppedFor ? ` Stopped early: ${workdayLast.stoppedFor}.` : '');
  }
  $('workdayStatus').textContent = text;
}
chrome.storage.local.get({ workdayEnabled: false, workdayRun: null, workdayLast: null }).then(showWorkday);
chrome.storage.onChanged.addListener((c) => {
  if (c.workdayRun || c.workdayLast || c.workdayEnabled) {
    chrome.storage.local.get({ workdayEnabled: false, workdayRun: null, workdayLast: null }).then(showWorkday);
  }
});
$('workdayEnabled').addEventListener('change', async () => {
  const on = $('workdayEnabled').checked;
  if (on && !(await chrome.permissions.request({ origins: WORKDAY_ORIGINS }))) {
    $('workdayEnabled').checked = false;
    $('workdayStatus').textContent = 'Workday collection needs access to myworkdayjobs.com.';
    return;
  }
  await chrome.storage.local.set({ workdayEnabled: on });
});
$('workdayNow').addEventListener('click', async () => {
  // The rows go through the connected account; say so here instead of
  // "starting…" when it isn't connected.
  const { token } = await chrome.storage.local.get({ token: '' });
  if (!token && !(await autofill('getProfile').then(() => true, () => false))) {
    $('workdayStatus').textContent = 'Connect your account above first (paste the token from the job board’s Extension page, then Connect).';
    return;
  }
  if (!(await chrome.permissions.request({ origins: WORKDAY_ORIGINS }))) {
    $('workdayStatus').textContent = 'Workday collection needs access to myworkdayjobs.com.';
    return;
  }
  chrome.runtime.sendMessage({ type: 'workdayRunNow' });
  $('workdayStatus').textContent = 'Workday: starting…';
});

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
  showReach();
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
    showGmail();
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
$('shareListings').onchange = async () => {
  await chrome.storage.local.set({ shareListings: $('shareListings').checked });
  showReach();
};

// "Job site password": kept in the service worker's storage only.
async function showSitePassword(message) {
  try {
    const { set, updatedAt } = await autofill('sitePasswordStatus');
    $('sitePasswordState').textContent =
      message || (set ? 'Saved' + (updatedAt ? ' on ' + new Date(updatedAt).toLocaleDateString() : '') + '.' : 'Not set: Workday sign-in is left to you.');
  } catch (err) {
    $('sitePasswordState').textContent = err.message;
  }
}
$('saveSitePassword').onclick = async () => {
  const a = $('sitePassword').value,
    b = $('sitePassword2').value;
  if (!a) return showSitePassword('Type a password first.');
  if (a !== b) return showSitePassword("The two passwords don't match.");
  try {
    await autofill('setSitePassword', { password: a });
    $('sitePassword').value = $('sitePassword2').value = '';
    $('sitePassword').type = $('sitePassword2').type = 'password';
    showSitePassword('Saved. Workday sign-in pages will use it.');
  } catch (err) {
    showSitePassword(err.message);
  }
};
$('generateSitePassword').onclick = () => {
  // 20 characters from each class, shuffled; shown so it can be saved elsewhere too.
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+?'];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const chars = [...sets.map(pick), ...Array.from({ length: 16 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  $('sitePassword').value = $('sitePassword2').value = chars.join('');
  $('sitePassword').type = 'text';
  showSitePassword('Generated. Copy it somewhere safe (a password manager), then click Save.');
};
$('clearSitePassword').onclick = async () => {
  await autofill('setSitePassword', { password: '' }).catch(() => {});
  showSitePassword('Removed.');
};
showSitePassword();

// "Codes from Gmail": shown when the connected portal offers the Gmail
// connector. Connecting and disconnecting happen on the portal.
async function showGmail() {
  try {
    const { available, connected, email } = await autofill('gmailStatus');
    $('gmailCard').hidden = !available;
    $('gmailState').textContent = connected ? 'Connected: ' + email : 'Not connected. Connect Gmail on the job board.';
    $('gmailManage').textContent = connected ? 'Manage in Connectors' : 'Connect in Connectors';
  } catch {
    // No account connected here yet, or an older portal: nothing to show.
    $('gmailCard').hidden = true;
  }
}
$('gmailManage').onclick = async () => {
  const { portalUrl } = await chrome.storage.local.get({ portalUrl: defaults.portalUrl });
  const base = new URL(portalUrl);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) return;
  chrome.tabs.create({ url: base.origin + '/settings#connectors' });
};
showGmail();

// "Your apply queue": the next few jobs to apply to, read only. Hidden when
// the account isn't connected, the queue is empty, or the portal is older.
async function showQueue() {
  try {
    const { items } = await autofill('applyQueue');
    const list = $('queueList');
    list.replaceChildren();
    for (const item of (items || []).slice(0, 5)) {
      const li = document.createElement('li');
      const text = item.company + ' — ' + item.title;
      if (item.applyUrl) {
        const a = document.createElement('a');
        a.href = item.applyUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = text;
        li.append(a);
      } else {
        li.textContent = text;
      }
      if (item.status === 'prepared') li.append(' (ready for you)');
      if (item.status === 'needs_you') li.append(' (needs you)');
      list.append(li);
    }
    $('queueCard').hidden = !list.children.length;
  } catch {
    $('queueCard').hidden = true;
  }
}
showQueue();

// "Version X is available": the one-line command for this computer.
async function showUpdate() {
  const r = await chrome.runtime.sendMessage({ type: 'checkUpdate' }).catch(() => null);
  const { updateAvailable } = await chrome.storage.local.get('updateAvailable');
  const version = r?.version || updateAvailable?.version;
  if (!version) return;
  const portal = (updateAvailable?.portal || $('portalUrl').value || 'https://job-two-xi.vercel.app').replace(/\/+$/, '');
  const mac = /Mac/i.test(navigator.platform);
  $('updateVersion').textContent = version;
  $('updateCmd').textContent = mac
    ? `curl -fsSL ${portal}/update-extension.sh | bash`
    : `irm ${portal}/update-extension.ps1 | iex`;
  $('updateHow').textContent = mac
    ? 'Copy this, paste it into Terminal and press Return:'
    : 'Copy this, paste it into PowerShell (Start menu → type “PowerShell”) and press Enter:';
  $('updateCard').hidden = false;
}
$('updateCopy').onclick = async () => {
  await navigator.clipboard.writeText($('updateCmd').textContent);
  $('updateCopy').textContent = 'Copied';
  setTimeout(() => ($('updateCopy').textContent = 'Copy'), 1500);
};
showUpdate();
