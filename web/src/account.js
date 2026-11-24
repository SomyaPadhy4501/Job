// Client for the Rust /api routes (accounts, resumes, profile, answers,
// tokens). Same origin, cookie session; every write carries
// `X-Requested-With: fetch`, which the server requires (CSRF).

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { navigate } from './router.jsx';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (method !== 'GET') init.headers['X-Requested-With'] = 'fetch';
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection.", 0, 'network');
  }
  if (res.status === 204) return null;
  const text = await res.text().catch(() => '');
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: Vercel's own 413/5xx pages.
  }
  if (!res.ok) {
    const message =
      data?.error ||
      (res.status === 413 ? 'That file is too large (4 MB at most).' : `Request failed (${res.status}).`);
    throw new ApiError(message, res.status, data?.code);
  }
  return data;
}

// A file from a private route (a resume to preview), as a Blob. Errors are
// read the same way as api(): JSON {error} when the server sent it.
export async function apiBlob(path) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection.", 0, 'network');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data?.code);
  }
  return res.blob();
}

// The server sets `jb_li=1` (readable, not a secret) at sign-in. Without it
// nobody is signed in, so the app doesn't call /api/auth/me at all, and an
// anonymous visit never wakes the database.
export function hasSessionHint() {
  return document.cookie.split(';').some((c) => c.trim() === 'jb_li=1');
}

export const ME = ['me'];
// Kept when private data is dropped: the public board, and the account
// query itself (pages are subscribed to it, so it is updated in place).
const PUBLIC_KEYS = ['jobs', 'companies', 'me'];

export function useAccount() {
  return useQuery({
    queryKey: ME,
    queryFn: () => (hasSessionHint() ? api('/api/auth/me') : { user: null }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/// Private data: no refetch on focus, no retries on 4xx.
export function usePrivateQuery(key, path, options = {}) {
  return useQuery({
    queryKey: key,
    queryFn: () => api(path),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    ...options,
  });
}

export function useSignedIn() {
  const qc = useQueryClient();
  return (data) => {
    qc.removeQueries({ predicate: (q) => !PUBLIC_KEYS.includes(q.queryKey[0]) });
    qc.setQueryData(ME, { user: data.user, owner: data.owner, recentSignIn: true });
    // A brand-new account starts on the welcome page for the extension.
    if (data.isNew) navigate('/welcome');
  };
}

export function useSignOut() {
  const qc = useQueryClient();
  return async (everywhere = false) => {
    try {
      await api(everywhere ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST', body: {} });
    } finally {
      qc.removeQueries({ predicate: (q) => !PUBLIC_KEYS.includes(q.queryKey[0]) });
      qc.setQueryData(ME, { user: null });
    }
  };
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
