import { lazy, Suspense, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiBlob, formatBytes, formatDate, usePrivateQuery } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
import { Link } from '../router.jsx';

const KEY = ['resumes'];
// Loaded only when someone opens a preview, so the board stays small.
const PdfViewer = lazy(() => import('../components/PdfViewer.jsx'));
const DocxViewer = lazy(() => import('../components/DocxViewer.jsx'));

const PARSE_LABEL = {
  parsed: 'Read',
  pending: 'Reading…',
  no_text: 'No text found (scanned?)',
  failed: "Couldn't read",
};

export default function Resumes() {
  return (
    <RequireAuth reason="Sign in to keep your resumes for autofill.">
      <ResumesPage />
    </RequireAuth>
  );
}

function ResumesPage() {
  const { data, isLoading, error } = usePrivateQuery(KEY, '/api/me/resumes');
  if (isLoading) return <div className="card"><div className="skeleton skeleton-row" /></div>;
  if (error) return <div className="card error">{error.message}</div>;
  const { resumes, limits, storage } = data;
  return (
    <>
      <div className="page-head">
        <h2>Resumes</h2>
        <p className="muted">One resume per kind of role. The extension picks the best match for each job.</p>
      </div>
      {storage ? (
        <UploadCard limits={limits} full={resumes.length >= limits.maxResumes} />
      ) : (
        <div className="card notice">Resume uploads aren't available on this server yet.</div>
      )}
      {storage && (
        <div className="card latex-cta">
          <h3>Write one in LaTeX</h3>
          {/* A full page load: only the editor's page may run the compiler. */}
          <a className="btn btn-small" href="/resumes/latex" aria-disabled={resumes.length >= limits.maxResumes}>
            New LaTeX resume
          </a>
        </div>
      )}
      {resumes.length === 0 ? (
        <div className="card muted">No resumes yet.</div>
      ) : (
        <div className="resume-list">
          {resumes.map((r) => (
            <ResumeCard key={r.id} resume={r} />
          ))}
        </div>
      )}
      <p className="muted small">
        {resumes.length} of {limits.maxResumes} resumes
      </p>
    </>
  );
}

const ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const nameOf = (file) => file.name.replace(/\.(pdf|docx)$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 80);

