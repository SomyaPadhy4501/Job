'use strict';

// Service worker for the installable app (Add to Home Screen on iPhone).
// Privacy: it never stores /api/* (accounts, resumes, profile) or the job
// lists; those always come from the network. It keeps only the app shell
// and the hashed build files, so the app opens offline and starts fast.
const CACHE = 'shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/logo.svg', '/apple-touch-icon.png', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Other sites (Google sign-in, fonts) and everything dynamic go straight to the network.
  if (url.origin !== location.origin) return;
  if (/^\/(api|admin|jobs|companies|stats|downloads)(\/|$)/.test(url.pathname)) return;

  // Pages: network first, so a new deploy shows at once; the saved shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // Build files have content hashes in their names, so a cached copy never goes stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
  }
});
