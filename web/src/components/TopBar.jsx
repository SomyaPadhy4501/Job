export default function TopBar({ total, isFetching, onRefresh }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo-dot" aria-hidden="true" />
        <h1>US SWE Jobs</h1>
        <span className="stats">
          {total != null ? `${total.toLocaleString()} jobs` : '—'}
          {isFetching ? ' · syncing…' : ''}
        </span>
      </div>
      <button
        className="refresh-btn"
        type="button"
        onClick={onRefresh}
        title="Force refresh"
        aria-label="Force refresh"
      >
        <span className={isFetching ? 'spinning' : ''}>↻</span>
      </button>
    </header>
  );
}
