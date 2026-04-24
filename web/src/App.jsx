import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import TopBar from './components/TopBar.jsx';
import Filters from './components/Filters.jsx';
import JobsTable from './components/JobsTable.jsx';
import Pager from './components/Pager.jsx';
import NewJobsToast from './components/NewJobsToast.jsx';
import { useJobs } from './hooks/useJobs.js';

// Reducer-style filter state so all mutations go through one well-typed path.
// `page` is bundled here because it participates in the TanStack Query cache
// key — changing any filter should reset to page 1 in one atomic update.
const INITIAL_FILTERS = {
  search: '',
  sponsorship: '',
  role: '',
  level: '',
  page: 1,
  limit: 50,
};

function filtersReducer(state, action) {
  switch (action.type) {
    case 'set':
      return { ...state, [action.key]: action.value, page: 1 };
    case 'setPage':
      return { ...state, page: action.value };
    case 'clamp':
      return { ...state, page: Math.min(state.page, Math.max(1, action.max)) };
    default:
      return state;
  }
}

export default function App() {
  const [filters, dispatch] = useReducer(filtersReducer, INITIAL_FILTERS);
  const { data, isFetching, isLoading, error, refetch } = useJobs(filters);

  // Detect new jobs on background refetch. `lastSeenTotal` is the total we
  // last *rendered* to the user, not the most recent server reading —
  // otherwise the toast would dismiss itself on the tick that fetches new
  // data. We update it only when the user explicitly reloads.
  const [lastSeenTotal, setLastSeenTotal] = useState(null);
  const total = data?.pagination?.total;

  useEffect(() => {
    if (total == null) return;
    if (lastSeenTotal == null) setLastSeenTotal(total);
  }, [total, lastSeenTotal]);

  const newJobs = useMemo(() => {
    if (lastSeenTotal == null || total == null) return 0;
    return Math.max(0, total - lastSeenTotal);
  }, [total, lastSeenTotal]);

  // Clamp page if filter change narrows totalPages below current page.
  const totalPages = data?.pagination?.totalPages ?? 1;
  const prevTotalPages = useRef(totalPages);
  useEffect(() => {
    if (totalPages !== prevTotalPages.current) {
      prevTotalPages.current = totalPages;
      if (filters.page > totalPages) {
        dispatch({ type: 'clamp', max: totalPages });
      }
    }
  }, [totalPages, filters.page]);

  const qc = useQueryClient();
  const handleReloadToApplyNew = () => {
    setLastSeenTotal(total);
    // Invalidate instead of a hard refetch so any matching query (page 1,
    // page 2, …) gets refreshed consistently.
    qc.invalidateQueries({ queryKey: ['jobs'] });
  };

  const handleManualRefresh = () => {
    setLastSeenTotal(null);
    refetch();
  };

  return (
    <div className="app">
      <TopBar total={total} isFetching={isFetching} onRefresh={handleManualRefresh} />
      <Filters
        filters={filters}
        onChange={(key, value) => dispatch({ type: 'set', key, value })}
      />
      <main className="main">
        <JobsTable
          rows={data?.data ?? []}
          isLoading={isLoading}
          error={error}
        />
        <Pager
          page={filters.page}
          totalPages={totalPages}
          onPage={(p) => dispatch({ type: 'setPage', value: p })}
        />
      </main>
      {newJobs > 0 && <NewJobsToast count={newJobs} onClick={handleReloadToApplyNew} />}
    </div>
  );
}
