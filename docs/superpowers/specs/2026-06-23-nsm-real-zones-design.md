# Real NSM sensor-ban zones — design

**Date:** 2026-06-23
**Status:** Approved (concept) — pending spec review

## Problem

The map carries only **6 hand-placed advisory dots** at major military bases
(the `sensitive` layer) plus a "go check NSM" link, because the prior
investigation concluded **no open feed** existed for the real NSM
(Nasjonal sikkerhetsmyndighet) sensor-ban zone geometry — see
`2026-06-23-nsm-sensitive-sites-design.md`. That conclusion was based on the
*wrong endpoints* (`nsm.geodataonline.no`, the `/sensorapplication/` viewer).

**That is now superseded.** NSM's current public map
(`registrering.sensor.nsm.cloudgis.no`, an ArcGIS JS 4.x app linked from
nsm.no) reads its zones from a **public, keyless ArcGIS Online FeatureServer**:

```
https://services9.arcgis.com/qCxEdsGu1A7NwfY1/ArcGIS/rest/services/Forbudsomr%C3%A5derNSM_v/FeatureServer/0
```

Verified 2026-06-23: layer "Forbudsområder", **polygon**, SR wkid 25833,
maxRecordCount 2000, **197 zones nationwide / 33 inside the region bbox**,
fields `navn` (name), `typeforbud` (ban type, e.g. *"Alle sensorer. (Inkludert
foto/video)."*), `refnr` (ref number, e.g. "0074"), `forbudsomrade`. Returns
clean WGS84 GeoJSON via `…/query?where=1=1&outFields=*&outSR=4326&f=geojson`,
HTTP 200, no auth. So we **can** draw the real polygons.

## Goal

Show the **actual NSM zone shapes** in the region and fold them into the
"Can I fly here?" check as a **permission-needed** restriction (you can register
to fly), while preserving the existing advisory dots and the project's
fail-safe and honesty principles.

## Decisions (settled with the user)

1. **Verdict = "Permission needed"**, not a hard no-fly. NSM zones ban airborne
   *sensors/photo* (not flight per se), and permission/registration is
   obtainable — so they behave like the existing airport/prison zones:
   `blocking: true, severity: "permission"`. Inside a zone is flagged in the
   verdict (never silently "clear"), as "permission needed", routed to the
   **NSM registration** process — **not** Ninox. (Ninox Drone is Avinor's app
   for *airport/airspace* clearance; NSM sensor-zone permission is registered
   with NSM itself, e.g. via the registration portal linked from nsm.no.)
2. **Keep the 6 advisory dots** (`sensitive` layer) unchanged, *in addition to*
   the new real zones. They carry friendly base labels and a second visual cue;
   they will be styled distinctly so the dots and zones don't read as the same
   thing.

## Scope

**In:**
- New pipeline step pulling the NSM FeatureServer, clipped to the region bbox,
  written to `data/nsm.geojson`.
- New blocking, permission-severity polygon layer `nsm` on the map + in the
  spot-check, with popups (name · ban type · ref nr · NSM link) and a
  legend/glossary entry.
- Fail-safe: build fails loudly if the feed can't be fetched; a missing runtime
  file makes the spot-check **warn**, never read "clear".
- Docs + in-app disclaimer updated to reflect that NSM's permanent published
  zones are now included.

**Out (explicitly):**
- Temporary NOTAM closures (still separate, still out of scope).
- The dots → zones *replacement* (user chose to keep both).
- National coverage beyond the region bbox (clip like every other layer).
- Re-styling / touching the existing `sensitive` dots beyond legend wording.

## Data (`config.json`, `nsm.mjs`, `build-data.mjs`)

- **`config.json` → `sources`**: add
  `"nsm_zones_arcgis": "https://services9.arcgis.com/qCxEdsGu1A7NwfY1/ArcGIS/rest/services/Forbudsomr%C3%A5derNSM_v/FeatureServer/0"`
  (å pre-encoded as `%C3%A5`). The existing `sensitive.nsm_url` stays the
  canonical human link surfaced in popups.
- **New pure module `nsm.mjs`** (repo root, mirroring `sensitive.mjs`/`season.mjs`):
  `nsmZoneFeatures(arcgisGeoJSON, { nsm_url })` → maps each input polygon Feature
  to an output Feature with `properties.layer = "nsm"`, `name` (from `navn`),
  `typeforbud`, `refnr`, `nsm_url`, and a shared `rule` string carrying the
  permission wording (see Map render). Pure, no I/O → unit-testable.
- **New `buildNsmZones()` in `scripts/build-data.mjs`** (mirrors
  `buildRestrictions`, which already queries an ArcGIS service): `fetchOk` the
  FeatureServer `/query` with
  `where=1=1 · geometry=<region bbox> · geometryType=esriGeometryEnvelope ·
  inSR=4326 · spatialRel=esriSpatialRelIntersects · outFields=navn,typeforbud,refnr ·
  outSR=4326 · returnGeometry=true · f=geojson`, pass through `requireFeatures`
  (fail-loud), feed `nsmZoneFeatures`, `save("nsm.geojson", …, "NSM sensor-ban
  zones")`. Region holds 33 zones (< maxRecordCount 2000) so no paging needed;
  guard anyway by asserting `exceededTransferLimit` is not set.

## Map render (`app.js`)

