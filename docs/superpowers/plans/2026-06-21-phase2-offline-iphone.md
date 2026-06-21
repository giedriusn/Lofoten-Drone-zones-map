# Phase 2 — Offline-on-iPhone PWA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Drone Zones map fully usable offline on an iPhone — cache the app shell + data + Norwegian basemap tiles via a service worker, installable as a PWA.

**Architecture:** Add a classic service worker (`sw.js`) that precaches the app shell/data and serves map tiles cache-first from a durable tile cache. Add pure tile math (`tiles.mjs`, unit-tested in Node) and runtime offline logic (`offline.mjs`): register the SW, add a Kartverket "Norway" basemap (open-licensed, bulk-cacheable, Norway-specific), and a "Download offline map" control that pre-fetches the region's tiles. Convert `app.js` to an ES module so it can import these and share the tile math with the tests.

**Tech Stack:** Vanilla JS ES modules (no build, no deps), Leaflet (vendored), Service Worker + Cache Storage + Web App Manifest, `node --test` for unit tests. Tile source: Kartverket WMTS (`cache.kartverket.no`, CC BY 4.0, keyless).

**Spec:** `docs/superpowers/specs/2026-06-21-phase2-offline-iphone-design.md`

## File Structure

- Create `tiles.mjs` — pure Web Mercator tile math + region enumeration + Kartverket URL builder + byte estimate. No DOM. Imported by `offline.mjs` and the tests.
- Create `scripts/tiles.test.mjs` — `node --test` unit tests for `tiles.mjs`.
- Create `sw.js` — service worker (classic script): precache shell/data, runtime cache-first tiles.
- Create `offline.mjs` — SW registration, Kartverket basemap factory, region-download control (progress/cancel/clear, storage persist + estimate). Imports `tiles.mjs`.
- Create `manifest.webmanifest` — PWA manifest.
- Create `icons/` — `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` (rendered from an SVG via Playwright).
- Modify `config.json` — add an `offline` block (min/max zoom, layer, bytesPerTile).
- Modify `index.html` — manifest + iOS meta + apple-touch-icon in `<head>`; add an `#offline` panel section; load `app.js` as `type="module"`.
- Modify `app.js` — convert to ES module; refactor `setupBasemaps` to be data-driven, add the Norway basemap, expose `switchTo`; register SW; mount the offline UI.
- Modify `style.css` — minimal styles for the offline section/progress.
- Modify `README.md` — document phase 2 (offline flow, deploy note, the new basemap).

---

### Task 1: Pure tile math + tests (TDD)

**Files:**
- Create: `tiles.mjs`
- Test: `scripts/tiles.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/tiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { lonToTileX, latToTileY, tilesForBbox, countTilesForBbox, kartverketUrl, estimateBytes } from "../tiles.mjs";

const REGION = [11.0, 66.7, 18.5, 69.6]; // [west, south, east, north]

test("lon/lat → tile matches reference points", () => {
  // Null Island at z1 is tile (1,1); region center ~ (14.8,68.2) at z8 is (138,60).
  assert.equal(lonToTileX(0, 1), 1);
  assert.equal(latToTileY(0, 1), 1);
  assert.equal(lonToTileX(14.8, 8), 138);
  assert.equal(latToTileY(68.2, 8), 60);
});

test("single-zoom enumeration covers the bbox (z8 = 7×6 = 42)", () => {
  const z8 = tilesForBbox({ bbox: REGION, minZoom: 8, maxZoom: 8 });
  assert.equal(z8.length, 42);
  for (const t of z8) assert.equal(t.z, 8);
});

test("count matches enumeration length and the measured z5–z12 total", () => {
  const opts = { bbox: REGION, minZoom: 5, maxZoom: 12 };
  assert.equal(countTilesForBbox(opts), tilesForBbox(opts).length);
  assert.equal(countTilesForBbox(opts), 10476);
});

test("maxZoom < minZoom yields no tiles", () => {
  assert.equal(tilesForBbox({ bbox: REGION, minZoom: 12, maxZoom: 5 }).length, 0);
});

test("kartverket URL uses WMTS {z}/{y}/{x} ordering", () => {
  assert.equal(
    kartverketUrl({ z: 8, x: 138, y: 60 }, "topo"),
    "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/8/60/138.png"
  );
});

test("byte estimate scales with tile count", () => {
  assert.equal(estimateBytes(10, 1000), 10000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/tiles.test.mjs`
