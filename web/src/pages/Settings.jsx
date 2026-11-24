import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ME, api, formatBytes, formatDate, useAccount, usePrivateQuery, useSignOut } from '../account.js';
import RequireAuth, { ReauthNotice } from '../components/RequireAuth.jsx';
import { Link, navigate } from '../router.jsx';

export default function Settings() {
  return (
    <RequireAuth reason="Sign in to manage connectors, extension tokens, saved answers and your account.">
      <SettingsPage />
    </RequireAuth>
  );
}

function SettingsPage() {
  const { data: me } = useAccount();
  return (
    <>
      <div className="page-head">
        <h2>Settings</h2>
        <p className="muted">
          Signed in as {me.user.name} ({me.user.email}).
        </p>
      </div>
      <Connectors />
      <Tokens />
      <Answers />
      <AccountActions />
      {me.owner && <Usage />}
    </>
  );
}

// What Google's redirect back means (`?gmail=<result>` from
// /api/connectors/gmail/callback). Only these words are shown; anything else
// in the address is ignored.
const GMAIL_RESULTS = {
  connected: ['success', 'Gmail connected. The extension can now fill codes from it.'],
  denied: ['notice', "You didn't allow access on Google's screen, so nothing was connected."],
  scope: ['error', "Gmail read access wasn't ticked on Google's screen, so nothing was connected. Connect again and allow it."],
  state: ['error', "That sign-in didn't come from this page, so it was refused. Start again here."],
  expired: ['error', 'That sign-in took too long or started in another browser. Start again here.'],
  error: ['error', "Google sign-in didn't complete. Try again."],
  unavailable: ['error', "Gmail isn't set up on this server yet."],
};

function useGmailResult() {
  const [result] = useState(() => {
    const word = new URLSearchParams(window.location.search).get('gmail');
    return Object.hasOwn(GMAIL_RESULTS, word || '') ? word : null;
  });
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('gmail')) return;
    // Drop the result from the address so a reload doesn't show it again.
    const url = new URL(window.location.href);
    url.searchParams.delete('gmail');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);
  return result;
}

