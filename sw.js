importScripts('./version.js');

const CACHE_NAME = `aviation-briefing-shell-v${self.AVIATION_BRIEFING_VERSION}`;
const NSWC_CACHE_NAME = 'aviation-briefing-nswc-v1';
const APP_SHELL = [
  './index.html',
  './version.js',
  './styles.css',
  './app.js',
  './presets/index.json',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(async () => {
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match('./presets/index.json');
        const catalog = response ? await response.json().catch(() => ({})) : {};
        const files = Array.isArray(catalog.presets) ? catalog.presets
          .map(preset => preset?.file)
          .filter(file => typeof file === 'string' && /^[A-Za-z0-9_-]+\.json$/.test(file)) : [];
        await Promise.all(files.map(file => cache.add(`./presets/${file}`).catch(error => {
          console.warn(`Could not cache preset ${file}:`, error);
        })));
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('aviation-briefing-shell-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method === 'GET' && url.origin === 'https://aro.lfv.se' && url.pathname === '/tor/nswc2aro.gif') {
    event.respondWith((async () => {
      const cache = await caches.open(NSWC_CACHE_NAME);
      const entries = await cache.keys();
      const previousKey = entries.find(key => key.url !== request.url);
      const previousImage = previousKey ? await cache.match(previousKey) : null;
      const cached = await cache.match(request);
      if (cached && !url.searchParams.has('refresh')) return cached;
      try {
        const response = await fetch(request);
        if (!response.ok && response.type !== 'opaque') return previousImage || response;
        // Keep the previous chart until the refreshed image is safely stored.
        await cache.put(request, response.clone());
        const oldEntries = (await cache.keys()).filter(key => key.url !== request.url);
        await Promise.all(oldEntries.map(key => cache.delete(key)));
        return response;
      } catch {
        return previousImage || cached || Response.error();
      }
    })());
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/version.js')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('./index.html', response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  })));
});
