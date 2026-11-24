import { useState } from 'react';
import { useAccount, useSignOut } from '../account.js';
import { Link, navigate, usePath } from '../router.jsx';

const NAV = [
  ['/', 'Jobs'],
  ['/resumes', 'Resumes'],
  ['/profile', 'Profile'],
  ['/autofill', 'Autofill', 'signed-in'],
  ['/settings', 'Settings'],
];
const PROMPT_KEY = 'jb-autofill-prompt-dismissed';

function readDismissed() {
  try {
    return localStorage.getItem(PROMPT_KEY) === '1';
  } catch {
    return false;
  }
}

export default function TopBar({ total, isFetching, onRefresh }) {
  const path = usePath();
  const { data } = useAccount();
  const signOut = useSignOut();
  const [menu, setMenu] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  const user = data?.user;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(PROMPT_KEY, '1');
    } catch {
      // Private mode: it just shows again next visit.
    }
  };

  return (
    <>
    <header className="topbar">
      <div className="brand">
        <div className="logo-dot" aria-hidden="true" />
        <h1>
          <Link to="/" className="brand-link">US SWE Jobs</Link>
        </h1>
        {onRefresh && (
          <span className="stats">
            {total != null ? `${total.toLocaleString()} jobs` : '—'}
            {isFetching ? ' · syncing…' : ''}
          </span>
        )}
      </div>
      <nav className="nav" aria-label="Main">
        {NAV.filter(([, , only]) => !only || user).map(([to, label]) => (
          <Link key={to} to={to} className={`nav-link${path === to ? ' is-active' : ''}`} aria-current={path === to ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="topbar-actions">
        {onRefresh && (
          <button className="refresh-btn" type="button" onClick={onRefresh} title="Force refresh" aria-label="Force refresh">
            <span className={isFetching ? 'spinning' : ''}>↻</span>
          </button>
        )}
        {user ? (
          <div className="account-menu">
            <button type="button" className="avatar-btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label="Account">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span>{(user.name || user.email || '?').slice(0, 1).toUpperCase()}</span>
              )}
            </button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                <div className="menu-head">
                  <strong>{user.name}</strong>
                  <span className="muted small">{user.email}</span>
                </div>
                <button type="button" onClick={() => { setMenu(false); navigate('/settings'); }}>Settings</button>
                <button type="button" onClick={() => { setMenu(false); signOut(); }}>Sign out</button>
              </div>
            )}
          </div>
        ) : (
          <Link to="/resumes" className="btn btn-small">Sign in</Link>
        )}
      </div>
    </header>
    {user && !dismissed && path !== '/autofill' && path !== '/welcome' && (
      <div className="prompt-banner" role="note">
        <span>
          <strong>New:</strong> fill job applications in one click with your resumes, and help grow the board with the
          jobs you browse.
        </span>
        <span className="prompt-actions">
          <Link to="/autofill" className="btn btn-small">Get the extension</Link>
          <button type="button" className="btn btn-small btn-ghost" onClick={dismiss}>Not now</button>
        </span>
      </div>
    )}
    </>
  );
}
