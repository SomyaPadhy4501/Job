// Service worker: de-duplicates captured rows, posts them to the portal's
// /admin/ingest in batches, keeps a short capture log for the popup, and opens
// the saved boards once a day.
importScripts('schedule.js');

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

const defaults = {
  enabled: true,
  portalUrl: 'https://job-two-xi.vercel.app',
  token: '',
  // H-1B sponsors whose job systems have no server-side collector (Oracle
  // Candidate Experience, Phenom, Jibe), found by scripts/discover-sponsors.js.
  // Each was loaded with these scripts on 2026-10-31 and captured jobs, except
  // Tesla and Wayfair, which block automated browsers and are untested.
  boards: [
    'https://www.tesla.com/careers/search/?country=US',
    'https://www.wayfair.com/careers/jobs',
    'https://careers.americanexpress.com/en/sites/CX_1/jobs?keyword=software%20engineer',
    'https://jobs.nokia.com/en/sites/CX_1/jobs?keyword=software',
    'https://careers.autozone.com/hcmUI/CandidateExperience/en/sites/CX_1/jobs?keyword=software',
    'https://jobs.navyfederal.org/hcmUI/CandidateExperience/en/sites/nfcu/jobs?keyword=software',
    'https://careers.fiserv.com/us/en/search-results?keywords=software%20engineer',
    'https://careers.chewy.com/us/en/search-results?keywords=software%20engineer',
    'https://jobs.thecignagroup.com/us/en/search-results?keywords=software%20engineer',
    'https://careers.truist.com/us/en/search-results?keywords=software%20engineer',
    'https://careers.rivian.com/careers-home/jobs?keywords=software',
    'https://careers.blueyonder.com/us/en/search-results?keywords=software%20engineer',
    'https://careers.wbd.com/global/en/search-results?keywords=software%20engineer',
    'https://careers.blizzard.com/global/en/search-results?keywords=software%20engineer',
    'https://careers.cargurus.com/us/en/search-results?keywords=software%20engineer',
    'https://www.yelp.careers/us/en/search-results?keywords=software%20engineer',
    'https://careers.asurion.com/us/en/search-results?keywords=software%20engineer',
    'https://careers.southwestair.com/us/en/search-results?keywords=software%20engineer',
    'https://jobs.thermofisher.com/global/en/search-results?keywords=software%20engineer',
    'https://careers.corning.com/us/en/search-results?keywords=software%20engineer',
    'https://careers.bose.com/us/en/search-results?keywords=software%20engineer',
  ],
  autoOpen: true,
  autoEveryHours: 3,
  autoClose: true,
  lastRunAt: '',
  log: [],
};
const getSettings = () => chrome.storage.local.get(defaults);

// Same posting seen twice in one browser session (page re-render, second XHR)
// is sent once. Cleared when the worker restarts, which is fine — the server
// upserts, so a resend only refreshes last_seen_at.
const sentIds = new Set();

async function postBatch(portalUrl, token, jobs) {
  const res = await fetch(new URL('/admin/ingest', portalUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-collect-token': token },
    body: JSON.stringify({ source: SOURCE, jobs }),
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
    await addLog({ host, found: fresh.length, error: 'Set portal URL and token in the popup' });
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

// Opens the boards in their own unfocused window, one every few seconds, then
// closes that window once the last page has had time to report.
async function openBoards({ scheduled }) {
  const s = await getSettings();
  const boards = s.boards.slice(0, MAX_BOARDS);
  if (!boards.length) return;
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

// Called on startup, on install, and by the periodic alarm. Runs when the
// interval has passed — including straight after the machine wakes or Chrome
// starts, if it was off when a run was due.
async function checkSchedule() {
  const s = await getSettings();
  if (!s.enabled || !s.autoOpen || !s.token) return;
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
  return checkSchedule();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  await checkSchedule();
});

chrome.runtime.onInstalled.addListener(async () => {
  // Write defaults for anything unset so the popup shows them.
  const s = await getSettings();
  await chrome.storage.local.set(s);
  await scheduleAlarms();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'jobs') handleJobs(msg, sender.tab?.id).finally(() => closeTabIfBoard(sender.tab?.id));
  if (msg?.type === 'openBoards') openBoards({ scheduled: false });
});
