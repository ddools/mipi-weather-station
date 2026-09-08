/*
 * Service worker for the Skerries weather dashboard.
 *
 * Bump CACHE_VERSION whenever the caching strategy below changes; it names the
 * caches, and activate() deletes every cache that isn't in CURRENT_CACHES.
 *
 * Strategies, by request kind:
 *   - navigations        network-first, falling back to the last page seen, then /offline
 *   - live data          network-first, falling back to the last good response
 *     (/api/*, server islands — so an offline launch shows the last readings)
 *   - hashed build output cache-first (/_astro/* filenames are content-hashed)
 *   - other static files stale-while-revalidate (icons, favicons, manifest)
 *   - cross-origin       not intercepted (Open-Meteo, RainViewer, Esri tiles)
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `ws-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `ws-assets-${CACHE_VERSION}`;
const DATA_CACHE = `ws-data-${CACHE_VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE, DATA_CACHE];

const OFFLINE_URL = "/offline";
// Astro builds the offline page to `offline/index.html`; which of these the
// host serves without a redirect depends on its clean-URL handling, so try both.
const OFFLINE_CANDIDATES = [OFFLINE_URL, "/offline/"];
const PRECACHE = ["/manifest.webmanifest", "/icons/icon-192.png"];

// The live-data caches are small and fixed in shape, but cap them anyway so a
// long-lived install can't grow without bound.
const DATA_CACHE_LIMIT = 32;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Nothing here is fatal: a worker with a half-filled cache still serves
      // pages you've visited, which beats having no worker at all.
      await Promise.allSettled([
        precacheOffline(cache),
        ...PRECACHE.map((url) => precache(cache, url, url)),
      ]);
      await self.skipWaiting();
    })(),
  );
});

/** Store the offline page under OFFLINE_URL, whichever path the host serves it from. */
async function precacheOffline(cache) {
  for (const candidate of OFFLINE_CANDIDATES) {
    try {
      await precache(cache, candidate, OFFLINE_URL);
      return;
    } catch {
      // Try the next spelling.
    }
  }
  console.warn("[sw] offline page unavailable; falling back to cached pages only");
}

async function precache(cache, url, key) {
  const response = await fetch(url, { cache: "reload" });
  if (!response.ok) throw new Error(`precache failed: ${url} (${response.status})`);
  // Re-wrap the body so a redirected response is never stored: the browser
  // refuses to satisfy a navigation from one.
  await cache.put(
    key,
    new Response(await response.blob(), {
      status: 200,
      statusText: "OK",
      headers: response.headers,
    }),
  );
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !CURRENT_CACHES.includes(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationStrategy(request));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_server-islands/")) {
    event.respondWith(networkFirst(request, DATA_CACHE, DATA_CACHE_LIMIT));
    return;
  }
  if (url.pathname.startsWith("/_astro/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});

/** Fresh page when online; last page seen when not; /offline as the last resort. */
async function navigationStrategy(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (
      (await cache.match(request, { ignoreSearch: true })) ??
      (await cache.match(OFFLINE_URL)) ??
      Response.error()
    );
  }
}

async function networkFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      await cache.put(request, response.clone());
      if (limit) trim(cacheName, limit);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? Response.error();
}

/** Only store our own complete, successful responses — never errors or opaque ones. */
function isCacheable(response) {
  return response && response.ok && response.type === "basic";
}

/** Drop the oldest entries once a cache passes `limit`. */
async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) {
    await cache.delete(key);
  }
}