function Connectors() {
  const qc = useQueryClient();
  const ref = useRef(null);
  const result = useGmailResult();
  const [shown, setShown] = useState(result);
  const { data, isLoading, error } = usePrivateQuery(['connectors'], '/api/me/connectors');
  const connect = useMutation({
    mutationFn: async () => {
      const { url } = await api('/api/me/connectors/gmail/start', { method: 'POST', body: {} });
      // Only ever Google's own consent page, on Google's own address.
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com') throw new Error('Unexpected sign-in address.');
      window.location.assign(target.href);
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api('/api/me/connectors/gmail', { method: 'DELETE' }),
    onSuccess: () => {
      setShown(null);
      qc.invalidateQueries({ queryKey: ['connectors'] });
    },
  });
  useEffect(() => {
    if (result || window.location.hash === '#connectors') ref.current?.scrollIntoView({ block: 'start' });
  }, [result]);

  const gmail = data?.gmail;
  const [tone, message] = shown ? GMAIL_RESULTS[shown] : [];
  return (
    <section className="card section" id="connectors" ref={ref} aria-labelledby="connectors-title">
      <h3 id="connectors-title">Connectors</h3>
      <p className="muted small">Accounts you link so the extension can do more for you. Disconnect any time.</p>
      <div className="connector">
        <div className="connector-head">
          <strong>Gmail</strong>
          {gmail?.connected && <span className="pill pill-entry">Connected</span>}
        </div>
        <p className="muted small">
          When Workday or Greenhouse emails you a security code or a "verify your account" link mid-application, the
          extension asks this site for it and fills it in (it never presses submit). Read-only access through Google's
          own consent screen; only mail from those sites from the last 15 minutes is looked at, and only the code or
          link is used. No email is stored.
        </p>
        {message && (
          <p className={tone} role="status">
            {message}
          </p>
        )}
        {isLoading ? (
          <div className="skeleton skeleton-row" />
        ) : error ? (
          <p className="error">{error.message}</p>
        ) : !gmail?.available ? (
          <p className="muted small">Not set up on this server yet.</p>
        ) : gmail.connected ? (
          <>
            <dl className="parsed-grid connector-facts">
              <dt>Account</dt>
              <dd>{gmail.email}</dd>
              <dt>Access</dt>
              <dd>Read Gmail (read-only)</dd>
              <dt>Connected</dt>
              <dd>{formatDate(gmail.connectedAt)}</dd>
              <dt>Last used</dt>
              <dd>{gmail.lastUsedAt ? formatDate(gmail.lastUsedAt) : 'Not yet'}</dd>
            </dl>
            {disconnect.error && <p className="error">{disconnect.error.message}</p>}
            <div className="row-actions">
              <button className="btn btn-small btn-ghost" disabled={connect.isPending} onClick={() => connect.mutate()}>
                Reconnect
              </button>
              <button className="btn btn-small btn-danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            {connect.error && <p className="error">{connect.error.message}</p>}
            <div className="row-actions">
              <button className="btn btn-small" disabled={connect.isPending} onClick={() => connect.mutate()}>
                {connect.isPending ? 'Opening Google…' : 'Connect Gmail'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function Tokens() {
  const qc = useQueryClient();
  const { data, isLoading, error } = usePrivateQuery(['tokens'], '/api/me/tokens');
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api('/api/me/tokens', { method: 'POST', body: { label } }),
    onSuccess: (d) => {
      setFresh(d.token);
      setCopied(false);
      setLabel('');
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id) => api(`/api/me/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tokens'] }),
  });

  return (
    <section className="card section">
      <h3>Autofill extension</h3>
      <p className="muted small">
        Paste a token into the extension to connect it. It can only read your profile and resumes and save answers.
        Revoke it any time.
      </p>
      {fresh && (
        <div className="token-once">
          <p>
            <strong>Copy this token now.</strong> It won't be shown again.
          </p>
          <code>{fresh}</code>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => navigator.clipboard?.writeText(fresh).then(() => setCopied(true))}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <ReauthNotice error={create.error} onDone={() => create.reset()} />
      {create.error && create.error.code !== 'reauth' && <p className="error">{create.error.message}</p>}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Name, e.g. Laptop Chrome" aria-label="Token name" />
        <button className="btn btn-small" disabled={create.isPending || (data && data.tokens.length >= data.max)}>
          Create token
        </button>
      </form>
      {isLoading ? (
        <div className="skeleton skeleton-row" />
      ) : error ? (
        <p className="error">{error.message}</p>
      ) : data.tokens.length === 0 ? (
        <p className="muted small">No tokens yet.</p>
      ) : (
        <table className="simple-table">
          <thead>
            <tr><th>Name</th><th>Starts with</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr>
          </thead>
          <tbody>
            {data.tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td><code>{t.prefix}…</code></td>
                <td>{formatDate(t.createdAt)}</td>
                <td>{t.lastUsedAt ? formatDate(t.lastUsedAt) : 'Never'}</td>
                <td>{formatDate(t.expiresAt)}</td>
                <td>
                  <button className="btn btn-small btn-danger" disabled={revoke.isPending} onClick={() => revoke.mutate(t.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Answers() {
  const qc = useQueryClient();
  const { data, isLoading, error } = usePrivateQuery(['answers'], '/api/me/answers');
  const [draft, setDraft] = useState({ question: '', answer: '', company: '' });
  const save = useMutation({
    mutationFn: (a) =>
      api('/api/me/answers', {
        method: 'PUT',
        body: { question: a.question, answer: a.answer, scope: a.company.trim() ? 'company' : 'global', company: a.company },
      }),
    onSuccess: () => {
      setDraft({ question: '', answer: '', company: '' });
      qc.invalidateQueries({ queryKey: ['answers'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id) => api(`/api/me/answers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['answers'] }),
  });

  return (
    <section className="card section">
      <h3>Saved answers</h3>
      <p className="muted small">
        Your answers to questions not in your <Link to="/profile">profile</Link>. The extension fills them when a form
        asks the same question, and adds new ones after you submit.
      </p>
      {isLoading ? (
        <div className="skeleton skeleton-row" />
      ) : error ? (
        <p className="error">{error.message}</p>
      ) : data.answers.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="answer-list">
          {data.answers.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.question}</strong> {a.scope === 'company' && <span className="pill">{a.company}</span>}
                <p className="answer-text">{a.answer}</p>
              </div>
              <div className="row-actions">
                <button className="btn btn-small btn-ghost" onClick={() => setDraft({ question: a.question, answer: a.answer, company: a.company })}>
                  Edit
                </button>
                <button className="btn btn-small btn-danger" disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="answer-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(draft);
        }}
      >
        <label className="field field-wide">
          <span>Question</span>
          <input value={draft.question} maxLength={500} required onChange={(e) => setDraft({ ...draft, question: e.target.value })} />
        </label>
        <label className="field field-wide">
          <span>Answer</span>
          <textarea rows={3} value={draft.answer} maxLength={4000} required onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
        </label>
        <label className="field">
          <span>Only for this company (optional)</span>
          <input value={draft.company} maxLength={100} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
        </label>
        {save.error && <p className="error">{save.error.message}</p>}
        <button className="btn btn-small" disabled={save.isPending}>Save answer</button>
      </form>
    </section>
  );
}

function AccountActions() {
  const qc = useQueryClient();
  const signOut = useSignOut();
  const [confirm, setConfirm] = useState('');
  const exportData = useMutation({
    mutationFn: () => api('/api/me/export'),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jobboard-export.json';
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  const remove = useMutation({
    mutationFn: () => api('/api/me', { method: 'DELETE' }),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(ME, { user: null });
      navigate('/');
    },
  });
  const reauth = exportData.error?.code === 'reauth' ? exportData.error : remove.error?.code === 'reauth' ? remove.error : null;

  return (
    <section className="card section">
      <h3>Your account</h3>
      <ReauthNotice error={reauth} onDone={() => { exportData.reset(); remove.reset(); }} />
      <div className="account-actions">
        <div>
          <strong>Download your data</strong>
          <p className="muted small">Your profile, resume details and saved answers as one file.</p>
          {exportData.error && !reauth && <p className="error">{exportData.error.message}</p>}
          <button className="btn btn-small btn-ghost" disabled={exportData.isPending} onClick={() => exportData.mutate()}>
            Download
          </button>
        </div>
        <div>
          <strong>Sign out everywhere</strong>
          <p className="muted small">Signs you out on every device. Extension tokens keep working.</p>
          <button className="btn btn-small btn-ghost" onClick={() => signOut(true)}>Sign out everywhere</button>
        </div>
        <div>
          <strong>Delete your account</strong>
          <p className="muted small">Deletes everything: profile, resumes, answers and tokens. Can't be undone.</p>
          {remove.error && !reauth && <p className="error">{remove.error.message}</p>}
          <div className="inline-form">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder='Type "delete" to confirm' aria-label="Confirm deletion" />
            <button className="btn btn-small btn-danger" disabled={confirm.trim().toLowerCase() !== 'delete' || remove.isPending} onClick={() => remove.mutate()}>
              Delete account
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Usage() {
  const { data, error } = usePrivateQuery(['usage'], '/api/admin/usage');
  if (error) return null;
  if (!data) return null;
  const u = data.usage;
  return (
    <section className="card section">
      <h3>Usage (owner only)</h3>
      <dl className="parsed-grid">
        <dt>Users</dt><dd>{u.users} ({u.usersLast30Days} active in 30 days){data.maxUsers ? ` of ${data.maxUsers}` : ''}</dd>
        <dt>Sign-ups</dt><dd>{data.signupsOpen ? 'Open' : 'Closed (allowlist only)'}</dd>
        <dt>Resumes</dt><dd>{u.resumes} · {formatBytes(u.resumeBytes)} of {formatBytes(data.maxStorageBytes)} ({data.storage})</dd>
        <dt>Saved answers</dt><dd>{u.answers}</dd>
        <dt>Active tokens</dt><dd>{u.tokens}</dd>
        <dt>Files waiting to delete</dt><dd>{u.pendingDeletions}</dd>
        <dt>Accounts tables in Postgres</dt><dd>{formatBytes(u.accountsTableBytes)}</dd>
      </dl>
    </section>
  );
}
