import { useEffect, useRef } from 'react';
import TopBar from './components/TopBar.jsx';
import Filters from './components/Filters.jsx';
import JobsTable from './components/JobsTable.jsx';
import CompanyGroups from './components/CompanyGroups.jsx';
import Pager from './components/Pager.jsx';
import { useJobs, useCompanies } from './hooks/useJobs.js';
import useUrlFilters from './hooks/useUrlFilters.js';

export default function App() {
  // Filters live in the URL query string (see useUrlFilters). Reloading the
  // page keeps the user's search + paging position; TanStack Query's cache
  // then serves the prior rows instantly while it revalidates in the
  // background. No cold-boot flash on refresh.
  const [filters, dispatch] = useUrlFilters();
  const grouped = filters.view === 'grouped';
  // In grouped mode the job query only supplies the role total (TopBar, new-
  // jobs toast), so it asks for a single row; the companies query drives the
  // page.
  const jobsQuery = useJobs(grouped ? { ...filters, page: 1, limit: 1 } : filters);
  const companiesQuery = useCompanies(filters, { enabled: grouped });
  const { data, refetch } = jobsQuery;
  const active = grouped ? companiesQuery : jobsQuery;
  const { isLoading, error } = active;
  const isFetching = jobsQuery.isFetching || (grouped && companiesQuery.isFetching);

  // New jobs simply appear: both queries poll every 60 s (see useJobs) and
  // swap fresh rows in without a flash. There used to be a "N new jobs ·
  // click to add" toast on top of that, which asked for a click to show what
  // had already arrived; removed at the owner's request.
  const total = data?.pagination?.total;

  // Clamp page if filter change narrows totalPages below current page.
  const totalPages = active.data?.pagination?.totalPages ?? 1;
  const prevTotalPages = useRef(totalPages);
  useEffect(() => {
    if (totalPages !== prevTotalPages.current) {
      prevTotalPages.current = totalPages;
      if (filters.page > totalPages) {
        dispatch({ type: 'clamp', max: totalPages });
      }
    }
  }, [totalPages, filters.page]);

  const handleManualRefresh = () => {
    refetch();
    if (grouped) companiesQuery.refetch();
  };

  return (
    <div className="app">
      <TopBar total={total} isFetching={isFetching} onRefresh={handleManualRefresh} />
      <Filters
        filters={filters}
        onChange={(key, value) => dispatch({ type: 'set', key, value })}
      />
      <main className="main">
        {grouped ? (
          <CompanyGroups
            groups={companiesQuery.data?.data ?? []}
            filters={filters}
            isLoading={isLoading}
            error={error}
          />
        ) : (
          <JobsTable rows={data?.data ?? []} isLoading={isLoading} error={error} />
        )}
        <Pager
          page={filters.page}
          totalPages={totalPages}
          limit={filters.limit}
          onPage={(p) => dispatch({ type: 'setPage', value: p })}
          onLimit={(n) => dispatch({ type: 'setLimit', value: n })}
        />
      </main>
    </div>
  );
}
