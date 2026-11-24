import { useState } from 'react';
import { useAccount, useSignOut } from '../account.js';
import { Link, navigate, usePath } from '../router.jsx';

const NAV = [
  ['/', 'Jobs'],
  ['/resumes', 'Resumes'],
  ['/profile', 'Profile'],
  ['/autofill', 'Autofill', 'signed-in'],
  ['/alerts', 'Alerts & Connectors', 'signed-in'],
  ['/queue', 'Queue', 'signed-in'],
  ['/settings', 'Settings'],
];
// One notice per update. Change `id` (and the text) when something ships;
// each person then sees it for at most a day from the first time it shows,
// and never again once they close it.
const NOTICE = {
  id: 'autofill-1.17',
  text: 'Autofill now answers veteran, gender and race questions, and uses each resume’s own experience.',
  link: '/autofill',
  cta: 'Update the extension',
};
const DAY = 24 * 60 * 60 * 1000;

function noticeVisible() {
  try {
    const key = 'jb-notice:' + NOTICE.id;
    const seen = JSON.parse(localStorage.getItem(key) || 'null');
    if (seen?.closed) return false;
    if (!seen) {
      localStorage.setItem(key, JSON.stringify({ first: Date.now() }));
      return true;
    }
    return Date.now() - seen.first < DAY;
  } catch {
    // Storage blocked: show nothing rather than nag on every visit.
    return false;
  }
}

function closeNotice() {
  try {
    localStorage.setItem('jb-notice:' + NOTICE.id, JSON.stringify({ first: Date.now(), closed: true }));
  } catch {
    // Private mode: it's hidden for this visit anyway.
  }
}

export default function TopBar({ total, isFetching, onRefresh }) {
  const path = usePath();
  const { data } = useAccount();
  const signOut = useSignOut();
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState(noticeVisible);
  const user = data?.user;
  const dismiss = () => {
    setNotice(false);
    closeNotice();
  };

  return (
    <>
    <header className="topbar">
      <div className="brand">
        <img className="logo" src="/logo.svg" alt="" width="32" height="32" />
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
          <Link key={to} to={to} className={`nav-link${path === to || (to !== '/' && path.startsWith(`${to}/`)) ? ' is-active' : ''}`} aria-current={path === to ? 'page' : undefined}>
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
    {user && notice && path !== '/welcome' && (
      <div className="prompt-banner" role="note">
        <span>
          <strong>New:</strong> {NOTICE.text}
        </span>
        <span className="prompt-actions">
          {path !== NOTICE.link && (
            <Link to={NOTICE.link} className="link-button">
              {NOTICE.cta}
            </Link>
          )}
          <button type="button" className="notice-close" onClick={dismiss} aria-label="Close this notice">
            ×
          </button>
        </span>
      </div>
    )}
    </>
  );
}
