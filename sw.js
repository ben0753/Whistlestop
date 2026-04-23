const CACHE_NAME = 'whistlewise-pwa-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './script.css',
  './script.js',
  './manifest.json',
  './sw.js',
  './model/model.json',
  './model/metadata.json',
  './model/model.weights.bin'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
