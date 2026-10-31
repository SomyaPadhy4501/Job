import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { fetchJobs, fetchCompanies } from '../api';

// `filters` is the full query shape — paging + filter selects. TanStack Query
// uses it as the cache key, so switching filters navigates between independent
// cached result sets. `placeholderData: keepPreviousData` keeps the old rows
// on screen while the new page is fetching, so pagination/filter changes
// don't flash "Loading…".
//
// `refetchInterval: 60_000` is the auto-refresh tick. Combined with the
// server-side 30s cache, the effective staleness of what the user sees is
// bounded by ~60s + 30s = 90s — well under the 2h collect cadence.
export function useJobs(filters) {
  return useQuery({
    queryKey: ['jobs', filters],
    queryFn: () => fetchJobs(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

// Grouped view's top level. Same caching behaviour as useJobs.
export function useCompanies(filters, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['companies', filters],
    queryFn: () => fetchCompanies(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled,
  });
}

// One expanded company's roles. Fetched only when the row is opened.
export function useCompanyJobs(filters, company, { enabled }) {
  return useQuery({
    queryKey: ['jobs', { ...filters, company, page: 1, limit: 200 }],
    queryFn: () => fetchJobs({ ...filters, company, page: 1, limit: 200 }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000, // an open group picks up new roles on its own
    enabled,
  });
}
