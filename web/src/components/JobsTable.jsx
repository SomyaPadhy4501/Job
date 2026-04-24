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

// Render a row's date column: prefer the upstream posting date, fall back to
// `first_seen_at` (when we first observed the row) so users always see *some*
// temporal context. The "Seen" label distinguishes the two — the upstream
// date is authoritative, the first-seen stamp is our best guess.
function PostedCell({ row }) {
  if (row.date_posted) return <>{fmtDate(row.date_posted)}</>;
  if (row.first_seen_at) {
    return (
      <span title="Upstream didn't provide a posting date; this is when we first observed the role.">
        Seen {fmtDate(row.first_seen_at)}
      </span>
    );
  }
  return <>—</>;
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
                {r.category === 'STARTUP' && (
                  <span className="pill pill-cat pill-cat-startup">Startup</span>
                )}
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
