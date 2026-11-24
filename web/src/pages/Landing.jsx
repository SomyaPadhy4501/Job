import SignIn from '../components/SignIn.jsx';
import { Link } from '../router.jsx';

// What signed-out visitors see: what the site is, and the way in.
export default function Landing() {
  return (
    <div className="landing">
      <div className="landing-brand">
        <img className="logo" src="/logo.svg" alt="" width="36" height="36" />
        <span>US SWE Jobs</span>
      </div>
      <div className="landing-body">
        <section className="landing-pitch">
          <h1>New-grad software jobs at companies that sponsor visas.</h1>
          <ul>
            <li>Thousands of entry-level and early-career roles, refreshed every few hours.</li>
            <li>Sponsorship history from H-1B data, and roles needing clearance or citizenship flagged.</li>
            <li>Keep your resumes and answers in one place, and fill applications in one click with the extension.</li>
          </ul>
        </section>
        <SignIn title="Sign in to continue" reason="Use your Google account. It's free." />
      </div>
      <footer className="landing-footer">
        <Link to="/privacy">Privacy</Link>
      </footer>
    </div>
  );
}
