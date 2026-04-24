const PAGE_SIZES = [10, 25, 50, 100];

export default function Pager({ page, totalPages, limit, onPage, onLimit }) {
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
        onClick={() => onPage(page - 1)}
        disabled={page <= 1}
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
        disabled={page >= totalPages}
        className="pager-btn"
      >
        Next →
      </button>
    </nav>
  );
}
