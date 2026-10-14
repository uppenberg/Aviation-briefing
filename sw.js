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
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
          await cache.put(request, response.clone());
          const oldEntries = (await cache.keys()).filter(key => key.url !== request.url);
          await Promise.all(oldEntries.map(key => cache.delete(key)));
        }
        return response;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

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
