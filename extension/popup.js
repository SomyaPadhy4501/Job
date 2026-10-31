const $ = (id) => document.getElementById(id);
const defaults = { enabled: true, portalUrl: '', token: '', boards: [], log: [] };

function renderLog(log) {
  if (!log.length) return;
  $('log').replaceChildren(
    ...log.map((e) => {
      const d = document.createElement('div');
      const when = new Date(e.at).toLocaleString();
      d.textContent = e.error
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
  renderLog(s.log);
});

$('enabled').addEventListener('change', () => chrome.storage.local.set({ enabled: $('enabled').checked }));

$('save').addEventListener('click', async () => {
  const boards = $('boards').value.split('\n').map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x));
  await chrome.storage.local.set({
    portalUrl: $('portalUrl').value.trim().replace(/\/+$/, ''),
    token: $('token').value.trim(),
    boards,
  });
  $('save').textContent = 'Saved';
  setTimeout(() => ($('save').textContent = 'Save'), 1200);
});

$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openBoards' }));

chrome.storage.onChanged.addListener((c) => c.log && renderLog(c.log.newValue || []));
