const ROLE_LABEL = {
  SWE: 'SWE',
  MLE: 'MLE',
  AI: 'AI',
  DS: 'DS',
  DATA_ENG: 'Data Eng',
  SRE: 'DevOps/SRE',
  SECURITY: 'Security',
  MOBILE: 'Mobile',
  OTHER: 'Other',
};


function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Relative time for the past week. Returns null for older or future
// timestamps so callers can fall back to the absolute date alone.
function fmtRelative(s) {
  if (!s) return null;
  const ms = Date.now() - new Date(s).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Just posted';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(ms / 86_400_000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return null;
}

function fmtPreciseTooltip(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// Render a row's date column: prefer the upstream posting date, fall back to
// `first_seen_at` (when we first observed the row) so users always see *some*
// temporal context. The "Seen" label distinguishes the two — the upstream
// date is authoritative, the first-seen stamp is our best guess.
//
// Layout: `{relative} · {absolute}` for items in the past week, falling back
// to just the absolute date for older items. Tooltip on hover always shows
// precise date+time. Relative ticks naturally with the 60s TanStack Query
// refetch — it'll re-render as new data lands.
function PostedCell({ row }) {
  const ts = row.date_posted || row.first_seen_at;
  if (!ts) return <>—</>;
  const isStamped = !row.date_posted;
  const rel = fmtRelative(ts);
  const abs = fmtDate(ts);
  const tooltip = isStamped
    ? `Upstream didn't provide a posting date; first observed ${fmtPreciseTooltip(ts)}`
    : fmtPreciseTooltip(ts);
  const relText = rel ? (isStamped ? `Seen ${rel}` : rel) : null;
  return (
    <span className="posted-cell" title={tooltip}>
      {relText && <span className="posted-rel">{relText}</span>}
      {relText && <span className="posted-sep"> · </span>}
      <span className="posted-abs">{abs}</span>
    </span>
  );
}

function LevelPill({ row }) {
  if (row.is_entry_level) return <span className="pill pill-entry">entry</span>;
  if (row.is_mid_level) return <span className="pill pill-mid">mid · 1-2y</span>;
  return null;
}

export default function JobsTable({ rows, isLoading, error }) {
  if (error) {
    return (
      <div className="table-empty">
        <strong>Error loading jobs.</strong> {error.message}
        <div className="muted">Will keep retrying in the background.</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="table-empty">
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
      </div>
    );
  }

  if (!rows.length) {
    return <div className="table-empty muted">No jobs match these filters.</div>;
  }

  return (
    <div className="table-card">
      <table className="jobs-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Role</th>
            <th>Type</th>
            <th>Location</th>
            <th>Sponsorship</th>
            <th>
              Posted <span className="sort-indicator" title="Sorted newest first">↓</span>
            </th>
            <th>Apply</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="company-name">{r.company_name}</div>
              </td>
              <td>
                <div className="role-cell">
                  <span className="role-title">{r.job_title}</span>
                  <LevelPill row={r} />
                </div>
              </td>
              <td>
                <span className="pill">{ROLE_LABEL[r.role_type] || r.role_type || '—'}</span>
              </td>
              <td>{r.location || '—'}</td>
              <td>
                <span className={`badge badge-${r.sponsorship || 'UNKNOWN'}`}>
                  {r.sponsorship || 'UNKNOWN'}
                </span>
              </td>
              <td className="muted nowrap"><PostedCell row={r} /></td>
              <td>
                <a
                  className="apply-btn"
                  href={r.apply_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Apply
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
