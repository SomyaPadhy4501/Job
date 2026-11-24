import { useEffect, useState } from 'react';
import { formatBytes, usePrivateQuery } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
import WorkdayLogin from '../components/WorkdayLogin.jsx';
import { Link } from '../router.jsx';
import { Tokens } from './Settings.jsx';

// Getting the autofill extension: download, load it in developer mode,
// connect it with a token. The zip is built from extension/ on every deploy
// (web/scripts/pack-extension.mjs), so it always matches the site.

const ZIP = '/downloads/job-board-extension.zip';

export default function Autofill() {
  return (
    <RequireAuth reason="Sign in to set up the autofill extension: it fills job applications from your profile and resumes.">
      <AutofillPage />
    </RequireAuth>
  );
}

function Copy({ value, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost"
      onClick={() =>
        navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function useBuildInfo() {
  const [info, setInfo] = useState(undefined);
  useEffect(() => {
    fetch('/downloads/extension.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  return info;
}

function browserName() {
  const ua = navigator.userAgent;
  if (navigator.brave) return 'brave';
  if (/Edg\//.test(ua)) return 'edge';
  return 'chrome';
}

function AutofillPage() {
  const info = useBuildInfo();
  const resumes = usePrivateQuery(['resumes'], '/api/me/resumes');
  const profile = usePrivateQuery(['profile'], '/api/me/profile');
  const browser = browserName();
  const extensionsUrl = `${browser}://extensions`;
  const origin = window.location.origin;
  const hasResume = resumes.data?.resumes?.length > 0;
  const hasProfile = (profile.data?.version ?? 0) > 0;

  const welcome = new URLSearchParams(window.location.search).has('welcome');
  const folder = info?.folder || 'job-board-extension';
  return (
    <>
      {welcome && (
        <div className="card welcome">
          <h2>You're set up. One last step</h2>
          <p>
            Install the extension (about 2 minutes) and job forms fill themselves. Or <Link to="/">browse jobs</Link> first.
          </p>
        </div>
      )}
      <div className="page-head">
        <h2>Autofill extension</h2>
        <p className="muted">
          Fills job applications from your profile and resumes. You review and submit; it never submits for you.
        </p>
      </div>

      <section className="card section">
        <h3>Before you start</h3>
        <ul className="checklist">
          <li className={hasResume ? 'done' : ''}>
            {hasResume ? '✓' : '○'} <Link to="/resumes">Upload a resume</Link>
            {hasResume ? ` (${resumes.data.resumes.length})` : ''}
          </li>
          <li className={hasProfile ? 'done' : ''}>
            {hasProfile ? '✓' : '○'} <Link to="/profile">Fill in your profile</Link>
          </li>
        </ul>
      </section>

      <ol className="steps">
        <li className="card">
          <h3>Download and unzip</h3>
          {info === undefined ? (
            <div className="skeleton skeleton-row" />
          ) : info ? (
            <>
              <a className="btn" href={ZIP} download>
                Download extension (.zip)
              </a>
              <p className="muted small">
                Version {info.version} · {formatBytes(info.bytes)} · Chrome, Brave, Edge or Arc
              </p>
            </>
          ) : (
            <p className="notice">The download isn't available on this server build yet.</p>
          )}
          <p>
            Unzip it and keep the <code>{folder}</code> folder somewhere permanent, like Documents.
          </p>
        </li>

        <li className="card">
          <h3>Load it in your browser</h3>
          <ol className="substeps">
            <li>
              Open this in the address bar:
              <div className="copy-row">
                <code>{extensionsUrl}</code>
                <Copy value={extensionsUrl} />
              </div>
            </li>
            <li>
              Turn on <strong>Developer mode</strong> (top right).
            </li>
            <li>
              Click <strong>Load unpacked</strong> and pick the <code>{folder}</code> folder.
            </li>
          </ol>
        </li>

        <li className="card">
          <h3>Connect it</h3>
          <ol className="substeps">
            <li>
              Click the extension's icon and paste this site's address:
              <div className="copy-row">
                <code>{origin}</code>
                <Copy value={origin} />
              </div>
            </li>
            <li>
              Create a token below, paste it in, and click <strong>Connect</strong>.
            </li>
          </ol>
        </li>
      </ol>

      <Tokens />

      <WorkdayLogin />

      <section className="card section">
        <h3>How to use it</h3>
        <ol className="substeps">
          <li>Open a job's application form.</li>
          <li>
            Click <strong>Autofill</strong> on the page, pick a resume, then <strong>Fill this page</strong>. (Other
            sites: use the extension's icon.)
          </li>
          <li>
            Answer anything under <strong>Needs you</strong> and submit. Afterwards it offers to save your new answers.
          </li>
        </ol>
      </section>

      <section className="card section">
        <h3>Updating</h3>
        <p>
          When the icon shows <strong>NEW</strong>, run one command. Your settings stay.
        </p>
        <p className="muted small">Windows (PowerShell):</p>
        <div className="copy-row">
          <code>{`irm ${origin}/update-extension.ps1 | iex`}</code>
          <Copy value={`irm ${origin}/update-extension.ps1 | iex`} />
        </div>
        <p className="muted small">Mac (Terminal):</p>
        <div className="copy-row">
          <code>{`curl -fsSL ${origin}/update-extension.sh | bash`}</code>
          <Copy value={`curl -fsSL ${origin}/update-extension.sh | bash`} />
        </div>
      </section>

      <section className="card section">
        <h3>Help grow the board (optional)</h3>
        <p>
          Tick <strong>Share job listings I browse</strong> in the extension to add the public jobs you see to this board.
          Never forms, sign-ins or anything you type.
        </p>
      </section>

    </>
  );
}
