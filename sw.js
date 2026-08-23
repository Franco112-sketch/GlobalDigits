/*
 * Global Digits — Service Worker
 * ─────────────────────────────────────────────────────────────────
 * SCOPE OF THIS FILE: static assets only (app shell + icons + manifest).
 *
 * HARD RULES (do not relax these without re-reading this comment block):
 *   1. Only GET requests are ever considered for caching. Every other
 *      method (POST/PUT/PATCH/DELETE) is left completely untouched and
 *      goes straight to the network — this covers every Supabase write,
 *      wallet debit/credit, order placement, and payment action.
 *   2. Only SAME-ORIGIN requests are considered. Any cross-origin
 *      request — Supabase (*.supabase.co), the Supabase JS CDN bundle,
 *      Google Fonts, OneSignal, flag/image CDNs, etc. — is ignored by
 *      this service worker entirely and falls through to the network
 *      exactly as if no service worker were installed.
 *   3. Even same-origin, only a fixed allow-list of static file
 *      extensions/paths is eligible for caching (see STATIC_EXT_RE
 *      and STATIC_FILES below). Anything else same-origin (HTML pages
 *      themselves excluded — see below) — is passed straight through.
 *   4. Any request whose path looks like it could be dynamic/user
 *      data (auth, wallet, orders, payments, admin, api, rest,
 *      realtime, functions, storage, supabase) is explicitly denied
 *      from caching, even if it happens to be same-origin. This is a
 *      defensive belt-and-braces check on top of rule #3.
 *   5. Requests carrying a query string are never cached (dynamic /
 *      cache-busted / personalized requests almost always carry one).
 *      The two exceptions this app needs are itself query-string-free.
 *   6. The app shell (the HTML document) is served NETWORK-FIRST, so
 *      users always get the latest code when online; the cached copy
 *      is only ever used as an offline fallback. It is never used to
 *      short-circuit a live request.
 */

const SW_VERSION   = 'v1';
const CACHE_NAME   = 'gd-static-' + SW_VERSION;

// Known static app-shell files, precached on install so the app can
// still open (read-only, offline banner shown by the app itself) with
// no network at all. Every one of these is static markup/markup-adjacent
// or an icon — none of them ever contain wallet/order/user data.
const PRECACHE_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/logo.png'
];

// Static asset file extensions eligible for runtime caching.
const STATIC_EXT_RE = /\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|json|webmanifest)$/i;

// Defensive denylist — never cache a same-origin request whose path
// suggests dynamic, authenticated, or user-specific content, even if
// it superficially matches the static extension allow-list above.
const DENY_PATH_RE = /\/(api|auth|admin|wallet|orders?|payments?|rest|realtime|functions|storage|supabase|user|account|session)(\/|$|\?)/i;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        // addAll is all-or-nothing; use individual, tolerant adds so one
        // missing/renamed icon file can never block installation.
        return Promise.all(
          PRECACHE_FILES.map(function (url) {
            return cache.add(url).catch(function () { /* ignore missing file */ });
          })
        );
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isCacheableStaticRequest(url) {
  if (url.origin !== self.location.origin) return false;   // rule 2
  if (DENY_PATH_RE.test(url.pathname + url.search)) return false; // rule 4
  if (url.search) return false;                              // rule 5
  return STATIC_EXT_RE.test(url.pathname);
}

self.addEventListener('fetch', function (event) {
  const request = event.request;

  // Rule 1 — never touch non-GET requests (writes, auth, payments...).
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Rule 2 — never touch cross-origin requests (Supabase, fonts, CDNs...).
  if (url.origin !== self.location.origin) return;

  // Rule 4 — never touch anything that looks dynamic/user-specific,
  // regardless of what follows.
  if (DENY_PATH_RE.test(url.pathname + url.search)) return;

  // The HTML app shell: network-first, cache is only an offline fallback.
  const isNavigation =
    request.mode === 'navigate' ||
    (request.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (cached) {
            return cached || caches.match('/index.html') || caches.match('/');
          });
        })
    );
    return;
  }

  // Static assets (icons, manifest, fonts bundled locally): cache-first,
  // falling back to network and populating the cache as they're seen.
  if (isCacheableStaticRequest(url)) {
    event.respondWith(
      caches.match(request).then(function (cached) {
        if (cached) return cached;
        return fetch(request).then(function (response) {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
          }
          return response;
        }).catch(function () {
          return cached; // undefined — no cache, no network: let it fail naturally
        });
      })
    );
    return;
  }

  // Everything else (anything not explicitly matched above, including
  // any current or future same-origin API-style endpoint): do not
  // intercept at all — behave exactly as if there were no service worker.
});
