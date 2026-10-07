// S&A Ledger service worker: makes the app installable and lets it open offline.
// Your expense data is NOT cached here; Firestore keeps its own offline copy.
const VERSION = 'sa-ledger-v5';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'share-inbox').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Files shared to the app from another app (share sheet → S&A Ledger): park them for the page, then open it.
async function receiveShare(req) {
  try {
    const fd = await req.formData(), c = await caches.open('share-inbox'), stamp = Date.now();
    const files = fd.getAll('file').filter(f => f && typeof f === 'object' && f.size);
    for (const [i, f] of files.slice(0, 5).entries())
      await c.put(`/__share/${stamp}-${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'shared file') } }));
    const text = ['title', 'text', 'url'].map(k => fd.get(k)).filter(v => typeof v === 'string' && v.trim()).join('\n');
    if (text) await c.put(`/__share/${stamp}-text`, new Response(text, { headers: { 'content-type': 'text/plain', 'x-kind': 'text', 'x-name': 'shared text' } }));
  } catch {}
  return Response.redirect('/#share', 303);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname === '/share-target') { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  // Server answers (API, functions) always come fresh from the network.
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/'))) return;

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
    || url.href.startsWith('https://cdn.jsdelivr.net/npm/pdfjs-dist@')
    || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!cacheable) return; // Firestore and login traffic go straight to the network.

  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

// Flight alerts (data messages from Firebase Cloud Messaging, sent by netlify/functions/flights.mjs).
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch {}
  const d = p.data || p;
  const title = d.title || 'S&A Ledger';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { url: d.url || '/#overview' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/#overview', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
    const open = list.find(c => c.url.startsWith(self.location.origin));
    if (!open) return self.clients.openWindow(url);
    // Tell the open app where to go (navigate() is refused for pages this worker doesn't control yet).
    open.postMessage({ type: 'notification-open', hash: new URL(url).hash || '#overview' });
    return open.focus();
  }));
});
