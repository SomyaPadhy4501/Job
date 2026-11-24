'use strict';

// Updates without reinstalling. Imported by the worker.
// - Every 6 hours (and when the popup opens) the job board's
//   /downloads/extension.json says which version is current. If it's newer,
//   the icon shows NEW and the popup shows the one-line update command.
// - The command copies the new files over this extension's folder. An
//   unpacked extension serves its files straight from disk, so the
//   manifest.json read below then has the new version: reload into it.
(() => {
  const CHECK = 'updateCheck';
  const WATCH = 'updateWatch';
  const running = chrome.runtime.getManifest().version;

  function newer(a, b) {
    const x = String(a).split('.').map(Number),
      y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  }

  async function clear() {
    await chrome.storage.local.remove('updateAvailable');
    await chrome.action.setBadgeText({ text: '' });
    await chrome.alarms.clear(WATCH);
  }

  async function check() {
    const { portalUrl, updateAvailable } = await chrome.storage.local.get({ portalUrl: 'https://job-two-xi.vercel.app', updateAvailable: null });
    // Already on (or past) the version the last check announced.
    if (updateAvailable && !newer(updateAvailable.version, running)) await clear();
    let latest;
    try {
      const res = await fetch(portalUrl.replace(/\/+$/, '') + '/downloads/extension.json', { cache: 'no-store', credentials: 'omit' });
      latest = (await res.json()).version;
    } catch {
      return null;
    }
    if (typeof latest === 'string' && newer(latest, running)) {
      await chrome.storage.local.set({ updateAvailable: { version: latest, portal: portalUrl } });
      await chrome.action.setBadgeBackgroundColor({ color: '#0a65cc' });
      await chrome.action.setBadgeText({ text: 'NEW' });
      // Watch for the new files every 30 s until they arrive.
      if (!(await chrome.alarms.get(WATCH))) chrome.alarms.create(WATCH, { periodInMinutes: 0.5 });
      return latest;
    }
    await clear();
    return null;
  }

  async function watch() {
    try {
      const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
      if (onDisk.version && onDisk.version !== running) chrome.runtime.reload();
    } catch {
      // Files mid-copy: try again on the next tick.
    }
  }

  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === CHECK) check();
    if (a.name === WATCH) watch();
  });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(CHECK, { periodInMinutes: 360, delayInMinutes: 1 });
    check();
  });
  chrome.runtime.onStartup.addListener(() => check());

  self.ExtensionUpdates = { check, watch, newer, running };
})();