Expected: FAIL — `Cannot find module ... tiles.mjs` (or export errors).

- [ ] **Step 3: Implement `tiles.mjs`**

```js
// tiles.mjs — pure Web Mercator tile math for the offline tile cache.
// No DOM; imported by offline.mjs (browser) and scripts/tiles.test.mjs (Node).

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

// Every {z,x,y} tile covering bbox=[west,south,east,north] for minZoom..maxZoom.
export function tilesForBbox({ bbox, minZoom, maxZoom }) {
  const [w, s, e, n] = bbox;
  const out = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xa = lonToTileX(w, z), xb = lonToTileX(e, z);
    const ya = latToTileY(n, z), yb = latToTileY(s, z); // north → smaller y
    for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++)
      for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++)
        out.push({ z, x, y });
  }
  return out;
}

// Same coverage as tilesForBbox().length without building the array.
export function countTilesForBbox({ bbox, minZoom, maxZoom }) {
  const [w, s, e, n] = bbox;
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const nx = Math.abs(lonToTileX(e, z) - lonToTileX(w, z)) + 1;
    const ny = Math.abs(latToTileY(s, z) - latToTileY(n, z)) + 1;
    total += nx * ny;
  }
  return total;
}

// Kartverket WMTS webmercator: TileMatrix(z) / TileRow(y) / TileCol(x).
// Pass literal {z}/{x}/{y} strings to build a Leaflet template URL.
export function kartverketUrl({ z, x, y }, layer = "topo") {
  return `https://cache.kartverket.no/v1/wmts/1.0.0/${layer}/default/webmercator/${z}/${y}/${x}.png`;
}

