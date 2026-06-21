# Phase 2 — Offline on iPhone (PWA) — Design

**Date:** 2026-06-21
**Status:** Design (author away; decisions made autonomously per instruction "don't ask questions", to be double-checked by spec + code review subagents)

## Goal

Make the existing Drone Zones map usable **in the field with no signal** on an
iPhone. Phase 1 already loads all restriction data from local files; the only
thing that needs the network at runtime is the **basemap tiles**. So phase 2 is:

1. Make basemap tiles available offline for the whole region.
2. Add a service worker + web app manifest so the app installs to the iOS home
   screen and loads fully offline ("Add to Home Screen" in Safari).

Everything must keep the project's existing constraints: **no build step, no npm
dependencies, vanilla JS, keyless data sources, served as static files.**

## Scope

**In scope**
- Service worker that pre-caches the app shell + all local data and serves
  cached map tiles offline.
- Web app manifest + iOS meta tags + app icons → installable, standalone PWA.
- A new **Kartverket "Norway"** basemap (official Norwegian topo) that is the
  offline-cacheable layer.
- A **"Download offline map"** control: pre-fetch every tile for the region
  across a sensible zoom range into the cache, with progress, cancel, a storage
  estimate, and a "clear offline data" action.
- Graceful degradation: if service workers / Cache API are unavailable the app
  behaves exactly as it does today (online only).

**Out of scope (documented, not built)**
- Geolocation / "where am I" (GPS works offline and would pair well with this,
  but the user defined phase 2 strictly as *offline tiles + PWA*; left for a
  future phase to keep scope tight and verification simple).
- Vector tiles / PMTiles (would add a vendored rendering dependency and a
  generation step; conflicts with the no-build/no-dep ethos — see Alternatives).
- Offline NOTAMs / any new restriction data (phase-1 scope choice stands).

## Why Kartverket for the offline basemap

The current basemaps (OpenStreetMap, OpenTopoMap, Esri World Imagery) are kept
for **online** use, but none is appropriate to **bulk-download** for offline:
the OSMF tile usage policy explicitly forbids bulk downloading, and the others
have similar restrictions. Downloading ~10k tiles for offline use needs a source
whose terms allow it.

**Kartverket** (the Norwegian Mapping Authority) publishes open WMTS tile caches
that are keyless, CC BY 4.0 / NLOD-licensed, designed for high-volume public
consumption, and **the best basemap for Norway specifically**:

- `https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png`
- (grayscale variant: `topograatone`)

Verified working: returns keyless 256×256 PNG tiles, Web Mercator, standard
WMTS `{z}/{y}/{x}` (TileMatrix / TileRow=y / TileCol=x) ordering — directly usable
by a Leaflet `tileLayer` with the URL rewritten to `{z}/{y}/{x}`.

So: add Kartverket as a basemap option ("Norway"), and make it the layer the
offline download targets. The other basemaps still work online and are
opportunistically runtime-cached (tiles you actually viewed remain available
offline), but the *guaranteed* offline basemap is Kartverket.

## Tile budget (measured for bbox [11.0, 66.7, 18.5, 69.6])

| Zooms | Tiles (cumulative) | ~Size @15 KB |
|------:|------:|------:|
| z5–z10 | 712 | ~10 MB |
| z5–z11 | 2,736 | ~40 MB |
| **z5–z12 (default)** | **10,476** | **~154 MB** |
| z5–z13 | 41,085 | ~600 MB |
| z5–z14 | 162,837 | ~2.4 GB |

**Decision:** default offline range **z5–z12** (~10.5k tiles, ~150 MB). z13+ is
too large for reliable iOS storage quotas. The low zooms (z5–9, ~200 tiles) are
nearly free and keep zoom-out smooth. Min/max zoom are configurable in
`config.json` (`offline.minZoom` / `offline.maxZoom`) so the budget can be tuned
without code changes. The download UI shows the tile count and estimated size,
and the Kartverket layer uses `maxNativeZoom = maxZoom` with `maxZoom = 18`, so
zooming past the cached level **upscales** the deepest cached tiles rather than
showing blank tiles.

## Architecture

Four new files + small edits to `index.html` and conversion of `app.js` to an ES
module. ES modules are supported by every browser that supports service workers
(incl. iOS Safari), need no build, and let the pure tile math be unit-tested in
Node from the same source the browser runs.

```
tiles.mjs        Pure functions: lon/lat→tile, region tile enumeration,
                 Kartverket URL builder, size estimate. NO DOM. Unit-tested.
offline.mjs      DOM/runtime: register SW, build Kartverket basemap layer,
                 "Download offline map" control (progress/cancel/clear),
                 storage persist + estimate. Imports tiles.mjs.
sw.js            Service worker (classic script). Precache app shell + data;
                 runtime cache-first for tiles into a separate, durable cache.
manifest.webmanifest   PWA manifest (name, icons, standalone, theme).
icons/           apple-touch-icon.png (180), icon-192.png, icon-512.png,
                 icon-maskable-512.png. Generated from an SVG of the ⬡ mark.
scripts/tiles.test.mjs   node --test unit tests for tiles.mjs.
```

`app.js` becomes `<script type="module" src="app.js">`; it imports from
`tiles.mjs`/`offline.mjs`, registers the SW, adds the Kartverket basemap, and
mounts the offline control. (Safe: index.html has no inline event handlers that
rely on app.js globals — everything is wired by id in JS.)

### Service worker behaviour

