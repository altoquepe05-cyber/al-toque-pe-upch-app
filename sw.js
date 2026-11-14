'use strict';

const CACHE_PREFIX = 'al-toque-pwa-';
const CACHE_VERSION = 'v1';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const CORE_ASSETS = [
  '/',
  '/manifest.json',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/offline-data.js?v=1',
  '/vendor/tailwind.js',
  '/vendor/react.development.js',
  '/vendor/react-dom.development.js',
  '/vendor/babel.min.js',
  '/vendor/lucide.js',
  '/vendor/fonts.css?v=2',
  '/vendor/fonts/coiny-400.ttf?v=2',
  '/lomo-saltado-imagen.png',
  '/bowl-quinua-imagen.png',
  '/al-toque-pe-logo.png',
  '/al-toque-pe-emblema.png'
];

function versionedUrl(url) {
  const result = new URL(url, self.location.origin);
  result.searchParams.set('__pwa_cache', CACHE_VERSION);
  return result.href;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(CORE_ASSETS.map(async (url) => {
      const response = await fetch(versionedUrl(url), { cache: 'reload' });
      if (!response.ok) throw new Error(`No se pudo precargar ${url} (${response.status}).`);
      await cache.put(new URL(url, self.location.origin).href, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET'
    || url.origin !== self.location.origin
    || url.pathname === '/sw.js'
    || url.pathname.startsWith('/api/')
    || request.headers.has('range')
  ) return;

  const isStatic = request.mode === 'navigate'
    || ['script', 'style', 'image', 'font', 'worker', 'manifest'].includes(request.destination)
    || /\.(?:html?|css|js|mjs|json|webmanifest|png|jpe?g|webp|svg|ico|ttf|woff2?)$/i.test(url.pathname);
  if (!isStatic) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(versionedUrl(request.url), { cache: 'reload' });
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const shell = await cache.match('/');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
