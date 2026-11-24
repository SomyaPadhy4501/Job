import { lazy, Suspense, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiBlob, formatBytes, formatDate, usePrivateQuery } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
import TagInput from '../components/TagInput.jsx';
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
    <RequireAuth reason="Sign in to keep your resumes, each with its own title and tags, for autofill.">
      <ResumesPage />
    </RequireAuth>
  );
}

function ResumesPage() {
  const { data, isLoading, error } = usePrivateQuery(KEY, '/api/me/resumes');
  if (isLoading) return <div className="card"><div className="skeleton skeleton-row" /></div>;
  if (error) return <div className="card error">{error.message}</div>;
  const { resumes, limits, suggestedTags, storage } = data;
  return (
    <>
      <div className="page-head">
        <h2>Resumes</h2>
        <p className="muted">
          Keep a resume per kind of role and tag it (SWE, AI Engineer, Platform…). The extension picks the best match for
          each job, and your <Link to="/profile">profile</Link> is filled from what it reads.
        </p>
      </div>
      {storage ? (
        <UploadCard limits={limits} suggestedTags={suggestedTags} full={resumes.length >= limits.maxResumes} />
      ) : (
        <div className="card notice">Resume uploads aren't available on this server yet.</div>
      )}
      {resumes.length === 0 ? (
        <div className="card muted">No resumes yet.</div>
      ) : (
        <div className="resume-list">
          {resumes.map((r) => (
            <ResumeCard key={r.id} resume={r} suggestedTags={suggestedTags} />
          ))}
        </div>
      )}
      <p className="muted small">
        {resumes.length} of {limits.maxResumes} resumes · {formatBytes(limits.usedBytes)} of {formatBytes(limits.maxTotalBytes)} ·{' '}
        {limits.uploadsToday} of {limits.uploadsPerDay} uploads today
      </p>
    </>
  );
}

function UploadCard({ limits, suggestedTags, full }) {
  const qc = useQueryClient();
  const fileInput = useRef(null);
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState([]);
  const [result, setResult] = useState(null);
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('title', title);
      form.append('tags', JSON.stringify(tags));
      form.append('file', file);
      return api('/api/me/resumes', { method: 'POST', form });
    },
    onSuccess: (data) => {
      setResult(data);
      setFile(null);
      setTitle('');
      setTags([]);
      if (fileInput.current) fileInput.current.value = '';
      qc.invalidateQueries({ queryKey: KEY });
      if (data.imported?.length) qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });

  const tooBig = file && file.size > limits.maxFileBytes;
  return (
    <form
      className="card upload-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !tooBig) upload.mutate();
      }}
    >
      <h3>Add a resume</h3>
      <div className="form-grid">
        <label className="field">
          <span>File (PDF or Word .docx, up to {formatBytes(limits.maxFileBytes)})</span>
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setResult(null);
              upload.reset();
            }}
            disabled={full}
          />
        </label>
        <label className="field">
          <span>Title (optional)</span>
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. ML / AI Engineer" />
        </label>
        <div className="field field-wide">
          <span>Tags</span>
          <TagInput value={tags} onChange={setTags} suggestions={suggestedTags} />
        </div>
      </div>
      {tooBig && <p className="error">That file is over {formatBytes(limits.maxFileBytes)}.</p>}
      {full && <p className="notice">You have the most resumes allowed. Delete one to add another.</p>}
      {upload.error && <p className="error">{upload.error.message}</p>}
      {result && (
        <p className="success">
          Uploaded “{result.resume.title}”.{' '}
          {result.resume.parseStatus === 'parsed'
            ? result.imported?.length
              ? `Filled ${result.imported.length} profile fields from it; check them on your profile.`
              : 'Its details are ready to review below.'
            : PARSE_LABEL[result.resume.parseStatus]}
        </p>
      )}
      <button className="btn" disabled={!file || tooBig || full || upload.isPending}>
        {upload.isPending ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}

function ResumeCard({ resume, suggestedTags }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(resume.title);
  const [tags, setTags] = useState(resume.tags);
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
          {resume.fileName} · {formatBytes(resume.sizeBytes)} · added {formatDate(resume.createdAt)} ·{' '}
          <span className={resume.parseStatus === 'parsed' ? '' : 'warn'}>{PARSE_LABEL[resume.parseStatus]}</span>
        </span>
      </div>
      {editing ? (
        <TagInput value={tags} onChange={setTags} suggestions={suggestedTags} />
      ) : (
        <div className="tag-list">
          {resume.tags.length ? resume.tags.map((t) => <span key={t} className="pill">{t}</span>) : <span className="muted small">No tags</span>}
        </div>
      )}
      {error && <p className="error">{error.message}</p>}
      <div className="row-actions">
        {editing ? (
          <>
            <button className="btn btn-small" disabled={save.isPending} onClick={() => save.mutate({ title, tags })}>
              Save
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => { setEditing(false); setTitle(resume.title); setTags(resume.tags); }}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>Edit title & tags</button>
            {!resume.isDefault && (
              <button className="btn btn-small btn-ghost" disabled={save.isPending} onClick={() => save.mutate({ isDefault: true })}>
                Make default
              </button>
            )}
            <button className="btn btn-small btn-ghost" onClick={() => setPreview((p) => !p)} aria-expanded={preview}>
              {preview ? 'Hide preview' : 'Preview'}
            </button>
            <a className="btn btn-small btn-ghost" href={`/api/me/resumes/${resume.id}/file`}>Download</a>
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
