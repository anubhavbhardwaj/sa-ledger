// S&A Ledger service worker: makes the app installable and lets it open offline.
// Your expense data is NOT cached here; Firestore keeps its own offline copy.
const VERSION = 'sa-ledger-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app page: always try the network first so updates show up, fall back to cache offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put('/', copy)); return res;
    }).catch(() => caches.match('/')));
    return;
  }

  // Firebase SDK files and fonts: serve from cache, refresh in the background.
  const cacheable = url.origin === location.origin
    || url.href.startsWith('https://www.gstatic.com/firebasejs/')
    || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!cacheable) return; // Firestore and login traffic go straight to the network.

  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
