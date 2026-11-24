import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, usePrivateQuery } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
import { webHref } from '../safe-url.js';

// The apply queue: jobs the user means to apply to. Jobs arrive from alert
// emails ("Add to my apply queue"), the Telegram bot (/apply) or a pasted
// link. Nothing here, or anywhere, submits an application: the user opens
// the job and submits it, then marks it applied.

const STATUS = {
  queued: 'To apply',
  prepared: 'Ready for you to submit',
  needs_you: 'Needs you',
  submitted_by_you: 'You applied',
  skipped: 'Skipped',
};

export default function Queue() {
  return (
    <RequireAuth reason="Sign in to keep a list of jobs to apply to.">
      <QueuePage />
    </RequireAuth>
  );
}

function QueuePage() {
  const { data, isLoading, error } = usePrivateQuery(['queue'], '/api/me/queue');
  const open = data?.items.filter((i) => !['submitted_by_you', 'skipped'].includes(i.status)) ?? [];
  const done = data?.items.filter((i) => ['submitted_by_you', 'skipped'].includes(i.status)) ?? [];

  return (
    <>
      <div className="page-head">
        <h2>Apply queue</h2>
        <p className="muted">Jobs you mean to apply to. You submit each application yourself.</p>
      </div>
      <AddFromLink />
      <AddForm />
      <section className="card section">
        <h3>To do</h3>
        {isLoading ? (
          <div className="skeleton skeleton-row" />
        ) : error ? (
          <p className="error">{error.message}</p>
        ) : open.length === 0 ? (
          <p className="muted small">Nothing queued. Add jobs from alert emails, the Telegram bot, or a link above.</p>
        ) : (
          <ul className="queue-list">
            {open.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
      {done.length > 0 && (
        <section className="card section">
          <h3>Done</h3>
          <ul className="queue-list">
            {done.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// `/queue?add=1234`, the link in alert emails: asks before adding.
function AddFromLink() {
  const qc = useQueryClient();
  const [jobId] = useState(() => Number(new URLSearchParams(window.location.search).get('add')) || null);
  const [gone, setGone] = useState(false);
  const add = useMutation({
    mutationFn: () => api('/api/me/queue', { method: 'POST', body: { jobId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue'] });
      setGone(true);
    },
  });
  useEffect(() => {
    if (gone) window.history.replaceState(null, '', window.location.pathname);
  }, [gone]);
  if (!jobId || gone) return null;
  return (
    <section className="card section">
      <p>Add job #{jobId} from your alert to the queue?</p>
      {add.error && <p className="error">{add.error.message}</p>}
      <div className="row-actions">
        <button className="btn btn-small" disabled={add.isPending} onClick={() => add.mutate()}>Add to queue</button>
        <button className="btn btn-small btn-ghost" onClick={() => setGone(true)}>No thanks</button>
      </div>
    </section>
  );
}

function AddForm() {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const add = useMutation({
    mutationFn: () => api('/api/me/queue', { method: 'POST', body: { url: url.trim() } }),
    onSuccess: () => {
      setUrl('');
      qc.invalidateQueries({ queryKey: ['queue'] });
    },
  });
  return (
    <section className="card section">
      <h3>Add a job</h3>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <input
          value={url}
          required
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste the job’s apply link from the board"
          aria-label="Job link"
        />
        <button className="btn btn-small" disabled={add.isPending}>Add</button>
      </form>
      {add.error && <p className="error">{add.error.message}</p>}
    </section>
  );
}

function Item({ item }) {
  const qc = useQueryClient();
  const [history, setHistory] = useState(false);
  const set = useMutation({
    mutationFn: (status) => api(`/api/me/queue/${item.id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/me/queue/${item.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue'] }),
  });
  const href = webHref(item.applyUrl);

  return (
    <li>
      <div className="alert-main">
        <strong>{item.title}</strong> <span className="muted">· {item.company}</span>{' '}
        <span className={`pill queue-${item.status}`}>{STATUS[item.status] ?? item.status}</span>
        {item.note && <p className="small">{item.note}</p>}
        <p className="muted small">
          Added {formatDate(item.createdAt)}
          {item.addedVia !== 'you' ? ` from ${item.addedVia}` : ''}
        </p>
        {(set.error || remove.error) && <p className="error">{(set.error || remove.error).message}</p>}
        {history && <History id={item.id} />}
      </div>
      <div className="row-actions">
        {href && (
          <a className="btn btn-small" href={href} target="_blank" rel="noopener noreferrer">Open the job</a>
        )}
        {item.status !== 'submitted_by_you' && (
          <button className="btn btn-small btn-ghost" disabled={set.isPending} onClick={() => set.mutate('submitted_by_you')}>
            I applied
          </button>
        )}
        {item.status !== 'skipped' && item.status !== 'submitted_by_you' && (
          <button className="btn btn-small btn-ghost" disabled={set.isPending} onClick={() => set.mutate('skipped')}>
            Skip
          </button>
        )}
        {(item.status === 'skipped' || item.status === 'submitted_by_you') && (
          <button className="btn btn-small btn-ghost" disabled={set.isPending} onClick={() => set.mutate('queued')}>
            Back to the queue
          </button>
        )}
        <button className="btn btn-small btn-ghost" onClick={() => setHistory((h) => !h)}>
          {history ? 'Hide history' : 'History'}
        </button>
        <button className="btn btn-small btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Remove
        </button>
      </div>
    </li>
  );
}

function History({ id }) {
  const { data, isLoading, error } = usePrivateQuery(['queue', id, 'events'], `/api/me/queue/${id}/events`);
  if (isLoading) return <div className="skeleton skeleton-row" />;
  if (error) return <p className="error">{error.message}</p>;
  return (
    <ul className="match-list">
      {data.events.map((e, i) => (
        <li key={i} className="small">
          {formatDate(e.createdAt)} · {e.actor === 'you' ? 'You' : e.actor}:{' '}
          {e.action === 'refused'
            ? `tried to set “${STATUS[e.toStatus] ?? e.toStatus}” (not allowed)`
            : e.action === 'add'
              ? 'added it'
              : e.action === 'status'
                ? `${STATUS[e.fromStatus] ?? e.fromStatus} → ${STATUS[e.toStatus] ?? e.toStatus}`
                : e.action}
        </li>
      ))}
    </ul>
  );
}
