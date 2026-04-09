// GlobalDigits Service Worker v2.0
// Real push notifications — works when site is closed

var CACHE_NAME = 'globaldigits-v2';
var SITE_URL = self.location.origin;
var ICON_URL = SITE_URL + '/favicon.ico';

self.addEventListener('install', function(event) {
self.skipWaiting();
});

self.addEventListener('activate', function(event) {
event.waitUntil(
clients.claim().then(function() {
return caches.keys().then(function(keys) {
return Promise.all(
keys.filter(function(k){ return k !== CACHE_NAME; })
.map(function(k){ return caches.delete(k); })
);
});
})
);
});

// ── Real push notification from server ──
self.addEventListener('push', function(event) {
var data = {};
if(event.data){
try { data = event.data.json(); }
catch(e){ data = { title: 'GlobalDigits', body: event.data.text() }; }
}
var title   = data.title   || 'GlobalDigits';
var body    = data.body    || data.message || 'You have a new update.';
var icon    = data.icon    || ICON_URL;
var badge   = data.badge   || ICON_URL;
var url     = data.url     || data.link || SITE_URL;
var options = {
body:    body,
icon:    icon,
badge:   badge,
tag:     data.tag || 'globaldigits',
renotify: true,
requireInteraction: false,
vibrate: [200, 100, 200],
timestamp: Date.now(),
data: { url: url },
actions: [
{ action: 'open',    title: 'View Now'  },
{ action: 'dismiss', title: 'Dismiss'   }
]
};
event.waitUntil(self.registration.showNotification(title, options));
});

// ── Tap notification → open site ──
self.addEventListener('notificationclick', function(event) {
event.notification.close();
if(event.action === 'dismiss') return;
var targetUrl = (event.notification.data && event.notification.data.url)
? event.notification.data.url : SITE_URL;
event.waitUntil(
clients.matchAll({ type: 'window', includeUncontrolled: true })
.then(function(clientList) {
for(var i = 0; i < clientList.length; i++) {
var client = clientList[i];
if(client.url.startsWith(SITE_URL) && 'focus' in client) {
client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl });
return client.focus();
}
}
if(clients.openWindow) return clients.openWindow(targetUrl);
})
);
});

self.addEventListener('notificationclose', function(event) {
console.log('[SW] Dismissed:', event.notification.tag);
});

// ── Message from page ──
self.addEventListener('message', function(event) {
if(!event.data) return;
if(event.data.type === 'SKIP_WAITING') self.skipWaiting();
if(event.data.type === 'SHOW_NOTIFICATION') {
var d = event.data;
self.registration.showNotification(d.title || 'GlobalDigits', {
body: d.body || '', icon: ICON_URL, badge: ICON_URL,
tag: d.tag || 'globaldigits-local', data: { url: d.url || SITE_URL }
});
}
});

self.addEventListener('fetch', function(event) {
// Network-first passthrough — extend for offline support if needed
});