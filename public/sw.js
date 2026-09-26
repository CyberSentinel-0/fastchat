const CACHE_NAME = 'fastchat-v11.4';
const ASSETS = [
    '/',
    '/index.html',
    '/style.css?v=11.4',
    '/app.js?v=11.4',
    '/calls.js?v=11.4',
    '/watchparty.js?v=1.0',
    '/manifest.json'
];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {}))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Bypass API requests and local dev
    if (url.pathname.startsWith('/api') || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        return;
    }

    // Stale-While-Revalidate: Instant <25ms launch from disk cache, update in background
    e.respondWith(
        caches.match(e.request).then((cached) => {
            const fetchPromise = fetch(e.request)
                .then((networkRes) => {
                    if (networkRes && networkRes.status === 200 && e.request.method === 'GET') {
                        const resClone = networkRes.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, resClone));
                    }
                    return networkRes;
                })
                .catch(() => cached);

            return cached || fetchPromise;
        })
    );
});
