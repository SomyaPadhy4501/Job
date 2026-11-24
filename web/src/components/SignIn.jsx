import { useEffect, useRef, useState } from 'react';
import { api, useSignedIn } from '../account.js';
import { Link } from '../router.jsx';
import { SITE_HOST, signInWorksHere } from '../site.js';

// Google Identity Services: the server hands out a nonce (also set in an
// HttpOnly cookie); Google puts it in the ID token; the server checks both
// match. Locally, the dev server offers an email-only sign-in instead.

let gsiPromise = null;
function loadGsi() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gsiPromise = null;
        reject(new Error("Couldn't load Google sign-in."));
      };
      document.head.appendChild(s);
    });
  }
  return gsiPromise;
}

export default function SignIn({ title = 'Sign in', reason, onDone }) {
  const button = useRef(null);
  const signedIn = useSignedIn();
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [devEmail, setDevEmail] = useState('');

  useEffect(() => {
    let alive = true;
    api('/api/auth/config')
      .then((c) => alive && setConfig(c))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!config?.clientId || !button.current || !signInWorksHere()) return;
    let alive = true;
    loadGsi()
      .then(() => {
        if (!alive) return;
        window.google.accounts.id.initialize({
          client_id: config.clientId,
          nonce: config.nonce,
          ux_mode: 'popup',
          callback: async ({ credential }) => {
            setBusy(true);
            setError('');
            try {
              const data = await api('/api/auth/google', { method: 'POST', body: { credential } });
              signedIn(data);
              onDone?.();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          },
        });
        window.google.accounts.id.renderButton(button.current, { theme: 'outline', size: 'large', text: 'continue_with' });
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [config]);

  async function devLogin(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/auth/dev-login', { method: 'POST', body: { email: devEmail } });
      signedIn(data);
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card signin-card">
      <h2>{title}</h2>
      {reason && <p className="muted">{reason}</p>}
      {config && !config.clientId && !config.devLogin && (
        <p className="notice">Sign-in isn't set up on this server yet.</p>
      )}
      {config?.clientId && !signInWorksHere() ? (
        <p className="notice">
          Google sign-in works on the main site only.{' '}
          <a href={`https://${SITE_HOST}${window.location.pathname}`}>Sign in at {SITE_HOST}</a>
        </p>
      ) : (
        <div ref={button} className="gsi-button" />
      )}
      {config?.devLogin && (
        <form className="dev-login" onSubmit={devLogin}>
          <label className="field">
            <span>Local sign-in (dev server only)</span>
            <input type="email" required value={devEmail} onChange={(e) => setDevEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <button className="btn" disabled={busy}>Sign in</button>
        </form>
      )}
      {busy && <p className="muted small">Signing in…</p>}
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        Your resumes and answers are private to your account and encrypted. <Link to="/privacy">Privacy</Link>
      </p>
    </div>
  );
}
