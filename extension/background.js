// Service worker: de-duplicates captured rows, posts them to the portal's
// /admin/ingest in batches, keeps a short capture log for the popup, and opens
// the saved boards once a day.
importScripts('schedule.js', 'application-pages.js', 'gmail.js', 'autofill-api.js', 'updates.js', 'workday-collect.js');

// The toolbar icon opens the extension in Chrome's side panel (docked on the
// right, and it stays open while you switch tabs) instead of a popup.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const BATCH = 500;          // rows per request, at most…
const BATCH_BYTES = 2_500_000; // …and bytes: Vercel rejects bodies over ~4.5 MB
                               // (HTTP 413 — Wayfair's 432 rows with full
                               // descriptions did that in one batch)
const SOURCE = 'extension'; // shows up as its own source in the board's filter
const LOG_MAX = 30;

// Daily run. Opens the saved boards once per day — the same visit a person
// would make by hand, in an ordinary (unfocused) window. It never clicks,
// pages or follows links; each page captures only what it loads by itself.
const MAX_BOARDS = 25;      // one visit per site per day, not a crawl
const STAGGER_MS = 4000;    // gap between opening each board
const CHECK_MINUTES = 15;   // periodic re-check, catches wake-from-sleep
const CLOSE_AFTER_MS = 3000; // after a tab's jobs are sent, in case a late batch follows
const FALLBACK_CLOSE_MIN = 3; // closes whatever is left (pages that found nothing)

// Starter boards: sites only a real browser can read. Everything the server
// can collect runs in GitHub Actions instead, computer on or off. On
// 2026-11-23 the Phenom sites (Fiserv, Truist, Southwest, Asurion, Blue
// Yonder, WBD, Blizzard, Bose) moved to their Workday boards, AmEx, Nokia and
// Navy Federal to oracle_hcm, Rivian to the Jibe collector, and Apple, Chewy,
// Cigna, Thermo Fisher and CarGurus already had collectors. Left here:
//   Tesla, Wayfair  block every automated client; captured from a real browser
//   Yelp            iCIMS, no collector
//   Corning         its search API hides the apply link
//   AutoZone        Oracle, but its tech roles sit behind ~500 store postings,
//                   past what oracle_hcm reads; the page's keyword search finds them
// An existing install keeps the boards it already saved; remove the moved ones
// in the popup to stop opening them.
const STARTER_BOARDS = [
    'https://www.tesla.com/careers/search/?country=US',
    'https://www.wayfair.com/careers/jobs',
    'https://www.yelp.careers/us/en/search-results?keywords=software%20engineer',
    'https://careers.corning.com/us/en/search-results?keywords=software%20engineer',
    'https://careers.autozone.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs?keyword=software',
];

const defaults = {
  enabled: true,
  portalUrl: 'https://job-two-xi.vercel.app',
  token: '',
  boards: null, // filled from STARTER_BOARDS
  offeredBoards: [],
  autoOpen: true,
  autoEveryHours: 3,
  autoClose: true,
  allowSensitive: false,
  lastRunAt: '',
  log: [],
  // Workday collection (workday-collect.js): off until the owner turns it on
  // in the popup, which also asks Chrome for access to *.myworkdayjobs.com.
  workdayEnabled: false,
  workdayEveryHours: 6,
  workdayLastRunAt: '',
};
const WORKDAY_ORIGINS = ['https://*.myworkdayjobs.com/*'];
const getSettings = () => chrome.storage.local.get(defaults);

// Same posting seen twice in one browser session (page re-render, second XHR)
// is sent once. Cleared when the worker restarts, which is fine — the server
// upserts, so a resend only refreshes last_seen_at.
const sentIds = new Set();

