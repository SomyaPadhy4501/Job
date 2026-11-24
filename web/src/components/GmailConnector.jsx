import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, usePrivateQuery } from '../account.js';

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

// The Gmail box inside the Connectors card (Alerts & Connectors tab).
export function GmailConnector() {
  const qc = useQueryClient();
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
    if (result || window.location.hash === '#connectors') document.getElementById('connectors')?.scrollIntoView({ block: 'start' });
  }, [result]);

  const gmail = data?.gmail;
  const [tone, message] = shown ? GMAIL_RESULTS[shown] : [];
  return (
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
  );
}
