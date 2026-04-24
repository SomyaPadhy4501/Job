export default function Pager({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pager">
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
