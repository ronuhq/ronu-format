// Service worker: caches the app shell so the player opens offline after the
// first visit. Same-origin GETs (including a sample .ronu you opened) are
// cached on first use; the last opened file itself lives in IndexedDB.

const VERSION = 'ronu-player-v2';
const SHELL = [
  './', './index.html', './app.css', './app.js', './ui.js', './engine.js', './formula.js', './conditions.js',
  './bundle.js', './session.js', './sanitize.js', './pano.js', './store.js', './receiver.js', './receiver-ui.js', './conversation.js',
  './vendor/fflate.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // remote ?ronu= files are not cached
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((cache) => cache.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit ?? network;
    }),
  );
});