export function estimateBytes(tileCount, bytesPerTile = 15 * 1024) {
  return tileCount * bytesPerTile;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/tiles.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add tiles.mjs scripts/tiles.test.mjs
git commit -m "Add pure tile math for offline cache (tested)"
```

---

### Task 2: Service worker

**Files:**
- Create: `sw.js`

> Note: `sw.js` is a classic worker (broadest iOS support) and cannot import ES modules reliably, so the tile-host list + cache names are duplicated here (kept tiny). The cache names MUST match `offline.mjs` (`drone-shell-v1`, `drone-tiles-v1`).

- [ ] **Step 1: Write `sw.js`**

```js
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
```

- [ ] **Step 2: Sanity-check syntax**

Run: `node --check sw.js`
Expected: no output (valid JS).

- [ ] **Step 3: Commit**

```bash
git add sw.js
git commit -m "Add service worker: precache app shell + runtime tile caching"
```

> Full offline behaviour is verified end-to-end in Task 6 (requires HTTPS/localhost + a browser).

---

### Task 3: Manifest, icons, and `<head>` wiring

**Files:**
- Create: `manifest.webmanifest`, `icons/*.png`
- Modify: `index.html` (head)

- [ ] **Step 1: Write `manifest.webmanifest`**

```json
{
  "name": "Drone Zones — Lofoten · Bodø · Narvik",
  "short_name": "Drone Zones",
  "description": "Offline map of permanent drone-flight restrictions in Northern Norway.",
  "start_url": ".",
  "scope": ".",
  "display": "standalone",
  "background_color": "#0f1720",
  "theme_color": "#0f1720",
  "orientation": "any",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 2: Generate the icons**

Source SVG (dark bg, orange ⬡ hexagon ring, cyan centre dot — echoes the app mark and pick-marker). Render to PNG with Playwright at exact pixel sizes (set viewport = N×N, body = the scaled SVG, `browser_take_screenshot`), then place in `icons/`:
- `icon-192.png` (192), `icon-512.png` (512), `apple-touch-icon.png` (180) — full-bleed art.
- `icon-maskable-512.png` (512) — same art at ~62% scale (centred) so it survives Android/iOS mask cropping.

Verify each exists and is a PNG of the right dimensions:
Run: `file icons/*.png`
Expected: `PNG image data, 192 x 192` / `512 x 512` / `180 x 180` / `512 x 512`.

- [ ] **Step 3: Add to `index.html` `<head>`** (after the existing `<link rel="stylesheet" href="style.css" />`)

```html
  <link rel="manifest" href="manifest.webmanifest" />
  <meta name="theme-color" content="#0f1720" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Drone Zones" />
  <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
```

- [ ] **Step 4: Commit**

```bash
git add manifest.webmanifest icons index.html
git commit -m "Add web app manifest, icons, and iOS PWA meta tags"
```

---

### Task 4: `config.json` offline block + `offline.mjs` + styles

**Files:**
- Modify: `config.json`
- Create: `offline.mjs`
- Modify: `style.css`

- [ ] **Step 1: Add the `offline` block to `config.json`** (sibling of `region`)

```json
  "offline": {
    "minZoom": 5,
    "maxZoom": 12,
    "layer": "topo",
    "bytesPerTile": 15360
  }
```

- [ ] **Step 2: Write `offline.mjs`**

```js
// offline.mjs — service-worker registration, the Kartverket "Norway" basemap,
// and the "Download offline map" control. Imports pure math from tiles.mjs.
import { tilesForBbox, countTilesForBbox, kartverketUrl, estimateBytes } from "./tiles.mjs";

const TILE_CACHE = "drone-tiles-v1"; // MUST match sw.js

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => console.warn("SW register failed", err));
  });
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

// Kartverket topographic basemap. maxNativeZoom caps real tile requests at the
// cached depth; maxZoom 18 lets the user zoom further by upscaling cached tiles.
export function kartverketBasemap(L, { layer = "topo", maxNativeZoom = 12 } = {}) {
  return L.tileLayer(kartverketUrl({ z: "{z}", x: "{x}", y: "{y}" }, layer), {
    maxNativeZoom, maxZoom: 18,
    attribution: "© Kartverket (CC BY 4.0) · airspace luftrom.info · vern Miljødirektoratet",
  });
}

const fmtMB = b => (b / (1024 * 1024)).toFixed(0);

// Download every region tile into TILE_CACHE with bounded concurrency. Opaque
// (no-cors) responses are cacheable and render in Leaflet's cross-origin <img>.
async function downloadRegion({ bbox, minZoom, maxZoom, layer, signal, onProgress }) {
  const tiles = tilesForBbox({ bbox, minZoom, maxZoom });
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0;
  const fetchOne = async t => {
    const url = kartverketUrl(t, layer);
    if (await cache.match(url)) return;       // resumable: skip cached
    const resp = await fetch(url, { mode: "no-cors", signal });
    await cache.put(url, resp);
  };
  const worker = async () => {
    while (i < tiles.length) {
      if (signal.aborted) return;
      const t = tiles[i++];
      try { await fetchOne(t); }
      catch (e) {
        if (signal.aborted) return;
        try { await fetchOne(t); } catch { failed++; } // one retry
      }
      onProgress(++done, tiles.length, failed);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed, total: tiles.length };
}

async function usageText() {
  if (!navigator.storage?.estimate) return "";
  try { const { usage } = await navigator.storage.estimate(); return usage ? ` · ~${fmtMB(usage)} MB used` : ""; }
  catch { return ""; }
}

// Build the offline UI inside #offline. `switchBasemap("Norway")` aligns what is
// cached with what is shown. No-op (section hidden) when SW unsupported.
export function setupOfflineUI({ config, switchBasemap }) {
  const root = document.getElementById("offline");
  if (!root || !("serviceWorker" in navigator) || !("caches" in window)) return;
  const o = config.offline || {};
  const bbox = config.region.bbox;
  const minZoom = o.minZoom ?? 5, maxZoom = o.maxZoom ?? 12, layer = o.layer || "topo";
  const total = countTilesForBbox({ bbox, minZoom, maxZoom });
  const est = estimateBytes(total, o.bytesPerTile ?? 15 * 1024);

  root.hidden = false;
  root.innerHTML = `
    <span class="offline__label">Offline use</span>
    <button id="dlOffline" class="rulesbtn">⬇ Save map for offline (Norway)</button>
    <div id="dlStatus" class="offline__status">~${total.toLocaleString()} tiles · ~${fmtMB(est)} MB · use Wi-Fi first</div>`;
  const btn = root.querySelector("#dlOffline");
  const status = root.querySelector("#dlStatus");
  let controller = null;

  const showIdle = async () => {
    btn.textContent = "⬇ Save map for offline (Norway)";
    btn.classList.remove("rulesbtn--danger");
    status.innerHTML = `~${total.toLocaleString()} tiles · ~${fmtMB(est)} MB${await usageText()}`
      + ` · <button id="clrOffline" class="linkbtn">Clear</button>`;
    const clr = status.querySelector("#clrOffline");
    if (clr) clr.onclick = async () => { await caches.delete(TILE_CACHE); status.textContent = "Offline map cleared."; setTimeout(showIdle, 1200); };
  };

  btn.onclick = async () => {
    if (controller) { controller.abort(); return; }   // click again = cancel
    switchBasemap && switchBasemap("Norway");
    controller = new AbortController();
    btn.textContent = "■ Cancel download";
    btn.classList.add("rulesbtn--danger");
    try {
      const r = await downloadRegion({
        bbox, minZoom, maxZoom, layer, signal: controller.signal,
        onProgress: (done, t, failed) => {
          status.textContent = `Saving… ${done.toLocaleString()} / ${t.toLocaleString()}`
            + ` (~${fmtMB(estimateBytes(done, o.bytesPerTile ?? 15 * 1024))} MB)`
            + (failed ? ` · ${failed} failed` : "");
        },
      });
      status.textContent = controller.signal.aborted
        ? `Stopped — partial map saved (${r.done.toLocaleString()} tiles).`
        : `Saved ${ (r.done - r.failed).toLocaleString() } tiles${ r.failed ? ` (${r.failed} failed)` : "" }. Works offline now.`;
    } catch (e) {
      status.textContent = "Download failed — check your connection and try again.";
    } finally {
      controller = null;
      setTimeout(showIdle, 2500);
    }
  };

  showIdle();
}
```

- [ ] **Step 3: Add styles to `style.css`** (append; reuse existing `.rulesbtn` look)

```css
/* Offline section */
.offline { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.offline__label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
.offline__status { font-size: 12px; opacity: .85; line-height: 1.4; }
.rulesbtn--danger { border-color: #ff6b6b; color: #ff9f9f; }
.linkbtn { background: none; border: none; color: #4ea1ff; cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
```

- [ ] **Step 4: Sanity-check syntax**

Run: `node --check offline.mjs && python3 -c "import json,sys; json.load(open('config.json'))"`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add offline.mjs config.json style.css
git commit -m "Add offline.mjs: Kartverket basemap + region download UI"
```

---

### Task 5: Wire it into `app.js` (ES module) + `index.html`

**Files:**
- Modify: `app.js` (convert to module, refactor basemaps, register SW, mount offline UI)
- Modify: `index.html` (add `#offline` section; load app.js as module)

- [ ] **Step 1: Add the offline section to `index.html`** — inside `.panel__body`, right after the `<section class="basemaps">…</section>` block:

```html
      <section class="offline" id="offline" hidden></section>
```

- [ ] **Step 2: Load `app.js` as a module** — change the final script tag:

```html
  <script src="vendor/leaflet.js"></script>
  <script type="module" src="app.js"></script>
```

(Leaflet stays a classic script and runs first, defining the global `L` before the deferred module executes.)

- [ ] **Step 3: Add imports at the very top of `app.js`**

```js
import { registerServiceWorker, kartverketBasemap, setupOfflineUI } from "./offline.mjs";
```

- [ ] **Step 4: Register the SW** — first line inside `init()` (before `config = await …` is fine, but put it at the top of `init`):

```js
  registerServiceWorker();
```

- [ ] **Step 5: Refactor `setupBasemaps()`** to be data-driven, add the Norway basemap, and return a `switchTo` API. Replace the whole existing function with:

```js
function setupBasemaps() {
  const offMax = config.offline?.maxZoom ?? 12;
  const bases = {
    Map: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "© OpenStreetMap · airspace luftrom.info · vern Miljødirektoratet",
    }),
    Norway: kartverketBasemap(L, { layer: config.offline?.layer || "topo", maxNativeZoom: offMax }),
    Topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17, attribution: "© OpenTopoMap (CC-BY-SA) · OpenStreetMap",
    }),
    Satellite: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18, attribution: "© Esri World Imagery",
    }),
  };
  const DEFAULT = "Map";
  const seg = document.getElementById("basemaps");
  const buttons = {};
  let current = bases[DEFAULT];
  current.addTo(map);

  function switchTo(label) {
    const layer = bases[label];
    if (!layer || layer === current) return;
    map.removeLayer(current);
    layer.addTo(map);
    current = layer;
    Object.values(buttons).forEach(c => c.classList.remove("active"));
    buttons[label].classList.add("active");
  }

  Object.keys(bases).forEach(label => {
    const b = document.createElement("button");
    b.textContent = label;
    if (label === DEFAULT) b.classList.add("active");
    b.onclick = () => switchTo(label);
    seg.appendChild(b);
    buttons[label] = b;
  });

  return { switchTo };
}
```

- [ ] **Step 6: Capture the basemap API and mount the offline UI** — in `init()`, change `setupBasemaps();` to capture the return, and after `wireControls();` add the offline UI:

```js
  const basemaps = setupBasemaps();
  ...
  wireControls();
  setupOfflineUI({ config, switchBasemap: basemaps.switchTo });
```

- [ ] **Step 7: Verify no inline handlers broke** — module scope hides app.js functions from the global namespace.

Run: `grep -nE '\son(click|change|load|input|submit|key|focus|blur)=' index.html`
Expected: no matches (all handlers are wired in JS by id). If any appear, they must be rewired in JS. (A loose `on[a-z]+=` pattern false-positives on `content=` in the meta tags — use the tightened pattern above.)

- [ ] **Step 8: Syntax check**

Run: `node --check app.js`
Expected: exit 0 (Node v25 auto-detects the ES module and accepts top-level `import`). Real runtime behaviour is verified in the browser load test in Task 6.

- [ ] **Step 9: Commit**

```bash
git add app.js index.html
git commit -m "Wire offline PWA into the app: module, Norway basemap, offline UI"
```

---

### Task 6: End-to-end verification + docs + review

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Serve locally**

Run (background): `python3 -m http.server 8765`

- [ ] **Step 2: Online load test (Playwright)** — navigate to `http://localhost:8765`, confirm:
  - No console errors; the map, panel, and data layers render.
  - The basemap segment shows **Map / Norway / Topo / Satellite**; clicking **Norway** switches to Kartverket tiles.
  - The **Offline use** section shows the tile/MB estimate.
  - `navigator.serviceWorker.controller` is set (SW active) — check via `browser_evaluate`.

- [ ] **Step 3: Download + offline test (Playwright)** — temporarily exercise a small download to keep it fast: via `browser_evaluate`, import `tiles.mjs` and confirm `countTilesForBbox` for z5–z8 is small; trigger the real download button but cancel after a few hundred tiles (or set the cache with a z5–9 subset). Then:
  - `browser_evaluate`: `caches.open('drone-tiles-v1').then(c=>c.keys()).then(k=>k.length)` → > 0.
  - Set the browser **offline** (`browser_evaluate` won't; use the Playwright context offline or block network). Reload the page. Confirm the app shell + data layers load and the **Norway** basemap shows cached tiles at zoomed-out levels (z5–9).
  - Confirm `navigator.onLine === false` path doesn't throw.

- [ ] **Step 4: Capture a screenshot** of the offline section for the README/record.

- [ ] **Step 5: Update `README.md`** — replace the "Phase 2 — offline on iPhone (not done yet)" section with a "done" section: the Norway/Kartverket basemap, the **Save map for offline** button, the install-to-home-screen flow, the HTTPS/online-first-launch requirement, and the z12/~150 MB note + how to tune `config.json` `offline`.

- [ ] **Step 6: Commit docs**

```bash
git add README.md
git commit -m "README: document phase 2 (offline PWA, Norway basemap)"
```

- [ ] **Step 7: Code review** — dispatch the superpowers:code-reviewer subagent against the branch diff vs `main`; address findings (re-running `node --test scripts/tiles.test.mjs` after any tile-math change).

- [ ] **Step 8: Final verification** — re-run `node --test scripts/tiles.test.mjs` (PASS) and re-confirm the offline reload works after any review fixes.

---

## Notes for the implementer

- **DRY:** `TILE_CACHE` cache name and the Kartverket layer string appear in both `sw.js` (classic, can't import) and `offline.mjs` — keep them identical; this is the one accepted duplication.
- **iOS realities:** the storage estimate is approximate; `persist()` may be denied; tiles can be evicted after long disuse — the README/UI copy must not over-promise.
- **Don't** bump `TILE_CACHE`'s version on app updates (only `SHELL_CACHE`), or every release forces a ~150 MB re-download.
- **Graceful degradation:** every offline feature is feature-detected; with no SW/Cache support the app must behave exactly as phase 1.
