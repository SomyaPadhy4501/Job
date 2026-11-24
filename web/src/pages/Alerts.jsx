import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, usePrivateQuery } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
import { Link } from '../router.jsx';
import { webHref } from '../safe-url.js';

// Saved searches that send the new jobs matching them to the user's linked
// Telegram chat. Filters are the board's own; the server checks every value
// again, and refuses a new alert until Telegram is linked.

const ROLES = [
  ['', 'Any role type'],
  ['SWE', 'SWE / SDE'],
  ['MLE', 'ML Engineer'],
  ['AI', 'AI / Research'],
  ['DS', 'Data Scientist'],
  ['DATA_ENG', 'Data Engineer'],
  ['SRE', 'DevOps / SRE'],
  ['SECURITY', 'Security'],
  ['MOBILE', 'Mobile'],
];
const LEVELS = [
  ['', 'Any level (entry + mid)'],
  ['entry', 'Entry-level only'],
  ['mid', 'Mid-level (1-2 YOE)'],
  ['early', 'Entry or mid'],
];
const SPONSORSHIP = [
  ['YES', 'Sponsors visas (confirmed)'],
  ['', 'Any sponsorship'],
  ['NO', 'Sponsorship: NO'],
  ['UNKNOWN', 'Sponsorship: UNKNOWN'],
];
const RESTRICTION = [
  ['hide', 'Hide no-sponsorship / ITAR / clearance'],
  ['all', 'Show all roles'],
  ['only', 'Only restricted roles'],
];
const FREQUENCY = [
  ['instant', 'After each update (about every 3 hours)'],
  ['daily', 'Daily digest'],
  ['weekly', 'Weekly digest'],
];

const EMPTY = {
  name: '',
  filters: { role: '', level: '', sponsorship: 'YES', restriction: 'hide', companies: [], keywords: [], locations: [] },
  frequency: 'daily',
  channels: ['telegram'],
  paused: false,
};

const label = (list, v) => list.find(([k]) => k === v)?.[1] ?? v;
const toList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function Alerts() {
  return (
    <RequireAuth reason="Sign in to get new jobs on Telegram.">
      <AlertsPage />
    </RequireAuth>
  );
}