- Add `COLORS.nsm` — a distinct **purple/magenta** (e.g. `#b5179e`, tuned for
  contrast during implementation), separate from prison magenta `#d6447d` and
  the violet exercise fill, so a *sensor/photo* limit reads as its own kind.
  **Naming caution:** this new JS literal `COLORS.nsm` (purple, the real-zone
  layer) is *separate from* the pre-existing CSS var `--c-nsm` (`#7c8aa3`, grey)
  that styles the `sensitive` diamond dots — do not conflate them. Add a new CSS
  var `--c-nsm-zone` (the same purple) for the zone's legend/glossary chip;
  leave grey `--c-nsm` for the dots.
- New `LAYER_DEFS` entry (placed near `sensitive`):
  `{ id: "nsm", name: "NSM sensor/photo-ban zones", color: COLORS.nsm, on: true,
  file: "nsm", blocking: true, severity: "permission", stroke: "#6a0f5e", weight: 2 }`.
  Polygons render through the existing `buildLayer` path (same as
  `restrictions`/`nature`). On by default (safety).
- Add `"nsm"` to the `files` array loaded in `init()`. Because the def is
  `blocking: true`, `unloadedBlockingLayers(LAYER_DEFS, failedFiles)` already
  folds a missing `nsm.geojson` into the load warning — no extra wiring.
- Popup (shared `popupHtml`): title "NSM sensor/photo-ban zone: «navn»", body
  shows the ban type (`typeforbud`) and the shared `rule`:
  > **NSM sensor/photo-ban zone.** Airborne cameras/sensors are prohibited here
  > (incl. photo/video). Flying a camera/sensor drone needs **NSM permission —
  > register with NSM** before you fly. Zone defined by NSM; verify on
  > **[NSM's map ↗]**. `FOR-2018-06-22-951 §6`
- Add the popup-title case for `def.id === "nsm"` alongside the existing
  `sensitive` case.

## Spot-check integration (`app.js`)

- No new scan needed: as a `blocking` polygon layer, `nsm` is automatically
  included in both the `featureContains` hit test (→ verdict) and the nearest-
  blocking-boundary distance/bearing readout in `analyzePoint`.
- Inside an NSM zone → the existing `severity: "permission"` path produces the
  amber "permission needed" verdict, showing the zone name + `rule`. The
  existing 6-dot "nearest sensitive site" advisory is untouched and still fires
  within `notify_km`; the two reinforce near a base and must not contradict
  (zone wording = "register with NSM", dot wording = "check NSM map" — aligned).

## Offline (`sw.js`)

- Add `data/nsm.geojson` to the precached data-file list (network-first, like
  the other `data/*.geojson`).
- Bump `SHELL_CACHE` (v16 → v17) so the new shell + data propagate to installed
  PWAs. Tile cache untouched (no ~150 MB re-download).

## Docs

- **`README.md`**: add a layer-table row for "NSM sensor/photo-ban zones"
  (source: NSM public ArcGIS feed; authority: official NSM data). Reword the
  two now-contradicted spots that the whole feature supersedes: the top-of-file
  ⚠️ warning at **lines 9–12** ("does not include … NSM photo/sensor-ban zones …
  NSM publishes those only in its own viewer") and the existing dots row at
  **line 30** ("**Not** NSM's sensor-ban zones (no open feed)"). New wording:
  NSM's *permanent published* zones are now included (from NSM's public read-only
  feed), but still verify on NSM and check **NOTAMs** (temporary closures remain
  excluded). The line-30 dots row stays (we keep the dots) but drops the
  "no open feed" claim.
- **`index.html`**: the glossary already has the zone-vs-marker split — update
  the **existing** "Photo / sensor-ban zone (NSM)" `<li>` at **line 178**: its
  chip switches from grey `--c-nsm` to the purple `--c-nsm-zone`, and its body
  drops the now-false "**These zones aren't drawn on this map**" sentence in
  favour of "drawn here as purple zones — inside one, register with NSM before
  flying". The diamond-marker `<li>` at **line 179** (the 6 dots) is unchanged.
  Add a matching legend chip for the zone layer.

## Tests

- **`scripts/nsm.test.mjs`** (node --test, deterministic — tests the pure
  `nsmZoneFeatures` transform against a small fixture, no network): emits valid
  GeoJSON polygons; every feature carries `layer:"nsm"`, `name`, `typeforbud`,
  `refnr`, `nsm_url`, and a `rule` that names NSM registration; input attrs map
  correctly; empty input → empty output. Add the file to the CI list in
  `.github/workflows/test.yml`.

## Fail-safe (carry the commit-1f90840 principle)

- Build: `requireFeatures` throws on an empty/garbled fetch → the pipeline
  errors and **no bad/empty `nsm.geojson` is written**, so the manual refresh
  run goes red instead of silently shipping an empty zone layer.
- Runtime: a missing/garbled `data/nsm.geojson` falls back to empty *and* is
  reported by `unloadedBlockingLayers` → the spot-check warns "may miss real
  restrictions", never "clear". This matters because the feed is a public
  service that NSM could lock or move.

## Related work (same branch, already designed)

- `.github/workflows/refresh-data.yml` — the manual `workflow_dispatch` "refresh
  now" button (lands on `main`). Once NSM is a pipeline source, one tap
  re-pulls it with everything else. Requires repo Actions "Read and write
  permissions". Tracked separately; not part of this spec's test surface.

## Files touched

`config.json`, `nsm.mjs` (new), `scripts/build-data.mjs`,
`scripts/nsm.test.mjs` (new), `data/nsm.geojson` (generated), `app.js`,
`index.html`, `sw.js`, `.github/workflows/test.yml`, `README.md`.
