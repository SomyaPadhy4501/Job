import { useEffect, useState } from 'react';
import { formatBytes, usePrivateQuery } from '../account.js';
import RequireAuth from '../components/RequireAuth.jsx';
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
  return (
    <>
      {welcome && (
        <div className="card welcome">
          <h2>Welcome! One more step for one-click applications</h2>
          <p>
            Your account is ready. Install the extension below (about two minutes), and job application forms fill
            themselves from your resumes and profile. You can always come back here from the <strong>Autofill</strong>{' '}
            tab, or <Link to="/">browse jobs</Link> first.
          </p>
        </div>
      )}
      <div className="page-head">
        <h2>Autofill extension</h2>
        <p className="muted">
          Fills job applications for you from your profile and resumes: Greenhouse, Lever, Ashby and Workday by
          themselves, and any other careers site (Tesla, Amazon, company sites) when you ask. You pick the resume for each
          job, review everything, and submit yourself. It never submits an application.
        </p>
      </div>

      <section className="card section">
        <h3>Before you start</h3>
        <ul className="checklist">
          <li className={hasResume ? 'done' : ''}>
            {hasResume ? '✓' : '○'} <Link to="/resumes">Upload a resume</Link>
            {hasResume ? ` (${resumes.data.resumes.length})` : ' — tag each one (SWE, AI Engineer…) so the right one is suggested'}
          </li>
          <li className={hasProfile ? 'done' : ''}>
            {hasProfile ? '✓' : '○'} <Link to="/profile">Check your profile</Link>, especially the work-authorization
            answers. Anything left “Not set” is left for you on each form.
          </li>
        </ul>
      </section>

      <ol className="steps">
        <li className="card">
          <h3>Download the extension</h3>
          {info === undefined ? (
            <div className="skeleton skeleton-row" />
          ) : info ? (
            <>
              <a className="btn" href={ZIP} download>
                Download extension (.zip)
              </a>
              <p className="muted small">
                Version {info.version} · {formatBytes(info.bytes)} · works in Chrome, Brave, Edge and Arc on a computer.
              </p>
            </>
          ) : (
            <p className="notice">The download isn't available on this server build yet.</p>
          )}
        </li>

        <li className="card">
          <h3>Unzip it somewhere it can stay</h3>
          <p>
            Windows: right-click the file → <strong>Extract All</strong>. Mac: double-click it. You get a folder called{' '}
            <code>{info?.folder || 'job-board-extension'}</code>.
          </p>
          <p className="muted small">
            Move that folder somewhere permanent, like Documents. The browser runs the extension from that folder, so
            deleting it removes the extension.
          </p>
        </li>

        <li className="card">
          <h3>Open your browser's extensions page</h3>
          <p>
            Paste this into the address bar (browsers don't allow links to it):
          </p>
          <div className="copy-row">
            <code>{extensionsUrl}</code>
            <Copy value={extensionsUrl} />
          </div>
          <p className="muted small">
            Chrome: <code>chrome://extensions</code> · Brave: <code>brave://extensions</code> · Edge:{' '}
            <code>edge://extensions</code>
          </p>
        </li>

        <li className="card">
          <h3>Turn on Developer mode</h3>
          <p>
            Flip the <strong>Developer mode</strong> switch at the top right of that page (Edge: on the left). It only
            lets you load extensions from a folder; it doesn't change anything else.
          </p>
        </li>

        <li className="card">
          <h3>Load the folder</h3>
          <p>
            Click <strong>Load unpacked</strong> and choose the <code>{info?.folder || 'job-board-extension'}</code>{' '}
            folder (the one with <code>manifest.json</code> inside). The extension appears in the list.
          </p>
          <p className="muted small">
            Then click the puzzle-piece icon in the toolbar and pin the extension, so its icon is always there.
          </p>
        </li>

        <li className="card">
          <h3>Connect it to your account</h3>
          <ol className="substeps">
            <li>
              Click the extension's icon. In <strong>Portal URL</strong>, put this site's address and click{' '}
              <strong>Save</strong>:
              <div className="copy-row">
                <code>{origin}</code>
                <Copy value={origin} />
              </div>
            </li>
            <li>Create a token below and copy it.</li>
            <li>
              Back in the extension, paste it into <strong>Personal autofill token</strong> (under “Autofill”) and click{' '}
              <strong>Connect</strong>. It should say “Connected as” and your email.
            </li>
          </ol>
          <p className="muted small">
            Leave “Collect token” and “My boards” empty: those are for the site owner's job collection, not for autofill.
          </p>
        </li>
      </ol>

      <Tokens />

      <section className="card section">
        <h3>Help grow the board (optional)</h3>
        <p>
          Some employers, like Tesla, block automated job collection, so their jobs only reach this board when people
          browse them. In the extension, tick <strong>Share job listings I browse with the job board</strong>. Then,
          whenever you open a careers page, the job listings it shows are added here for everyone.
        </p>
        <ul className="muted small">
          <li>Only public job listings are shared: never application forms, sign-in pages, or anything you type.</li>
          <li>LinkedIn, Indeed and Glassdoor are never shared from your browsing.</li>
          <li>
            Listings are checked before they're added (the link must be on the employer's own site or job system), and
            the board's usual filters apply.
          </li>
          <li>It uses your extension token; untick it any time.</li>
        </ul>
      </section>

      <section className="card section">
        <h3>Use it</h3>
        <ol className="substeps">
          <li>
            Open a job and click the employer's <strong>Apply</strong> button to get to the application form.
          </li>
          <li>
            On Greenhouse, Lever, Ashby and Workday forms an <strong>Autofill</strong> button appears on the page. On any
            other site, click the extension's icon and then <strong>Autofill this page</strong>; the browser asks once
            whether it may use that site.
          </li>
          <li>
            Pick the resume for this role (the best match for the job is chosen for you), then click{' '}
            <strong>Fill this page</strong>.
          </li>
          <li>
            Check what it filled, answer what's listed under <strong>Needs you</strong>, and submit the application
            yourself. Tick “Save my response” on custom questions to have them filled next time.
          </li>
        </ol>
      </section>

      <section className="card section">
        <h3>Updating and troubleshooting</h3>
        <ul>
          <li>
            <strong>New version:</strong> download the zip again, replace the files in your folder, then click the reload
            arrow on the extension in <code>{extensionsUrl}</code>.
          </li>
          <li>
            <strong>“Token rejected”:</strong> the token was revoked or mistyped. Create a new one above and connect again.
          </li>
          <li>
            <strong>A warning about developer-mode extensions</strong> may show when the browser starts. That's normal
            for extensions loaded from a folder; keep it.
          </li>
          <li>
            <strong>Nothing appears on a form:</strong> make sure you're on the application form itself, not the job
            description, then use <strong>Autofill this page</strong> from the extension's icon.
          </li>
        </ul>
      </section>
    </>
  );
}
