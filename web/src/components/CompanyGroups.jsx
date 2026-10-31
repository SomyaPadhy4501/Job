import { useState } from 'react';
import { JobRow, JobsHead, TableState, PostedCell, LevelPill, RestrictionPill, ROLE_LABEL } from './JobsTable.jsx';
import { useCompanyJobs } from '../hooks/useJobs.js';

// Grouped view: one row per company. A company with several matching roles
// shows its name and "(N roles)" and expands in place to list them; a company
// with exactly one shows that role directly — a dropdown hiding a single job
// is a click with nothing behind it.

function CompanyRoles({ company, filters }) {
  const { data, isLoading, error } = useCompanyJobs(filters, company, { enabled: true });
  const rows = data?.data ?? [];
  if (error || isLoading || !rows.length) {
    return <TableState error={error} isLoading={isLoading} empty={!rows.length} emptyText="No roles left for this company." />;
  }
  return (
    <table className="jobs-table group-jobs">
      <JobsHead hideCompany />
      <tbody>
        {rows.map((r) => (
          <JobRow key={r.id} row={r} hideCompany />
        ))}
      </tbody>
    </table>
  );
}

function CompanyGroup({ group, filters }) {
  const [open, setOpen] = useState(false);
  const latest = { date_posted: group.latest_posted, first_seen_at: group.latest_seen };

  // Single-role company: the role itself, on the same grid as group headers
  // so columns line up down the page.
  if (group.roles === 1 && group.job) {
    const j = group.job;
    return (
      <div className="group">
        <div className="group-row">
          <span />
          <span className="company-name">{j.company_name}</span>
          <span className="role-cell">
            <span className="role-title">{j.job_title}</span>
            <span className="pill">{ROLE_LABEL[j.role_type] || j.role_type}</span>
            <LevelPill row={j} />
          </span>
          <span className="muted">{j.location || '—'}</span>
          <span className="sponsor-cell">
            <span className={`badge badge-${j.sponsorship || 'UNKNOWN'}`}>{j.sponsorship || 'UNKNOWN'}</span>
            <RestrictionPill row={j} />
          </span>
          <span className="muted nowrap"><PostedCell row={j} /></span>
          <a className="apply-btn" href={j.apply_url} target="_blank" rel="noopener noreferrer">Apply</a>
        </div>
      </div>
    );
  }

  return (
    <div className={`group ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="group-row group-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="group-chevron" aria-hidden="true" />
        <span className="group-name">
          <span className="company-name">{group.company_name}</span>
          <span className="group-count">({group.roles} roles)</span>
        </span>
        <span className="muted">{open ? 'Hide roles' : `Show all ${group.roles} roles`}</span>
        <span />
        <span className="sponsor-cell">
          {group.sponsors && <span className="badge badge-YES">YES</span>}
        </span>
        <span className="muted nowrap"><PostedCell row={latest} /></span>
        <span />
      </button>
      {open && (
        <div className="group-body">
          <CompanyRoles company={group.company_name} filters={filters} />
        </div>
      )}
    </div>
  );
}

export default function CompanyGroups({ groups, filters, isLoading, error }) {
  const state = (
    <TableState error={error} isLoading={isLoading} empty={!groups.length} emptyText="No companies match these filters." />
  );
  if (error || isLoading || !groups.length) return state;

  return (
    <div className="table-card groups">
      <div className="group-row group-columns" aria-hidden="true">
        <span />
        <span>Company</span>
        <span>Role</span>
        <span>Location</span>
        <span>Sponsorship</span>
        <span>Posted ↓</span>
        <span>Apply</span>
      </div>
      {groups.map((g) => (
        <CompanyGroup key={g.company_name} group={g} filters={filters} />
      ))}
    </div>
  );
}
