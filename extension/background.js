// Service worker: de-duplicates captured rows, posts them to the portal's
// /admin/ingest in batches, keeps a short capture log for the popup, and opens
// the saved boards once a day.
importScripts('schedule.js');

const BATCH = 500;          // Vercel caps request bodies at ~4.5 MB
const SOURCE = 'extension'; // shows up as its own source in the board's filter
const LOG_MAX = 30;

// Daily run. Opens the saved boards once per day — the same visit a person
// would make by hand, in an ordinary (unfocused) window. It never clicks,
// pages or follows links; each page captures only what it loads by itself.
const MAX_BOARDS = 25;      // one visit per site per day, not a crawl
const STAGGER_MS = 4000;    // gap between opening each board
const SETTLE_MS = 45000;    // time to let the last page load and report
const CHECK_MINUTES = 30;   // periodic re-check, catches wake-from-sleep

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
  autoTime: '10:00',
  autoClose: true,
  lastRunDay: '',
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
    for (let i = 0; i < fresh.length; i += BATCH) {
      const r = await postBatch(s.portalUrl, s.token, fresh.slice(i, i + BATCH));
      inserted += r.inserted || 0;
      updated += r.updated || 0;
      rejected += r.rejected || 0;
    }
    fresh.forEach((r) => sentIds.add(r.external_id));
    await addLog({ host, found: fresh.length, inserted, updated, rejected });
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
  if (scheduled) await chrome.storage.local.set({ lastRunDay: JobSchedule.localDay(new Date()) });

  const win = await chrome.windows.create({ url: boards[0], focused: false, state: 'normal' });
  for (const url of boards.slice(1)) {
    await sleep(STAGGER_MS);
    await chrome.tabs.create({ windowId: win.id, url, active: false }).catch(() => {});
  }
  await addLog({ host: scheduled ? 'daily run' : 'manual run', found: boards.length, inserted: 0, updated: 0, rejected: 0, note: 'boards opened' });

  if (s.autoClose) {
    await sleep(SETTLE_MS);
    await chrome.windows.remove(win.id).catch(() => {}); // already closed by hand
  }
}

// Called on startup, on install, and by both alarms. Runs at most once a day.
async function checkDaily() {
  const s = await getSettings();
  if (!s.enabled || !s.autoOpen || !s.token) return;
  if (JobSchedule.isDue(new Date(), s.lastRunDay, s.autoTime)) await openBoards({ scheduled: true });
}

async function scheduleAlarms() {
  const s = await getSettings();
  await chrome.alarms.clearAll();
  chrome.alarms.create('daily', { when: JobSchedule.nextRun(new Date(), s.autoTime).getTime() });
  chrome.alarms.create('check', { periodInMinutes: CHECK_MINUTES });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'daily') await scheduleAlarms(); // re-arm for tomorrow
  await checkDaily();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  await checkDaily(); // "if I wasn't on at 10, do it the moment I turn on"
});

chrome.runtime.onInstalled.addListener(async () => {
  // Write defaults for anything unset so the popup shows them.
  const s = await getSettings();
  await chrome.storage.local.set(s);
  await scheduleAlarms();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoTime) scheduleAlarms();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'jobs') handleJobs(msg, sender.tab?.id);
  if (msg?.type === 'openBoards') openBoards({ scheduled: false });
});
