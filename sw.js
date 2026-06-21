/* Service worker — offline app shell + map tiles. Classic worker for iOS support. */
const SHELL_CACHE = "drone-shell-v1";
const TILE_CACHE = "drone-tiles-v1"; // NOT version-bumped: tiles are large & stable.

const SHELL_ASSETS = [
  "./", "./index.html", "./app.js", "./style.css", "./config.json",
  "./manifest.webmanifest", "./offline.mjs", "./tiles.mjs",
  "./vendor/leaflet.js", "./vendor/leaflet.css",
  "./vendor/images/layers.png", "./vendor/images/layers-2x.png",
  "./vendor/images/marker-icon.png", "./vendor/images/marker-icon-2x.png",
  "./vendor/images/marker-shadow.png",
  "./data/airports.geojson", "./data/airspace.geojson", "./data/nature.geojson",
  "./data/populated.geojson", "./data/helipads.geojson",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png",
];

// Tile hosts cached at runtime. {s} = a/b/c subdomains are normalized in tileCacheKey.
const TILE_HOSTS = [
  "cache.kartverket.no", "tile.openstreetmap.org",
  "tile.opentopomap.org", "server.arcgisonline.com",
];

self.addEventListener("install", e => {
  // Per-asset (allSettled, not addAll) so a single missing/renamed file degrades
  // one tile instead of aborting install and silently disabling ALL offline support.
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL_ASSETS.map(a => c.add(a)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SHELL_CACHE && k !== TILE_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isTile(url) {
  return TILE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith("." + h));
}

// Drop a leading a./b./c. subdomain so a tile cached under one is found under another.
function tileCacheKey(url) {
  const u = new URL(url); // clone — don't mutate the caller's URL
  u.hostname = u.hostname.replace(/^[abc]\./, "");
  return u.href;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Map tiles: cache-first against the durable tile cache. On a miss we fetch with
  // CORS (every basemap host sends `Access-Control-Allow-Origin: *`) so we can check
  // the status and only cache a real tile — a transient 4xx/5xx must not poison the
  // cache and then be served forever. The CORS response renders fine in Leaflet's
  // <img> tiles. Cache under the {s}-normalized key so a/b/c subdomains share entries.
  if (isTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const key = tileCacheKey(url);
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const resp = await fetch(req.url, { mode: "cors" });
        if (resp.ok) cache.put(key, resp.clone()).catch(() => {});
        return resp;
      } catch {
        // CORS unavailable (a host dropped its ACAO header) or offline. Fall back to
        // the original no-cors <img> request so installing the PWA never *breaks* an
        // online basemap that renders fine without the service worker. Opaque status
        // is unreadable, so we don't cache this fallback — that would risk poisoning
        // the durable cache with an error tile.
        try { return await fetch(req); }
        catch { return Response.error(); }
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    // Restriction data + config are network-first (fresh when online, cached when
    // offline) so a corrected zone or a config tweak propagates without bumping the
    // shell cache version. App-shell code/assets stay cache-first for instant loads
    // (bump SHELL_CACHE to ship shell changes).
    const networkFirst = url.pathname.endsWith(".geojson") || url.pathname.endsWith("config.json");
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      if (networkFirst) {
        try {
          const resp = await fetch(req);
          if (resp.ok) { cache.put(req, resp.clone()).catch(() => {}); return resp; }
          // Server reachable but erroring (e.g. 5xx): prefer a good cached copy over
          // handing the app an error body — that would blank a data layer (or fail
          // init on config.json) even though we have valid data cached. Only return
          // the error if nothing is cached.
          return (await cache.match(req, { ignoreSearch: true })) || resp;
        } catch {
          return (await cache.match(req, { ignoreSearch: true })) || Response.error();
        }
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); }
      catch { return hit || Response.error(); }
    })());
  }
});
