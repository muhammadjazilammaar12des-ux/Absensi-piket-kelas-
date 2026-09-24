const CACHE_NAME = 'absensi-piket-v36-20260924';
const CORE_ASSETS = ['./','./index.html','./app-utils.js','./error-telemetry.js','./app-loader.js','./app-main.js','./sw.js','./manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key !== CACHE_NAME && key.startsWith('absensi-piket-')).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const isSameOrigin = new URL(request.url).origin === self.location.origin;
  event.respondWith(
    fetch(request).then(response => {
      if (isSameOrigin && response?.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(request).then(cached => cached || (isSameOrigin && request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
