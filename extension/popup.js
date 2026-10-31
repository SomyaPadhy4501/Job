const $ = (id) => document.getElementById(id);
const defaults = { enabled: true, portalUrl: '', token: '', boards: [], autoOpen: true, autoTime: '10:00', autoClose: true, lastRunDay: '', log: [] };

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
        : `${when} · ${e.host} · ${e.found} found → ${e.inserted} new, ${e.updated} updated, ${e.rejected} filtered`;
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
  $('autoTime').value = s.autoTime;
  $('autoClose').checked = s.autoClose;
  $('lastRun').textContent = s.lastRunDay ? `Last daily run: ${s.lastRunDay}` : 'Daily run has not happened yet.';
  if (!s.token) $('lastRun').textContent = 'Add your collect token, then Save, to start the daily run.';
  renderLog(s.log);
});

$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));

$('save').addEventListener('click', async () => {
  const boards = $('boards').value.split('\n').map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x));
  await chrome.storage.local.set({
    portalUrl: $('portalUrl').value.trim().replace(/\/+$/, ''),
    token: $('token').value.trim(),
    boards,
    autoOpen: $('autoOpen').checked,
    autoTime: /^\d{1,2}:\d{2}$/.test($('autoTime').value.trim()) ? $('autoTime').value.trim() : '10:00',
    autoClose: $('autoClose').checked,
  });
  $('save').textContent = 'Saved';
  setTimeout(() => ($('save').textContent = 'Save'), 1200);
});

$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openBoards' }));

chrome.storage.onChanged.addListener((c) => c.log && renderLog(c.log.newValue || []));
