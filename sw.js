/**
 * RENAISSANCE FINANCE KPI — service worker
 *
 * Caches only the app shell (HTML, JS, CSS, icons, fonts) so the interface opens without internet.
 * Business data is NOT cached here: it is loaded from the Supabase cloud database (another origin, always network).
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const SHELL_CACHE = `renaissance-shell-${VERSION}`;
const FONT_CACHE = 'renaissance-fonts-v1';
const NETWORK_TIMEOUT_MS = 4000;

const SHELL_FILES = [
  './',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })));
      // Also cache the hashed JS/CSS bundles referenced by index.html, so the very first visit is enough for offline
      const res = await fetch('./', { cache: 'reload' });
      const html = await res.text();
      const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((m) => m[1]);
      await cache.addAll(assets);
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('renaissance-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Page navigations: fresh HTML from the network, cached copy when offline or the network is too slow
async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
    ]);
    if (response.ok && response.type === 'basic') cache.put('./', response.clone());
    return response;
  } catch {
    return (await cache.match('./')) || Response.error();
  }
}

// Hashed bundles never change: cache first
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// Fonts, icons, manifest: answer from cache immediately, refresh in the background
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === 'navigate') {
      event.respondWith(handleNavigation(request));
    } else if (url.pathname.includes('/assets/')) {
      event.respondWith(cacheFirst(request, SHELL_CACHE));
    } else {
      event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    }
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  }
  // Everything else (other sites) goes straight to the network and is not cached
});
