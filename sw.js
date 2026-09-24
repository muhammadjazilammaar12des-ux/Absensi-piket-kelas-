const CACHE_NAME = 'absensi-piket-v37-20260924';
const CORE_ASSETS = [
  './',
  './index.html',
  './app-utils.js',
  './error-telemetry.js',
  './app-loader.js',
  './app-main.js',
  './sw.js',
  './manifest.json'
];

function isSameOrigin(request) {
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch (_) {
    return false;
  }
}

function shouldCacheSameOriginRequest(request) {
  if (!isSameOrigin(request) || request.method !== 'GET') return false;

  const url = new URL(request.url);
  const path = url.pathname.toLowerCase();
  const staticDestination = new Set(['document', 'script', 'style', 'manifest', 'image', 'font']);
  if (staticDestination.has(request.destination)) return true;

  // fetch() untuk aset model/WASM sering memakai destination "empty".
  // Cache hanya folder aset statis yang memang menjadi bagian aplikasi,
  // bukan seluruh endpoint GET agar data API/private tidak menjadi cache SW.
  return path.includes('/lib/') || path.includes('/models/');
}

async function cacheResponse(request, response) {
  if (!response?.ok || !shouldCacheSameOriginRequest(request)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch (_) {
    // Cache tidak boleh menggagalkan response utama.
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key.startsWith('absensi-piket-'))
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !isSameOrigin(request)) return;

  // Navigasi: network-first, lalu cached page sebagai fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then(async response => {
          await cacheResponse(request, response);
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          return cached || caches.match('./index.html');
        })
    );
    return;
  }

  // Hanya tangani aset statis. Endpoint GET backend/origin yang lain dibiarkan
  // langsung ke browser sehingga tidak ada stale API cache dan tidak ada
  // respondWith(undefined) saat jaringan gagal.
  if (!shouldCacheSameOriginRequest(request)) return;

  event.respondWith(
    fetch(request)
      .then(async response => {
        await cacheResponse(request, response);
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return cached || Response.error();
      })
  );
});
