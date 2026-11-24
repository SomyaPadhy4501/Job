import Board from './pages/Board.jsx';
import Resumes from './pages/Resumes.jsx';
import Profile from './pages/Profile.jsx';
import Settings from './pages/Settings.jsx';
import Privacy from './pages/Privacy.jsx';
import Autofill from './pages/Autofill.jsx';
import TopBar from './components/TopBar.jsx';
import { Link, usePath } from './router.jsx';

const PAGES = {
  '/resumes': Resumes,
  '/profile': Profile,
  '/settings': Settings,
  '/privacy': Privacy,
  '/autofill': Autofill,
};

export default function App() {
  const path = usePath().replace(/\/+$/, '') || '/';
  if (path === '/') return <Board />;
  const Page = PAGES[path];
  return (
    <div className="app">
      <TopBar />
      <main className="main page">
        {Page ? (
          <Page />
        ) : (
          <div className="card">
            <h2>Page not found</h2>
            <p>
              <Link to="/">Back to the jobs</Link>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