async function postBatch(portalUrl, token, jobs, source = SOURCE) {
  const res = await fetch(new URL('/admin/ingest', portalUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-collect-token': token },
    body: JSON.stringify({ source, jobs }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Split by row count and by serialized size, whichever limit comes first.
function batches(rows) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length;
    if (cur.length && (cur.length >= BATCH || bytes + n > BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function addLog(entry) {
  const { log } = await chrome.storage.local.get({ log: [] });
  log.unshift({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, LOG_MAX) });
}

async function handleJobs(msg, tabId) {
  const s = await getSettings();
  if (!s.enabled) return;
  const fresh = msg.rows.filter((r) => !sentIds.has(r.external_id));
  if (!fresh.length) return;
  const host = new URL(msg.pageUrl).hostname;

  if (!s.portalUrl || !s.token) {
    // Not the owner: share with the board through the user's own extension
    // token, if they opted in (the content script only sends rows then).
    const { shareListings } = await chrome.storage.local.get({ shareListings: false });
    if (!shareListings || isSensitiveUrl(msg.pageUrl)) return;
    try {
      const r = await globalThis.AutofillShare(msg.pageUrl, fresh);
      fresh.forEach((row) => sentIds.add(row.external_id));
      await addLog({ host, found: fresh.length, inserted: r.inserted, updated: r.updated, rejected: r.rejected + r.refused, shared: true });
      if (tabId != null) {
        chrome.action.setBadgeBackgroundColor({ color: '#1a7f37', tabId });
        chrome.action.setBadgeText({ text: String(r.inserted + r.updated), tabId });
      }
    } catch (err) {
      await addLog({ host, found: fresh.length, error: err.message, shared: true });
    }
    return;
  }

  let inserted = 0, updated = 0, rejected = 0;
  try {
    for (const batch of batches(fresh)) {
      const r = await postBatch(s.portalUrl, s.token, batch);
      inserted += r.inserted || 0;
      updated += r.updated || 0;
      rejected += r.rejected || 0;
    }
    fresh.forEach((r) => sentIds.add(r.external_id));
    // When nothing survived the server's filters, keep one example so the log
    // shows WHY — a title or location the extractor got wrong is obvious here.
    const sample = inserted + updated === 0 && fresh.length
      ? `${fresh[0].job_title} | ${fresh[0].location}`
      : undefined;
    await addLog({ host, found: fresh.length, inserted, updated, rejected, sample });
    if (tabId != null) {
      chrome.action.setBadgeBackgroundColor({ color: '#1a7f37', tabId });
      chrome.action.setBadgeText({ text: String(inserted + updated), tabId });
    }
  } catch (err) {
    await addLog({ host, found: fresh.length, error: err.message });
    if (tabId != null) {
      chrome.action.setBadgeBackgroundColor({ color: '#cf222e', tabId });
      chrome.action.setBadgeText({ text: '!', tabId });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isSensitiveUrl = (u) => {
  try { return /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com)$/i.test(new URL(u).hostname); } catch { return false; }
};

// Opens the boards in their own unfocused window, one every few seconds, then
// closes that window once the last page has had time to report.
async function openBoards({ scheduled }) {
  const s = await getSettings();
  // Never open LinkedIn / Indeed / Glassdoor on a schedule (see extract.js).
  const boards = (s.boards || []).filter((u) => !isSensitiveUrl(u)).slice(0, MAX_BOARDS);
  if (!boards.length) return;
  // Without the collect token (or opted-in sharing) the pages capture
  // nothing, so opening them only looked like a run: on 2026-11-24 the log
  // said "5 boards opened" for days while no Tesla row reached the board.
  const { shareListings } = await chrome.storage.local.get({ shareListings: false });
  if (!s.token && !shareListings) {
    await addLog({
      host: scheduled ? 'scheduled run' : 'manual run',
      found: 0,
      error: 'nothing would be sent. Turn on “Share job listings I browse” and connect your account',
    });
    return;
  }
  if (scheduled) await chrome.storage.local.set({ lastRunAt: new Date().toISOString() });

  const win = await chrome.windows.create({ url: boards[0], focused: false, state: 'normal' });
  await chrome.storage.local.set({ boardsWindowId: win.id, autoCloseRun: !!s.autoClose });
  for (const url of boards.slice(1)) {
    await sleep(STAGGER_MS);
    await chrome.tabs.create({ windowId: win.id, url, active: false }).catch(() => {});
  }
  await addLog({ host: scheduled ? 'scheduled run' : 'manual run', found: boards.length, inserted: 0, updated: 0, rejected: 0, note: 'boards opened' });

  // Safety net for tabs that never report (no jobs found, page blocked).
  // An alarm, not a timer: Chrome stops an idle service worker after ~30 s,
  // and a setTimeout dies with it — the window used to stay open that way.
  if (s.autoClose) chrome.alarms.create('closeBoards', { delayInMinutes: FALLBACK_CLOSE_MIN });
}

// Graceful close: a board's tab goes as soon as its jobs are sent, so the
// window empties as captures finish, and Chrome closes it with the last tab.
async function closeTabIfBoard(tabId) {
  const { boardsWindowId, autoCloseRun } = await chrome.storage.local.get(['boardsWindowId', 'autoCloseRun']);
  if (!autoCloseRun || boardsWindowId == null || tabId == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.windowId !== boardsWindowId) return; // a tab the user opened — leave it
  await sleep(CLOSE_AFTER_MS);
  await chrome.tabs.remove(tabId).catch(() => {});
}

async function closeBoardsWindow() {
  const { boardsWindowId } = await chrome.storage.local.get('boardsWindowId');
  if (boardsWindowId == null) return;
  await chrome.windows.remove(boardsWindowId).catch(() => {}); // already closed
  await chrome.storage.local.remove(['boardsWindowId', 'autoCloseRun']);
}

chrome.windows.onRemoved.addListener(async (id) => {
  const { boardsWindowId } = await chrome.storage.local.get('boardsWindowId');
  if (id === boardsWindowId) await chrome.storage.local.remove(['boardsWindowId', 'autoCloseRun']);
});

// ── Workday collection ──────────────────────────────────────────────────────
// A run is worked through by a one-minute alarm, a slice at a time
// (workday-collect.js says why); the alarm goes once the run ends.
function workdayDeps(s) {
  return {
    storage: chrome.storage.local,
    fetch: (...a) => fetch(...a),
    sleep,
    clock: () => Date.now(),
    tenantsUrl: new URL('/downloads/workday-tenants.json', s.portalUrl).toString(),
    post: async (rows) => {
      const total = { inserted: 0, updated: 0, rejected: 0 };
      // An older install with the collect token still posts directly.
      if (s.token) {
        for (const batch of batches(rows)) {
          const r = await postBatch(s.portalUrl, s.token, batch, 'workday');
          for (const k of Object.keys(total)) total[k] += r[k] || 0;
        }
        return total;
      }
      // Otherwise through the connected account: the server checks it and
      // forwards the rows as Workday's. One employer's site per request
      // (AutofillShare splits it to the route's limits).
      const bySite = new Map();
      for (const row of rows) {
        const site = new URL(row.apply_url).origin + '/';
        if (!bySite.has(site)) bySite.set(site, []);
        bySite.get(site).push(row);
      }
      for (const [site, list] of bySite) {
        const r = await globalThis.AutofillShare(site, list);
        total.inserted += r.inserted || 0;
        total.updated += r.updated || 0;
        total.rejected += (r.rejected || 0) + (r.refused || 0);
      }
      return total;
    },
  };
}

async function startWorkday() {
  const s = await getSettings();
  if (!s.token && !(await globalThis.AutofillShareReady())) throw new Error('Connect your account in the popup first.');
  if (!(await chrome.permissions.contains({ origins: WORKDAY_ORIGINS }))) throw new Error('Allow Workday access in the popup first.');
  const { workdayRun } = await chrome.storage.local.get('workdayRun');
  if (!workdayRun) await WorkdayCollect.start(workdayDeps(s));
  chrome.alarms.create('workdayTick', { periodInMinutes: 1 });
  await workdayTick();
}

async function workdayTick() {
  const s = await getSettings();
  const result = await WorkdayCollect.tick(workdayDeps(s));
  if (result.idle || result.done) chrome.alarms.clear('workdayTick');
  if (result.done) {
    const r = result.summary;
    await addLog({
      host: 'Workday',
      found: r.found,
      inserted: r.inserted,
      updated: r.updated,
      rejected: r.rejected,
      ...(r.stoppedFor ? { error: `stopped after ${r.index} of ${r.total} employers: ${r.stoppedFor}` } : {}),
    });
  }
}

// Called on startup, on install, and by the periodic alarm. Runs when the
// interval has passed — including straight after the machine wakes or Chrome
// starts, if it was off when a run was due.
async function checkSchedule() {
  const s = await getSettings();
  // Workday sends through the connected account (or an older install's
  // collect token); without either it waits quietly instead of logging an
  // error every 15 minutes.
  if (s.enabled && s.workdayEnabled && (s.token || (await globalThis.AutofillShareReady()))) {
    const { workdayRun } = await chrome.storage.local.get('workdayRun');
    if (workdayRun) chrome.alarms.create('workdayTick', { periodInMinutes: 1 }); // resume after a restart
    else if (JobSchedule.isDueEvery(new Date(), s.workdayLastRunAt, s.workdayEveryHours)) {
      await startWorkday().catch((err) => addLog({ host: 'Workday', found: 0, error: err.message }));
    }
  }
  // The boards' pages send through "Share job listings I browse" (or the
  // collect token), as openBoards checks.
  const { shareListings } = await chrome.storage.local.get({ shareListings: false });
  if (!s.enabled || !s.autoOpen || !(s.token || shareListings)) return;
  const { boardsWindowId } = await chrome.storage.local.get('boardsWindowId');
  if (boardsWindowId != null) return; // a run is still in progress
  if (JobSchedule.isDueEvery(new Date(), s.lastRunAt, s.autoEveryHours)) await openBoards({ scheduled: true });
}

async function scheduleAlarms() {
  await chrome.alarms.clear('daily'); // pre-1.5 daily alarm
  await chrome.alarms.clear('check');
  chrome.alarms.create('check', { periodInMinutes: CHECK_MINUTES, delayInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'closeBoards') return closeBoardsWindow();
  if (a.name === 'workdayTick') return workdayTick();
  if (a.name !== 'check') return; // updates.js handles its own alarms
  return checkSchedule();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  await checkSchedule();
});

chrome.runtime.onInstalled.addListener(async () => {
  // Write defaults for anything unset so the popup shows them, and merge in
  // starter boards added since the user's last update. Defaults only apply to
  // unset keys, so before this an existing install never got new ones (Apple
  // was missing after the 1.6 update). A board the user deleted stays deleted:
  // only boards never offered before are added.
  const s = await getSettings();
  const offered = new Set(s.offeredBoards || []);
  const current = Array.isArray(s.boards) ? s.boards : [];
  const added = STARTER_BOARDS.filter((u) => !offered.has(u) && !current.includes(u));
  await chrome.storage.local.set({
    ...s,
    boards: [...current, ...added],
    offeredBoards: [...new Set([...offered, ...STARTER_BOARDS, ...current])],
  });
  await scheduleAlarms();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'jobs' && sender.url && !JobApplicationPages.privatePage(sender.url) && !JobApplicationPages.privatePage(msg.pageUrl)) {
    handleJobs(msg, sender.tab?.id).finally(() => closeTabIfBoard(sender.tab?.id));
  }
  if (msg?.type === 'openBoards') openBoards({ scheduled: false });
  if (msg?.type === 'workdayRunNow' && sender.id === chrome.runtime.id) {
    startWorkday().catch((err) => addLog({ host: 'Workday', found: 0, error: err.message }));
  }
});

// A site removed in Chrome's extension settings (or from the popup) also
// loses its registered Autofill script.
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  const ids = origins.map((p) => 'autofill-' + p.replace(/[^a-z0-9]+/gi, '-'));
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids }).catch(() => {});
});

// The popup asks for a fresh update check when it opens.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'checkUpdate' || sender.id !== chrome.runtime.id) return;
  ExtensionUpdates.check().then(
    (version) => reply({ version, running: ExtensionUpdates.running }),
    () => reply({ version: null, running: ExtensionUpdates.running })
  );
  return true;
});
