/* Global Digits service worker - the ONE worker for both the PWA and OneSignal push.
   index.html and landing.html register this same /sw.js at scope "/", and OneSignal is told to use it
   (serviceWorkerPath:'sw.js'), so there is never a second registration fighting for the scope.
   - Network-first for page navigations, with a cached copy for offline.
   - Stale-while-revalidate for same-origin scripts/styles (no stale JS after a deploy);
     cache-first for images/fonts/icons.
   - Never touches cross-origin requests (Supabase, edge functions, CDNs). */

// A blocked/offline OneSignal CDN must not stop this worker from installing (that would also break PWA install).
try { importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js'); }
catch (err) { console.warn('OneSignal worker script unavailable; push disabled until it loads', err); }

const CACHE = 'gd-shell-v2';
const SHELL = ['/index.html', '/landing.html', '/logo.png', '/android-chrome-192x192.png'];

self.addEventListener('install', e => {
  // Cache each file independently: one missing file must not fail the whole install.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k.startsWith('gd-shell-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache pages by path only, so ?ref=CODE / utm query strings don't create endless entries.
const pageKey = url => new Request(new URL(url).origin + new URL(url).pathname);

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        // Only keep clean 200 responses: a cached redirect/error would break later navigations.
        if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(pageKey(req.url), copy)); }
        return res;
      }).catch(async () => {
        const hit = await caches.match(pageKey(req.url));
        if (hit) return hit;
        // Offline fallback is the app shell - but never for the landing page, or the
        // index.html -> landing.html gate would bounce back and forth forever.
        if (url.pathname !== '/landing.html') { const app = await caches.match('/index.html'); if (app) return app; }
        return Response.error();
      })
    );
    return;
  }

  const dest = req.destination;
  if (dest === 'script' || dest === 'style' || url.pathname.endsWith('.webmanifest')) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const hit = await c.match(req);
        const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
        return hit || (await net) || Response.error();
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