- **install** → precache the app shell with relative URLs (`./`, `./index.html`,
  `./app.js`, `./style.css`, `./config.json`, `./manifest.webmanifest`,
  `./offline.mjs`, `./tiles.mjs`, `vendor/leaflet.{js,css}`, the 5 `vendor/images`,
  all 5 `data/*.geojson`, the 4 icons). Relative URLs keep it working both on
  `localhost` and under a GitHub-Pages project subpath. `skipWaiting()`.
- **activate** → delete old *shell* caches (versioned by `SHELL_CACHE`), **keep**
  the tile cache (large, stable; only cleared on explicit user action).
  `clients.claim()`.
- **fetch**:
  - Tile hosts (`cache.kartverket.no` + the online basemap hosts) → **cache-first**
    against `TILE_CACHE`; on a cache miss, fetch with **CORS** (`mode: "cors"`) so the
    response status is readable, and **only cache a `2xx` tile** — a transient
    4xx/5xx/429 must not poison the durable cache and then be served forever. If the
    CORS fetch rejects (a host dropped its `Access-Control-Allow-Origin: *`, or we are
    offline), fall back to the original no-cors `<img>` request and return it
    **uncached** (opaque status is unreadable), so installing the PWA never *breaks*
    an online basemap that renders fine without the SW.
    Offline + uncached → fail (blank tile; mitigated by `maxNativeZoom`).
    Match tile hosts by **hostname suffix/pattern, not exact origin**, because
    OSM/OpenTopoMap rotate across `{s}` = `a/b/c` subdomains; the cache key is
    normalized to a single subdomain so a tile cached under `a.` is found when
    Leaflet later requests it under `b.` (this only affects the opportunistic
    online-basemap caching, not the guaranteed Kartverket path).
  - Same-origin shell/data → **cache-first** against `SHELL_CACHE`, fall back to
    network.
  - Everything else → passthrough to network.

`SHELL_CACHE` is version-bumped on app updates; `TILE_CACHE` is not, so a code
change never forces a 150 MB re-download.

### Offline download

`offline.mjs` enumerates `tilesForBbox({bbox, minZoom, maxZoom})` from
`tiles.mjs`, then fetches each Kartverket URL with **bounded concurrency** (≈6)
and an `AbortController` for cancel. Each tile is fetched with **CORS**
(`mode: "cors"`; Kartverket sends `Access-Control-Allow-Origin: *`) so the status
is readable, and only a `2xx` response is written into `TILE_CACHE` — a failed
fetch is left **uncached** so a silent hole can't masquerade as a saved tile, and
re-running the download fills the gaps. The SW reads the same cache key, so the
downloaded tiles serve offline. Already-cached tiles are skipped (`cache.match`)
so re-runs are cheap and resumable.

UI: a small section in the control panel — a **"⬇ Download offline map (Norway)"**
button that shows live `done / total · MB` progress and a cancel button while
running; on completion it reports cached tiles + storage used
(`navigator.storage.estimate()`, presented as an *approximate* indicator — iOS
reports coarse/quota-capped figures, so the UI copy must not claim it is exact),
and offers **"Clear offline map"**. Starting a download switches the active
basemap to **Norway** so what's cached is what's on screen.
`navigator.storage.persist()` is requested to reduce iOS eviction.

### Error handling

- No SW / no Cache API → feature-detect; hide the offline UI, app works online as
  today.
- Individual tile fetch failures during download → counted, retried once, then
  skipped; the run continues and reports how many failed (no silent truncation).
- `persist()` denied → proceed anyway; note in the UI that iOS may evict unused
  data after extended disuse.
- Offline + tile not cached → blank tile (upscaling hides most cases).

### Testing

- **Unit (node --test, no deps):** `tiles.mjs` — `lonToTileX`/`latToTileY` against
  known reference tiles, bbox enumeration counts match the measured table,
  min≤max ordering, URL format, byte estimate. Written first (TDD).
- **Manual/Playwright verification:** serve locally, load online, run a (small,
  zoom-capped) download, confirm tiles cached; then set the browser **offline**,
  reload, and confirm the map shell, data layers, and Norway basemap all render
  with no network. Confirm graceful no-op when SW unsupported.

## Alternatives considered

1. **Commit a `tiles/` PNG folder to the repo.** Simplest conceptually, but
   ~150 MB / ~10k binary files in git is unwieldy and bloats every clone.
   Rejected. (Runtime caching gets the same offline result without the bloat.)
2. **PMTiles / vector tiles.** One file, range-served, elegant — but needs a
   vendored vector renderer (protomaps-leaflet/MapLibre) and a generate/extract
   step to produce the regional archive. Violates the no-build/no-dependency
   constraint and is heavier than the problem warrants. Rejected.
3. **Service-worker runtime caching only (no explicit download).** Lightest, but
   only caches tiles the user happens to have viewed — unreliable for "I drove to
   a no-signal valley I never panned over." We keep runtime caching *and* add the
   explicit region download so the field experience is dependable. Chosen
   (hybrid).

## Deployment note (for the README)

Service workers require HTTPS (or localhost). Field flow: host the static files
on any HTTPS static host (e.g. GitHub Pages), open in Safari **on wifi**, tap
**Share → Add to Home Screen**, open the installed app **while still online**
(this first launch is when the service worker installs/activates and precaches
the app shell), tap **Download offline map**, wait for completion — then it works
with no signal. Relative URLs make it work both at a domain root and under a
project subpath.
