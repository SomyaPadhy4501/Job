import { useEffect, useReducer } from 'react';

// Source of truth lives in the URL query string. On mount, we read filters
// from `window.location.search` so a reload preserves whatever the user was
// looking at. On every filter change, we write back with `history.replaceState`
// (not pushState) — we don't want the browser-back stack to grow an entry per
// keystroke. Combined with TanStack Query's cache, a reload then feels like
// "same page, just reconciled with fresh data" instead of a cold boot.

const ALLOWED_LIMITS = [10, 25, 50, 100];
const DEFAULT_LIMIT = 50;

function normalizeLimit(n) {
  const v = Number(n);
  return ALLOWED_LIMITS.includes(v) ? v : DEFAULT_LIMIT;
}

export const INITIAL = {
  search: '',
  title: '',
  sponsorship: '',
  role: '',
  level: '',
  page: 1,
  limit: DEFAULT_LIMIT,
};

function readFromUrl() {
  if (typeof window === 'undefined') return { ...INITIAL };
  const p = new URLSearchParams(window.location.search);
  return {
    search: p.get('q') || '',
    title: p.get('title') || '',
    sponsorship: p.get('sponsorship') || '',
    role: p.get('role') || '',
    level: p.get('level') || '',
    page: Math.max(1, Number(p.get('page')) || 1),
    limit: normalizeLimit(p.get('per')),
  };
}

function writeToUrl(filters) {
  if (typeof window === 'undefined') return;
  const p = new URLSearchParams();
  if (filters.search) p.set('q', filters.search);
  if (filters.title) p.set('title', filters.title);
  if (filters.sponsorship) p.set('sponsorship', filters.sponsorship);
  if (filters.role) p.set('role', filters.role);
  if (filters.level) p.set('level', filters.level);
  if (filters.page > 1) p.set('page', filters.page);
  if (filters.limit !== DEFAULT_LIMIT) p.set('per', filters.limit);
  const qs = p.toString();
  const next = qs
    ? `${window.location.pathname}?${qs}${window.location.hash}`
    : `${window.location.pathname}${window.location.hash}`;
  // No-op if already matches — avoids churning history entries on rerenders.
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, '', next);
}

function reducer(state, action) {
  switch (action.type) {
    case 'set':
      // Any filter change resets paging — users expect "new filter, start over".
      return { ...state, [action.key]: action.value, page: 1 };
    case 'setPage':
      return { ...state, page: action.value };
    case 'setLimit':
      // Changing page size also resets to page 1: the user's old page number
      // may no longer exist at the new density (or worse, point to a
      // misleading window of results).
      return { ...state, limit: normalizeLimit(action.value), page: 1 };
    case 'clamp':
      return { ...state, page: Math.min(Math.max(1, state.page), Math.max(1, action.max)) };
    default:
      return state;
  }
}

export default function useUrlFilters() {
  const [filters, dispatch] = useReducer(reducer, undefined, readFromUrl);
  useEffect(() => {
    writeToUrl(filters);
  }, [filters]);
  return [filters, dispatch];
}
