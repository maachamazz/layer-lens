/*
 * オフライン対応用 Service Worker
 * オンライン時は常にネットワークから最新を取り（更新がすぐ反映される）、
 * オフライン時だけキャッシュを使う。
 */
const CACHE = 'layer-lens-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './clip.js',
  './lib/ag-psd.js',
  './lib/fflate.js',
  './lib/sql-wasm.js',
  './lib/sql-wasm-binary.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