function AlertsPage() {
  const { data, isLoading, error } = usePrivateQuery(['alerts'], '/api/me/alerts');
  const chat = usePrivateQuery(['chat'], '/api/me/chat');
  const [editing, setEditing] = useState(null);
  const linked = !!chat.data?.telegram?.linked;
  const ready = !!chat.data?.telegram?.ready;

  return (
    <>
      <div className="page-head">
        <h2>Job alerts</h2>
        <p className="muted">Get new jobs that match your search on Telegram.</p>
      </div>
      {chat.data && ready && !linked && (
        <p className="notice">Link Telegram below first. Alerts are sent to your Telegram chat.</p>
      )}
      <TelegramCard status={chat} />
      <section className="card section">
        <div className="section-head-row">
          <h3>Your alerts</h3>
          {!editing && data && (
            <button
              className="btn btn-small"
              disabled={!linked || data.alerts.length >= data.max}
              title={linked ? undefined : 'Link Telegram first'}
              onClick={() => setEditing(EMPTY)}
            >
              New alert
            </button>
          )}
        </div>
        {editing && <AlertForm initial={editing} onDone={() => setEditing(null)} />}
        {isLoading ? (
          <div className="skeleton skeleton-row" />
        ) : error ? (
          <p className="error">{error.message}</p>
        ) : data.alerts.length === 0 ? (
          !editing && <p className="muted small">No alerts yet. Make one to hear about new jobs first.</p>
        ) : (
          <ul className="alert-list">
            {data.alerts.map((a) => (
              <AlertRow key={a.id} alert={a} linked={linked} onEdit={() => setEditing(a)} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function summary(f) {
  const parts = [label(ROLES, f.role), label(LEVELS, f.level), label(SPONSORSHIP, f.sponsorship)];
  if (f.restriction !== 'hide') parts.push(label(RESTRICTION, f.restriction));
  if (f.companies.length) parts.push(`at ${f.companies.join(', ')}`);
  if (f.keywords.length) parts.push(`title has ${f.keywords.join(' or ')}`);
  if (f.locations.length) parts.push(`in ${f.locations.join(' or ')}`);
  return parts.join(' · ');
}

function AlertRow({ alert, linked, onEdit }) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState(false);
  const save = useMutation({
    mutationFn: (body) => api(`/api/me/alerts/${alert.id}`, { method: 'PUT', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/me/alerts/${alert.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });
  const where = linked ? 'Telegram' : 'Telegram isn’t linked, so nothing is sent';

  return (
    <li>
      <div className="alert-main">
        <strong>{alert.name}</strong> {alert.paused && <span className="pill">Paused</span>}
        <p className="muted small">{summary(alert.filters)}</p>
        <p className="muted small">
          {label(FREQUENCY, alert.frequency)} · {where}
          {alert.lastSentAt ? ` · last sent ${formatDate(alert.lastSentAt)}` : ''}
        </p>
        {(save.error || remove.error) && <p className="error">{(save.error || remove.error).message}</p>}
        {preview && <Preview id={alert.id} />}
      </div>
      <div className="row-actions">
        <button className="btn btn-small btn-ghost" onClick={() => setPreview((p) => !p)}>
          {preview ? 'Hide matches' : 'See matches'}
        </button>
        <button className="btn btn-small btn-ghost" onClick={onEdit}>Edit</button>
        <button
          className="btn btn-small btn-ghost"
          disabled={save.isPending}
          onClick={() => save.mutate({ ...alert, paused: !alert.paused })}
        >
          {alert.paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn btn-small btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Delete
        </button>
      </div>
    </li>
  );
}

function Preview({ id }) {
  const { data, isLoading, error } = usePrivateQuery(['alerts', id, 'preview'], `/api/me/alerts/${id}/preview`);
  if (isLoading) return <div className="skeleton skeleton-row" />;
  if (error) return <p className="error">{error.message}</p>;
  if (!data.jobs.length) return <p className="muted small">Nothing on the board matches this right now.</p>;
  return (
    <ul className="match-list">
      {data.jobs.map((j) => (
        <li key={j.id}>
          <a href={webHref(j.applyUrl)} target="_blank" rel="noopener noreferrer">{j.jobTitle}</a>
          <span className="muted small"> · {j.companyName}{j.location ? ` · ${j.location}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

function AlertForm({ initial, onDone }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [lists, setLists] = useState({
    companies: initial.filters.companies.join(', '),
    keywords: initial.filters.keywords.join(', '),
    locations: initial.filters.locations.join(', '),
  });
  const setFilter = (k, v) => setDraft({ ...draft, filters: { ...draft.filters, [k]: v } });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...draft,
        channels: ['telegram'],
        filters: { ...draft.filters, companies: toList(lists.companies), keywords: toList(lists.keywords), locations: toList(lists.locations) },
      };
      return initial.id
        ? api(`/api/me/alerts/${initial.id}`, { method: 'PUT', body })
        : api('/api/me/alerts', { method: 'POST', body });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      onDone();
    },
  });
  const select = (key, options) => (
    <select value={draft.filters[key]} onChange={(e) => setFilter(key, e.target.value)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );

  return (
    <form
      className="alert-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="form-grid">
        <label className="field field-wide">
          <span>Name</span>
          <input value={draft.name} maxLength={60} placeholder="e.g. Backend new grad, sponsors" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field"><span>Role</span>{select('role', ROLES)}</label>
        <label className="field"><span>Level</span>{select('level', LEVELS)}</label>
        <label className="field"><span>Sponsorship</span>{select('sponsorship', SPONSORSHIP)}</label>
        <label className="field"><span>Restricted roles</span>{select('restriction', RESTRICTION)}</label>
        <label className="field field-wide">
          <span>Words in the title (comma-separated, any of them)</span>
          <input value={lists.keywords} placeholder="backend, infrastructure" onChange={(e) => setLists({ ...lists, keywords: e.target.value })} />
        </label>
        <label className="field field-wide">
          <span>Only these companies (comma-separated, optional)</span>
          <input value={lists.companies} placeholder="Stripe, Datadog" onChange={(e) => setLists({ ...lists, companies: e.target.value })} />
        </label>
        <label className="field field-wide">
          <span>Locations (comma-separated, any of them)</span>
          <input value={lists.locations} placeholder="New York, Remote" onChange={(e) => setLists({ ...lists, locations: e.target.value })} />
        </label>
        <label className="field">
          <span>How often</span>
          <select value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value })}>
            {FREQUENCY.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      </div>
      {save.error && <p className="error">{save.error.message}</p>}
      <div className="row-actions">
        <button className="btn btn-small" disabled={save.isPending}>{initial.id ? 'Save alert' : 'Create alert'}</button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function TelegramCard({ status }) {
  const qc = useQueryClient();
  const [code, setCode] = useState(null);
  const tg = status.data?.telegram;
  const newCode = useMutation({
    mutationFn: () => api('/api/me/chat/telegram', { method: 'POST', body: {} }),
    onSuccess: setCode,
  });
  const unlink = useMutation({
    mutationFn: () => api('/api/me/chat/telegram', { method: 'DELETE' }),
    onSuccess: () => {
      setCode(null);
      qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });

  return (
    <section className="card section">
      <h3>Telegram</h3>
      {status.isLoading ? (
        <div className="skeleton skeleton-row" />
      ) : status.error ? (
        <p className="error">{status.error.message}</p>
      ) : !tg.ready ? (
        <p className="muted small">Telegram isn’t switched on for this site yet.</p>
      ) : tg.linked ? (
        <>
          <p className="small">
            Linked. Send <code>/jobs</code>, <code>/alerts</code>, <code>/pause</code> or <code>/apply 1234</code> to the bot.
          </p>
          {unlink.error && <p className="error">{unlink.error.message}</p>}
          <button className="btn btn-small btn-danger" disabled={unlink.isPending} onClick={() => unlink.mutate()}>
            Unlink Telegram
          </button>
        </>
      ) : (
        <>
          <p className="muted small">
            Get alerts in Telegram and ask the bot for new jobs. Your Telegram chat is stored encrypted.
          </p>
          {code ? (
            <div className="token-once">
              <p>
                {code.link ? (
                  <>
                    <a href={code.link} target="_blank" rel="noopener noreferrer">Open the bot in Telegram</a> and press
                    Start, or send it{' '}
                  </>
                ) : (
                  'Send the bot '
                )}
                <code>/link {code.code}</code>. The code works once, for {code.minutes} minutes.
              </p>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => qc.invalidateQueries({ queryKey: ['chat'] })}>
                I sent it
              </button>
            </div>
          ) : (
            <button className="btn btn-small" disabled={newCode.isPending} onClick={() => newCode.mutate()}>
              Link Telegram
            </button>
          )}
          {newCode.error && <p className="error">{newCode.error.message}</p>}
        </>
      )}
      <p className="muted small">
        Jobs you send to the bot with <code>/apply</code> land in your <Link to="/queue">apply queue</Link>.
      </p>
    </section>
  );
}
