import React from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import InstallHint from './components/InstallHint.jsx';
import { ME } from './account.js';
import './styles.css';
import './account.css';
import { SITE_HOST } from './site.js';

// Every Vercel deploy also gets its own one-off address. Google sign-in only
// works on the real one, so production builds send visitors there.
if (__VERCEL_ENV__ === 'production' && location.hostname !== SITE_HOST && location.hostname.endsWith('.vercel.app')) {
  location.replace(`https://${SITE_HOST}${location.pathname}${location.search}${location.hash}`);
}

// A 401 from any private call means the session ended: show the sign-in card
// (pages keep what the user typed) and drop the cached private data.
function onError(error) {
  if (error?.status === 401) {
    queryClient.removeQueries({ predicate: (q) => !['jobs', 'companies', 'me'].includes(q.queryKey[0]) });
    queryClient.setQueryData(ME, { user: null });
  }
}

// Single shared QueryClient for the whole app. `staleTime` kept small because
// the server-side cache already has a 30s TTL — any longer here risks showing
// post-cron-tick-stale data. `refetchOnWindowFocus` is what makes "come back
// to the tab → see fresh jobs" feel right (private queries turn it off).
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      // Client errors won't change on a retry.
      retry: (count, error) => !(error?.status >= 400 && error?.status < 500) && count < 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    },
  },
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <InstallHint />
    </QueryClientProvider>
  </React.StrictMode>
);

// Installable app (public/sw.js): production only, so the dev server's hot
// reload is never served from a cache.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
