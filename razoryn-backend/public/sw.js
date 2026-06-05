// sw.js — warehouse PWA service worker.
//
// LOCKED RULE: cache STATIC assets only. NEVER cache /api/* or /uploads/*
// responses — they carry live stock + customer PII, where staleness and caching
// are both unacceptable. Those requests bypass the worker entirely.
//
// Strategy:
//   • /api/* and /uploads/*        → not handled here (straight to network).
//   • navigations / HTML           → network-first, fall back to cached shell
//                                     when offline (so deploys show instantly).
//   • other same-origin GETs       → cache-first (logos, manifest, icon).
const CACHE = 'wh-static-v1';
const SHELL = '/index.html';
const PRECACHE = ['/', SHELL, '/manifest.webmanifest', '/app-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin GETs.
  if (url.origin !== self.location.origin) return;
  // NEVER touch API or uploads — security + freshness. Let them hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  // Network-first for navigations / HTML so a fresh deploy is picked up at once;
  // cache the shell as an offline fallback.
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(SHELL))
    );
    return;
  }

  // Cache-first for other static assets (logos, manifest, icon).
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
    )
  );
});

// ── Web Push (#2) ────────────────────────────────────────────────────────────
// Show the notification the server sent, and focus/open the app when tapped.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Warehouse Hub';
  const options = {
    body: data.body || '',
    icon: '/apple-touch-icon.png',
    badge: '/apple-touch-icon.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    vibrate: [80, 40, 80],
    data: { url: data.url || '/' },
  };
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find((c) => c.visibilityState === 'visible' || c.focused);
    if (visible) {
      // App is open/in front: let the page play its CUSTOM notification sound
      // (the OS won't let us substitute a custom sound on a push), and show the
      // notification silently so the device's default sound doesn't also fire.
      try { visible.postMessage({ type: 'push-notification', category: data.category || null, title, body: data.body || '', url: data.url || '/' }); } catch (_) {}
      return self.registration.showNotification(title, { ...options, silent: true });
    }
    // App closed/backgrounded: standard OS notification (device sound).
    return self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) { c.focus(); if (c.navigate && url !== '/') c.navigate(url).catch(() => {}); return; }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
