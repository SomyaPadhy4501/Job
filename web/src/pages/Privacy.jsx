import { Link } from '../router.jsx';

export default function Privacy() {
  return (
    <article className="card prose">
      <h2>Privacy</h2>
      <p>
        The job list is public and needs no account. An account is only for autofill: keeping your resumes, the details
        application forms ask for, and your saved answers, so the browser extension can fill forms for you.
      </p>
      <h3>What is stored</h3>
      <ul>
        <li>From Google sign-in: your name, email address and profile picture. Nothing else from your Google account.</li>
        <li>Your resume files, in a private storage bucket. They are only ever sent back to you.</li>
        <li>
          Your profile (including work authorization and the optional self-identification answers), what was read from
          your resumes, and your saved answers. These are encrypted before they reach the database.
        </li>
        <li>Resume titles, tags and file names, extension token names, and when things were created or last used.</li>
        <li>
          A short log of security events (sign-in, sign-out, token created or revoked, export, deletion) with no personal
          details, kept 90 days.
        </li>
      </ul>
      <h3>What isn't done with it</h3>
      <ul>
        <li>It isn't sold, shared or sent to any AI service. Resumes are read by rules running on this server.</li>
        <li>The extension sends your data only to this site, never to employers' sites except into the form you asked it to fill. It never submits an application.</li>
        <li>No ads and no third-party trackers.</li>
      </ul>
      <h3>Your controls</h3>
      <ul>
        <li>
          Edit or delete anything on the <Link to="/resumes">Resumes</Link>, <Link to="/profile">Profile</Link> and{' '}
          <Link to="/settings">Settings</Link> pages.
        </li>
        <li>Download all of it from Settings.</li>
        <li>
          Delete your account from Settings. Everything goes at once, files included. Backups of the database roll off
          within the hosting provider's retention window.
        </li>
      </ul>
      <h3>Cookies</h3>
      <p>
        One cookie keeps you signed in, one tells this page you're signed in, and a short-lived one protects the Google
        sign-in step. There are no tracking cookies.
      </p>
    </article>
  );
}
