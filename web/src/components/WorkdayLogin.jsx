import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, useAccount, usePrivateQuery } from '../account.js';

// One Workday email and password for every company's Workday site. The
// extension reads them (GET /api/autofill/workday-login) to sign in and to
// fill the create-account form. This page never gets the password back.

const KEY = ['workday-login'];
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';
const GENERATED_LENGTH = 20;

// A uniform random index below n (rejection sampling: no modulo bias).
function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return buf[0] % n;
}

export function generatePassword(length = GENERATED_LENGTH) {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [UPPER, LOWER, DIGITS, SYMBOLS].map((set) => set[randomIndex(set.length)]);
  while (chars.length < length) chars.push(all[randomIndex(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// The server's rules, checked first so the message shows without a round trip.
export function passwordProblem(p) {
  const len = [...p].length;
  if (len < 12) return 'Use at least 12 characters.';
  if (len > 128) return 'Use at most 128 characters.';
  if (!(/\p{Lu}/u.test(p) && /\p{Ll}/u.test(p) && /[0-9]/.test(p) && /[^\p{L}\p{N}\s]/u.test(p))) {
    return 'Use upper and lower case letters, a number and a symbol.';
  }
  return null;
}

export default function WorkdayLogin() {
  const { data, isLoading, error } = usePrivateQuery(KEY, '/api/me/workday-login');
  const profile = usePrivateQuery(['profile'], '/api/me/profile');
  const { data: me } = useAccount();
  return (
    <section className="card section">
      <h3>Workday accounts</h3>
      <p className="muted small">
        One email and password for every company's Workday site. The extension signs you in with them, and fills them in
        when a company needs a new account (you still tick "I agree" and click <strong>Create Account</strong>). Stored
        encrypted; this page never shows the password again.
      </p>
      {isLoading || profile.isLoading ? (
        <div className="skeleton skeleton-row" />
      ) : error ? (
        <p className="error">{error.message}</p>
      ) : (
        <WorkdayForm saved={data} suggested={profile.data?.profile?.contact?.email || me?.user?.email || ''} />
      )}
    </section>
  );
}

function WorkdayForm({ saved, suggested }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(saved.email || suggested);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [generated, setGenerated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState(null);
  const [done, setDone] = useState(null);

  const reset = () => {
    setPassword('');
    setConfirm('');
    setGenerated(null);
    setProblem(null);
  };
  const save = useMutation({
    mutationFn: (body) => api('/api/me/workday-login', { method: 'PUT', body }),
    onSuccess: (d) => {
      qc.setQueryData(KEY, d);
      reset();
      setDone('Saved.');
    },
  });
  const remove = useMutation({
    mutationFn: () => api('/api/me/workday-login', { method: 'DELETE' }),
    onSuccess: () => {
      qc.setQueryData(KEY, { email: null, set: false, updatedAt: null });
      reset();
      setDone('Removed.');
    },
  });

  const submit = (e) => {
    e.preventDefault();
    setDone(null);
    save.reset();
    const body = { email: email.trim() };
    if (password || confirm || !saved.set) {
      const why = passwordProblem(password) || (password !== confirm ? "The passwords don't match." : null);
      if (why) return setProblem(why);
      body.password = password;
    }
    setProblem(null);
    save.mutate(body);
  };
  const generate = () => {
    const p = generatePassword();
    setPassword(p);
    setConfirm(p);
    setGenerated(p);
    setCopied(false);
    setProblem(null);
    setDone(null);
  };

  const busy = save.isPending || remove.isPending;
  return (
    <form onSubmit={submit}>
      {saved.set && (
        <p className="success small" role="status">
          ✓ Saved on {formatDate(saved.updatedAt)} for {saved.email}
        </p>
      )}
      <div className="form-grid">
        <label className="field field-wide">
          <span>Workday email</span>
          <input type="email" autoComplete="email" maxLength={254} required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{saved.set ? 'New password (leave blank to keep it)' : 'Password'}</span>
          <input
            type="password"
            autoComplete="new-password"
            maxLength={128}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setGenerated(null);
            }}
          />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            maxLength={128}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setGenerated(null);
            }}
          />
        </label>
      </div>
      <p className="muted small">12 or more characters with upper and lower case letters, a number and a symbol.</p>
      {generated && (
        <div className="token-once">
          <p>
            <strong>Generated password.</strong> Copy it if you want it in your password manager; it won't be shown
            after you save.
          </p>
          <code>{generated}</code>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => navigator.clipboard?.writeText(generated).then(() => setCopied(true))}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {(problem || save.error || remove.error) && <p className="error">{problem || (save.error || remove.error).message}</p>}
      {done && !problem && (
        <p className="success small" role="status">
          {done}
        </p>
      )}
      <div className="row-actions">
        <button className="btn btn-small" disabled={busy}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={generate}>
          Generate one
        </button>
        {saved.set && (
          <button
            type="button"
            className="btn btn-small btn-danger"
            disabled={busy}
            onClick={() => {
              setDone(null);
              remove.mutate();
            }}
          >
            Remove
          </button>
        )}
      </div>
    </form>
  );
}
