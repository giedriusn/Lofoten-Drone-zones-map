# NSM sensitive-site advisory markers — design

**Date:** 2026-06-23
**Status:** Approved (concept) — pending spec review

## Problem

NSM (Nasjonal sikkerhetsmyndighet) photo/sensor-ban zones — where flying a
camera/sensor drone is restricted under security law (`FOR-2018-06-22-951 §6`)
— are the most legally serious gap on the map and concentrate around military
installations in exactly the region the user flies (Bodø, Andøya, Evenes,
Bardufoss, Ramsund, Sortland).

There is **no open, republishable feed** for the actual zone geometry
(re-verified 2026-06-23: `nsm.geodataonline.no` ArcGIS root refuses connections;
the `/sensorapplication/` viewer refuses non-browser clients; Geonorge has no
open NSM sensor-zone dataset). So we cannot — and should not — draw the real
polygons. Today the map only carries an advisory link button + glossary entry.

## Goal

Give the pilot a **location-aware nudge**: show *where the well-known sensitive
installations are*, and prompt them to check NSM's authoritative map, **without
implying a boundary we don't have.**

## Scope

**In:**
- A curated, hand-verified list of 6 installations rendered as advisory **point
  markers** (no radius, no polygon).
- A non-blocking "nearest sensitive site" line in the "Can I fly here?"
  spot-check, with a one-tap NSM link.
- Legend + glossary entry; works offline.

**Out (explicitly):**
- Real NSM zone polygons (no feed; legally unsafe to approximate).
- Any "no-fly" verdict from these markers (we don't know the boundary).
- NOTAMs (separate, already out of scope).

## Honesty constraints (the core of this feature)

Every surface (popup, glossary, spot-check) must convey:
- These are **prominent** sites where NSM bans are **likely** nearby — not the
  zones themselves.
- NSM's actual zones are defined by NSM, **may sit elsewhere, and may exist at
  places not marked here.**
- The call to action is always **"→ check NSM's map,"** never "no-fly here."

## Data

- New curated list in `config.json`:
  ```json
  "sensitive_sites": [
    { "name": "Bodø air station",        "lat": 67.269, "lon": 14.365 },
    { "name": "Reitan (NJHQ)",           "lat": 67.300, "lon": 14.850 },
    { "name": "Andøya air station",      "lat": 69.293, "lon": 16.144 },
    { "name": "Evenes air station",      "lat": 68.491, "lon": 16.678 },
    { "name": "Bardufoss air station",   "lat": 69.056, "lon": 18.540 },
    { "name": "Ramsund naval station",   "lat": 68.490, "lon": 16.530 },
    { "name": "Sortland (Coast Guard)",  "lat": 68.700, "lon": 15.420 }
  ]
  ```
  (Coordinates above are approximate — each is **hand-verified during
  implementation** before commit. "Bodø" is two points: the air station and the
  NJHQ bunker at Reitan ~15 km E. Final list = the 6 named sites; Reitan is a
  second point under the Bodø umbrella.)
- New build step `buildSensitive()` in `scripts/build-data.mjs`: reads the
  config list (no network — fully offline/deterministic, unlike the OSM/ArcGIS
  builds) and writes `data/sensitive.geojson` as Point features with
  `properties.layer = "sensitive"`, `name`, and a shared `rule` string carrying
  the honesty wording above.

## Map render (`app.js`)

- New entry in the `LAYERS` array: `{ id: "sensitive", name: "Military /
  sensitive sites", color: COLORS.sensitive, on: true, file: "sensitive",
  blocking: false, severity: "permission" }`. On by default (safety), but
  toggleable.
- `COLORS.sensitive` = the existing NSM colour (`--c-nsm`, already in
  `style.css`).
- Rendered as a `circleMarker` (matching prisons/airports dot style) **with no
  ring** — the absence of a radius is deliberate: a circle would read as a
  boundary. Popup via the shared `popupHtml`, text:
  > **Military / sensitive site.** Photo & sensor bans may apply nearby
  > (airborne cameras included). The actual zones aren't drawn here and may sit
  > elsewhere — **check [NSM's map ↗]**. Near a military area, flying itself may
  > need the local commander's OK. `FOR-2018-06-22-951 §6`
- Legend chip + glossary `<li>` mirroring the existing NSM glossary entry, badge
  "Need permission".

## Spot-check integration (`app.js`)

- The "Can I fly here?" result already computes nearest blocking restriction.
  Add a **separate, non-blocking** readout: the nearest `sensitive` site by
  straight-line distance + bearing (reusing `bearingTo`/`fmtDist`), rendered as
  an advisory line — **independent of the OK/no-fly verdict**:
  > ⚠️ Nearest military/sensitive site: **Evenes 3.2 km NE** → check NSM map ↗
- Shown always (not only when clear), because a sensor-ban can apply even inside
  an otherwise-OK spot. Never alters the OK/permission/no-fly verdict.

## Offline (`sw.js`)

- Add `data/sensitive.geojson` to the precached data-file list (network-first,
  same as the other `data/*.geojson`).
- Bump `SHELL_CACHE` version (v13 → v14) so the new shell/data propagates.

## Tests

- `scripts/sensitive.test.mjs` (node --test): the build emits valid GeoJSON, one
  Point per config entry, all coords inside the region bbox + capture margin,
  every feature carries name + rule. Deterministic (no network), so it runs in
  CI alongside the existing tests.

## Files touched

`config.json`, `scripts/build-data.mjs`, `data/sensitive.geojson` (generated),
`app.js`, `style.css` (legend chip if needed; `--c-nsm` already exists),
`index.html` (glossary/legend), `sw.js`, `scripts/sensitive.test.mjs`, `README.md`
(layer table row).
