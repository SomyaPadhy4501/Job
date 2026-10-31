// Service worker: de-duplicates captured rows, posts them to the portal's
// /admin/ingest in batches, and keeps a short capture log for the popup.

const BATCH = 500;          // Vercel caps request bodies at ~4.5 MB
const SOURCE = 'extension'; // shows up as its own source in the board's filter
const LOG_MAX = 30;

const defaults = { enabled: true, portalUrl: '', token: '', boards: [], log: [] };
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

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'jobs') handleJobs(msg, sender.tab?.id);
  if (msg?.type === 'openBoards') {
    // Opens the user's saved boards as ordinary tabs — the same as opening a
    // bookmark folder. Each page captures itself as it loads.
    getSettings().then((s) => s.boards.forEach((url) => chrome.tabs.create({ url, active: false })));
  }
});