function UploadCard({ limits, full }) {
  const qc = useQueryClient();
  const fileInput = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [over, setOver] = useState(false);
  const [result, setResult] = useState(null);
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('title', title.trim());
      form.append('tags', '[]');
      form.append('file', file);
      return api('/api/me/resumes', { method: 'POST', form });
    },
    onSuccess: (data) => {
      setResult(data);
      setFile(null);
      setTitle('');
      if (fileInput.current) fileInput.current.value = '';
      qc.invalidateQueries({ queryKey: KEY });
      if (data.imported?.length) qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
  const choose = (f) => {
    if (!f) return;
    setFile(f);
    setTitle(nameOf(f));
    setResult(null);
    upload.reset();
  };

  const tooBig = file && file.size > limits.maxFileBytes;
  return (
    <form
      className="card upload-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !tooBig && title.trim()) upload.mutate();
      }}
    >
      <h3>Add a resume</h3>
      <label
        className={`dropzone${over ? ' is-over' : ''}${full ? ' is-disabled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!full) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!full) choose(e.dataTransfer.files?.[0]);
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          onChange={(e) => choose(e.target.files?.[0])}
          disabled={full}
        />
        {file ? (
          <span>
            <strong>{file.name}</strong> · {formatBytes(file.size)} <span className="link-like">Change</span>
          </span>
        ) : (
          <span>
            Drop your resume here or <span className="link-like">choose a file</span>
            <small>PDF or Word, up to {formatBytes(limits.maxFileBytes)}</small>
          </span>
        )}
      </label>
      {file && (
        <label className="field">
          <span>Name it</span>
          <input value={title} maxLength={80} required onChange={(e) => setTitle(e.target.value)} placeholder="e.g. ML Engineer" />
        </label>
      )}
      {tooBig && <p className="error">That file is over {formatBytes(limits.maxFileBytes)}.</p>}
      {full && <p className="notice">You have the most resumes allowed. Delete one to add another.</p>}
      {upload.error && <p className="error">{upload.error.message}</p>}
      {result && <p className="success">Added “{result.resume.title}”.</p>}
      {file && (
        <button className="btn" disabled={tooBig || full || !title.trim() || upload.isPending}>
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </button>
      )}
    </form>
  );
}

function ResumeCard({ resume }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(resume.title);
  const [review, setReview] = useState(false);
  const [preview, setPreview] = useState(false);
  const done = () => qc.invalidateQueries({ queryKey: KEY });

  const save = useMutation({
    mutationFn: (patch) => api(`/api/me/resumes/${resume.id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => {
      setEditing(false);
      done();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/me/resumes/${resume.id}`, { method: 'DELETE' }),
    onSuccess: done,
  });
  const error = save.error || remove.error;

  return (
    <div className={`card resume-card${resume.isDefault ? ' is-default' : ''}`}>
      <div className="resume-head">
        {editing ? (
          <input className="title-input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        ) : (
          <h3>
            {resume.title} {resume.isDefault && <span className="pill pill-entry">Default</span>}
          </h3>
        )}
        <span className="muted small">
          {resume.fileName} · {formatDate(resume.createdAt)}
          {resume.parseStatus !== 'parsed' && <span className="warn"> · {PARSE_LABEL[resume.parseStatus]}</span>}
        </span>
      </div>
      {error && <p className="error">{error.message}</p>}
      <div className="row-actions">
        {editing ? (
          <>
            <button className="btn btn-small" disabled={save.isPending || !title.trim()} onClick={() => save.mutate({ title: title.trim() })}>
              Save
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => { setEditing(false); setTitle(resume.title); }}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>Rename</button>
            {!resume.isDefault && (
              <button className="btn btn-small btn-ghost" disabled={save.isPending} onClick={() => save.mutate({ isDefault: true })}>
                Make default
              </button>
            )}
            <button className="btn btn-small btn-ghost" onClick={() => setPreview((p) => !p)} aria-expanded={preview}>
              {preview ? 'Hide preview' : 'Preview'}
            </button>
            <a className="btn btn-small btn-ghost" href={`/api/me/resumes/${resume.id}/file`}>Download</a>
            {resume.hasSource && (
              <a className="btn btn-small btn-ghost" href={`/resumes/latex?id=${resume.id}`}>Edit LaTeX</a>
            )}
            <button className="btn btn-small btn-ghost" onClick={() => setReview((r) => !r)} aria-expanded={review}>
              {review ? 'Hide details' : 'Review details'}
            </button>
            <button
              className="btn btn-small btn-danger"
              disabled={remove.isPending}
              onClick={() => window.confirm(`Delete “${resume.title}”? The file is removed for good.`) && remove.mutate()}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {preview && <Preview resume={resume} />}
      {review && <ParsedDetails id={resume.id} />}
    </div>
  );
}

function Preview({ resume }) {
  // Keyed by the row's last change, so a replaced file is fetched again.
  const { data, isLoading, error } = usePrivateQuery(['resume-file', resume.id, resume.updatedAt || resume.sizeBytes], `/api/me/resumes/${resume.id}/file`, {
    queryFn: () => apiBlob(`/api/me/resumes/${resume.id}/file`),
    staleTime: 5 * 60_000,
  });
  const isPdf = resume.mimeType === 'application/pdf';
  return (
    <div className="resume-preview">
      {isLoading && <div className="skeleton skeleton-row" />}
      {error && <p className="error">{error.message}</p>}
      {data && (
        <Suspense fallback={<div className="skeleton skeleton-row" />}>
          {isPdf ? <PdfViewer data={data} label={`Preview of ${resume.title}`} /> : <DocxViewer data={data} />}
        </Suspense>
      )}
    </div>
  );
}

function ParsedDetails({ id }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = usePrivateQuery(['resume', id], `/api/me/resumes/${id}`);
  const [imported, setImported] = useState(null);
  const fill = useMutation({
    mutationFn: () => api(`/api/me/profile/import/${id}`, { method: 'POST', body: {} }),
    onSuccess: (d) => {
      setImported(d.changed);
      qc.setQueryData(['profile'], d);
    },
  });
  const reparse = useMutation({
    mutationFn: () => api(`/api/me/resumes/${id}/reparse`, { method: 'POST', body: {} }),
    onSuccess: (d) => {
      qc.setQueryData(['resume', id], d);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
  if (isLoading) return <div className="skeleton skeleton-row" />;
  if (error) return <p className="error">{error.message}</p>;
  const p = data.parsed;
  if (!p) {
    return (
      <div className="parsed">
        <p className="muted">Nothing could be read from this file. If it's a scan, upload a PDF exported from Word or Google Docs.</p>
        <button className="btn btn-small btn-ghost" disabled={reparse.isPending} onClick={() => reparse.mutate()}>Read again</button>
      </div>
    );
  }
  const name = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
  return (
    <div className="parsed">
      <dl className="parsed-grid">
        <dt>Name</dt><dd>{name || '—'}</dd>
        <dt>Email</dt><dd>{p.emails?.join(', ') || '—'}</dd>
        <dt>Phone</dt><dd>{p.phone ? `${p.phoneCountryCode} ${p.phone}` : '—'}</dd>
        <dt>Location</dt><dd>{[p.city, p.state, p.country].filter(Boolean).join(', ') || '—'}</dd>
        <dt>Links</dt><dd>{[p.linkedin, p.github, p.portfolio].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Education</dt>
        <dd>
          {p.education?.length
            ? p.education.map((e, i) => <div key={i}>{[e.degree, e.field].filter(Boolean).join(', ')} — {e.school} {e.endDate && `(${e.endDate})`}</div>)
            : '—'}
        </dd>
        <dt>Experience</dt>
        <dd>
          {p.experience?.length
            ? p.experience.map((e, i) => <div key={i}>{e.title} at {e.company} {e.startDate && `(${e.startDate} – ${e.current ? 'now' : e.endDate})`}</div>)
            : '—'}
        </dd>
        <dt>Skills</dt><dd>{p.skills?.join(', ') || '—'}</dd>
      </dl>
      {p.missing?.length > 0 && <p className="muted small">Not found: {p.missing.join(', ')}.</p>}
      {fill.error && <p className="error">{fill.error.message}</p>}
      {imported && (
        <p className="success">
          {imported.length ? `Updated ${imported.length} profile fields.` : 'Your profile already has all of this.'} Fields you typed yourself are never replaced.
        </p>
      )}
      <div className="row-actions">
        <button className="btn btn-small" disabled={fill.isPending} onClick={() => fill.mutate()}>Fill my profile from this resume</button>
        <button className="btn btn-small btn-ghost" disabled={reparse.isPending} onClick={() => reparse.mutate()}>Read again</button>
      </div>
    </div>
  );
}
