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
  e.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
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
function tileCacheKey(reqUrl) {
  const u = new URL(reqUrl);
  u.hostname = u.hostname.replace(/^[abc]\./, "");
  return u.href;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (isTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const key = tileCacheKey(req.url);
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        cache.put(key, resp.clone()).catch(() => {}); // opaque ok
        return resp;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try { return await fetch(req); }
      catch { return hit || Response.error(); }
    })());
  }
});
