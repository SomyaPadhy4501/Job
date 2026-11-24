import { lazy, Suspense } from 'react';
import Board from './pages/Board.jsx';
import Resumes from './pages/Resumes.jsx';
import Profile from './pages/Profile.jsx';
import Settings from './pages/Settings.jsx';
import Privacy from './pages/Privacy.jsx';
import Autofill from './pages/Autofill.jsx';
import Welcome from './pages/Welcome.jsx';
import Landing from './pages/Landing.jsx';
import Alerts from './pages/Alerts.jsx';
import Queue from './pages/Queue.jsx';
import TopBar from './components/TopBar.jsx';
import { useAccount } from './account.js';
import { Link, usePath } from './router.jsx';

// The LaTeX editor carries CodeMirror and the compiler: loaded on demand.
const LatexEditor = lazy(() => import('./pages/LatexEditor.jsx'));

const PAGES = {
  '/resumes': Resumes,
  '/resumes/latex': LatexEditor,
  '/profile': Profile,
  '/settings': Settings,
  '/autofill': Autofill,
  '/welcome': Welcome,
  '/alerts': Alerts,
  '/queue': Queue,
};

// Pages anyone can open without signing in.
const PUBLIC = { '/privacy': Privacy };

export default function App() {
  const path = usePath().replace(/\/+$/, '') || '/';
  const { data, isLoading } = useAccount();

  if (PUBLIC[path]) return <Shell><Privacy /></Shell>;
  // Everything else needs an account: signed-out visitors get the sign-in page.
  if (isLoading) return <Shell><div className="card"><div className="skeleton skeleton-row" /></div></Shell>;
  if (!data?.user) return <Landing />;

  if (path === '/') return <Board />;
  const Page = PAGES[path];
  return (
    <Shell>
      {Page ? (
        <Suspense fallback={<div className="card"><div className="skeleton skeleton-row" /></div>}>
          <Page />
        </Suspense>
      ) : (
        <div className="card">
          <h2>Page not found</h2>
          <p>
            <Link to="/">Back to the jobs</Link>
          </p>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="app">
      <TopBar />
      <main className={`main page${usePath().startsWith('/resumes/latex') ? ' page-wide' : ''}`}>{children}</main>
    </div>
  );
}
