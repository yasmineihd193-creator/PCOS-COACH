const VERSION = 'pcos-coach-v7';
const CACHE = VERSION;
const DIAG_CACHE = 'pcos-diag';
const SHELL_FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== DIAG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- tiny diagnostic record: what this worker last received / showed (read by the app's diagnostics) ----
async function readDiag() {
  try { const c = await caches.open(DIAG_CACHE); const r = await c.match('/__diag'); return r ? await r.json() : {}; } catch (e) { return {}; }
}
async function writeDiag(patch) {
  try {
    const cur = await readDiag();
    const c = await caches.open(DIAG_CACHE);
    await c.put('/__diag', new Response(JSON.stringify({ ...cur, ...patch }), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {}
}

// ---- a push arrived from the server: it MUST end in showNotification ----
self.addEventListener('push', (event) => {
  let data = { title: 'PCOS Coach', body: 'Time to check in.', url: './index.html' };
  try { if (event.data) data = { ...data, ...event.data.json() }; }
  catch (e) { try { data.body = event.data.text() || data.body; } catch (e2) {} }
  const receivedAt = new Date().toISOString();
  event.waitUntil((async () => {
    let shownError = null;
    try {
      await self.registration.showNotification(data.title, {
        body: data.body, icon: 'icon-192.png', badge: 'icon-192.png',
        tag: data.tag || undefined,            // same tag replaces instead of stacking duplicates
        data: { url: data.url },
      });
    } catch (e) { shownError = String((e && e.message) || e); }
    await writeDiag({ pushAt: receivedAt, lastBody: data.body, lastTag: data.tag || null, shownAt: shownError ? null : new Date().toISOString(), shownError });
    try {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      list.forEach((c) => c.postMessage({ type: 'push-received', tag: data.tag || null, at: receivedAt, shownError }));
    } catch (e) {}
  })());
});

// ---- tapping a reminder opens the app straight to the matching action (it never logs anything itself) ----
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './index.html';
  const action = new URL(url, self.location.href).searchParams.get('action');
  event.waitUntil((async () => {
    await writeDiag({ clickedAt: new Date().toISOString() });
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) {
        if (action) c.postMessage({ type: 'reminder-action', action });
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

// ---- the app can ask: are you alive, which version, what did you last receive? ----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'ping' && event.ports && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil(readDiag().then((diag) => port.postMessage({
      type: 'pong', version: VERSION, diag,
      permission: (typeof Notification !== 'undefined' && Notification.permission) || 'unknown',
    })));
  }
});

// Same-origin app shell: network-first for the page itself (so updates arrive), cache-first for static files.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.netlify/')) return;   // never cache or intercept the backend
  if (event.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {}); return res; })
        .catch(() => caches.match(event.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {}); return res; })
        .catch(() => cached);
    })
  );
});
