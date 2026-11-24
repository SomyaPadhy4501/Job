// Values from outside (job feeds, the address bar) checked before they become
// a link or part of an API path.

// A job's apply link as an href, or undefined. React 18 still renders a
// `javascript:` href, so anything but http(s) is dropped.
export function webHref(raw) {
  if (typeof raw !== 'string') return undefined;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A resume id from `?id=`, or '' when it isn't one, so a crafted link can't
// point the editor's requests at another API path.
export function resumeId(raw) {
  const id = String(raw ?? '').trim().toLowerCase();
  return UUID.test(id) ? id : '';
}
