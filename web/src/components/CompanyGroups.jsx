import { useState } from 'react';
import { JobRow, JobsHead, TableState, PostedCell, LevelPill, RestrictionPill, ROLE_LABEL } from './JobsTable.jsx';
import { useCompanyJobs } from '../hooks/useJobs.js';

// Grouped view: one row per company, ordered by its newest posting. Every row
// shows that newest job in full — title, level, location, when it was posted,
// Apply — so what's new is visible without expanding. A company with more
// roles adds "+ N more"; expanding lists the rest newest-first, so the posted
// column reads as the company's hiring timeline.

function CompanyRoles({ company, filters, skipId }) {
  const { data, isLoading, error } = useCompanyJobs(filters, company, { enabled: true });
  const rows = (data?.data ?? []).filter((r) => r.id !== skipId);
  if (error || isLoading || !rows.length) {
    return <TableState error={error} isLoading={isLoading} empty={!rows.length} emptyText="No other roles right now." />;
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

// The shared row: company cell + the newest job's cells.
function NewestJobCells({ job }) {
  return (
    <>
      <span className="role-cell">
        <span className="role-title">{job.job_title}</span>
        <span className="pill">{ROLE_LABEL[job.role_type] || job.role_type}</span>
        <LevelPill row={job} />
      </span>
      <span className="muted">{job.location || '—'}</span>
      <span className="sponsor-cell">
        <span className={`badge badge-${job.sponsorship || 'UNKNOWN'}`}>{job.sponsorship || 'UNKNOWN'}</span>
        <RestrictionPill row={job} />
      </span>
      <span className="muted nowrap"><PostedCell row={job} /></span>
      <a
        className="apply-btn"
        href={job.apply_url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        Apply
      </a>
    </>
  );
}

function CompanyGroup({ group, filters }) {
  const [open, setOpen] = useState(false);
  const job = group.newest || group.job;
  if (!job) return null;
  const more = group.roles - 1;

  if (more < 1) {
    return (
      <div className="group">
        <div className="group-row">
          <span />
          <span className="company-name">{group.company_name}</span>
          <NewestJobCells job={job} />
        </div>
      </div>
    );
  }

  const toggle = () => setOpen((v) => !v);
  return (
    <div className={`group ${open ? 'is-open' : ''}`}>
      <div className="group-row group-head" onClick={toggle}>
        <button
          type="button"
          className="group-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} ${more} more roles at ${group.company_name}`}
          onClick={(e) => { e.stopPropagation(); toggle(); }}
        >
          <span className="group-chevron" aria-hidden="true" />
        </button>
        <span className="group-name">
          <span className="company-name">{group.company_name}</span>
          <span className="group-count">+ {more} more {more === 1 ? 'role' : 'roles'}</span>
        </span>
        <NewestJobCells job={job} />
      </div>
      {open && (
        <div className="group-body">
          <CompanyRoles company={group.company_name} filters={filters} skipId={job.id} />
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
