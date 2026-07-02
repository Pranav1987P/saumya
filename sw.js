// Saumya service worker — minimal, network-first.
// Its job is mainly to exist with a fetch handler so the browser treats Saumya
// as an installable app (real icon, no browser badge). It does light offline
// caching of the shell so the app still opens if the network is briefly down.

const CACHE = 'saumya-v8-57';
const SHELL = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: always try the live network, fall back to cache when offline.
// (Saumya stores its data in localStorage, not here, so this is only the shell.)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
