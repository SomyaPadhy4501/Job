'use strict';

// A resume, opened from "Preview" in the Autofill panel. The file comes
// through the service worker (your autofill token never reaches a page);
// PDFs show in the browser's PDF viewer, Word files can be downloaded.
(async () => {
  const $ = (id) => document.getElementById(id);
  const id = decodeURIComponent(location.hash.slice(1));
  const ask = async (type, params = {}) => {
    const r = await chrome.runtime.sendMessage({ type: 'autofill:' + type, ...params });
    if (!r?.ok) throw new Error(r?.error || 'The extension could not answer.');
    return r.data;
  };
  try {
    const account = await ask('getProfile');
    const resume = account.resumes.find((r) => r.id === id);
    if (!resume) throw new Error('That resume isn’t in your account any more.');
    document.title = resume.title || resume.fileName;
    $('title').textContent = resume.title || resume.fileName;
    $('file').textContent = resume.fileName;
    const file = await ask('getResume', { id, binding: account.binding });
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType || resume.mimeType }));
    const download = $('download');
    download.href = url;
    download.download = file.fileName || resume.fileName;
    download.hidden = false;
    if ((file.mimeType || resume.mimeType) === 'application/pdf') {
      const frame = document.createElement('iframe');
      frame.title = resume.title || 'Resume';
      frame.src = url;
      $('main').replaceChildren(frame);
    } else {
      $('message').textContent = 'Word files can’t be shown here. Download it, or open Preview on the Resumes page of the job board.';
    }
  } catch (err) {
    $('message').textContent = err.message;
  }
})();
