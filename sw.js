// Offline: pliki aplikacji z pamięci podręcznej, w tle pobierana nowsza wersja.
const CACHE = 'vw-v1';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './data/slowka.json', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Dropbox idzie bez cache
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request)
      .then((res) => { if (res.ok && !url.search) cache.put(e.request, res.clone()); return res; })
      .catch(() => hit);
    return hit || net;
  }));
});
