/* Absensi Piket — Recovery Service Worker v34 */
const CACHE_NAME = 'absensi-piket-v34-20260922';
const CACHE_PREFIX = 'absensi-piket-';
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL).catch(() => {}))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys
                    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', event => {
    if (event?.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch (_) {
        return;
    }

    if (url.origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            const networkResponse = await fetch(request, { cache: 'no-store' });
            if (networkResponse && networkResponse.ok) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, networkResponse.clone());
            }
            return networkResponse;
        } catch (_) {
            const cached = await caches.match(request);
            if (cached) return cached;

            const fallback = await caches.match('./index.html');
            if (fallback && request.mode === 'navigate') return fallback;

            throw _;
        }
    })());
});
