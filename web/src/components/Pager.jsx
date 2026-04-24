const PAGE_SIZES = [10, 25, 50, 100];

export default function Pager({ page, totalPages, limit, onPage, onLimit }) {
  const atFirst = page <= 1;
  const atLast = page >= totalPages;
  return (
    <nav className="pager">
      <label className="pager-size">
        <span className="pager-size-label">Per page</span>
        <select
          className="pager-size-select"
          value={limit}
          onChange={(e) => onLimit(Number(e.target.value))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => onPage(1)}
        disabled={atFirst}
        className="pager-btn pager-btn--icon"
        aria-label="First page"
        title="First page"
      >
        «
      </button>
      <button
        type="button"
        onClick={() => onPage(page - 1)}
        disabled={atFirst}
        className="pager-btn"
      >
        ← Prev
      </button>
      <span className="pager-info">
        Page {page.toLocaleString()} of {totalPages.toLocaleString()}
      </span>
      <button
        type="button"
        onClick={() => onPage(page + 1)}
        disabled={atLast}
        className="pager-btn"
      >
        Next →
      </button>
      <button
        type="button"
        onClick={() => onPage(totalPages)}
        disabled={atLast}
        className="pager-btn pager-btn--icon"
        aria-label="Last page"
        title="Last page"
      >
        »
      </button>
    </nav>
  );
}
