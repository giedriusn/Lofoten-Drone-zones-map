# Protected-Area Flight Restriction Zones — Design

**Date:** 2026-06-23
**Status:** Design (approved by user in brainstorming; to be double-checked by spec + code review)

## Problem

The map shows protected-area *boundaries* (`vern`) and flags seabird reserves with a
**reserve-level advisory** nesting window (assumed 15 Apr–31 Jul). But Naturbase has a
separate, authoritative dataset we don't use — `vern_restriksjonsomrader`
("Restriksjoner for aktivitet i verneområder") — which holds the *exact restriction
zones inside protected areas*, with the real per-zone rules and dates. It contains
layers that are directly drone-relevant and currently absent from the map:

- **ferdselsforbud** (access ban) — the precise seasonal access-ban zones (e.g.
  Bliksvær `Ferdselsforbud (15.4-31.7)`), superseding our assumed window.
- **lavflyving_forbudt_under_300m** (low flying banned below 300 m) — a *direct*
  drone-altitude ban; the data text even says **"Gjelder også bruk av modellfly"**
  (also applies to model aircraft / drones).
- **landingsforbud** (landing/take-off banned).

Regional counts (region bbox `[11.0,66.7,18.5,69.6]`): ferdselsforbud **53**,
lavflyving<300m **101**, landingsforbud **197**.

## Goal

Add these civilian restriction zones to the map as a single, date-aware no-fly layer
with exact rules and dates, so the map shows the authoritative bans (not just reserve
boundaries + an assumed window). Keep all existing project constraints: **no build
step, no npm dependencies, vanilla JS, keyless data sources, static files.**

## Decisions (made with the user during brainstorming)

1. **One combined layer** — all three restriction types in a single toggle
   ("Protected-area flight bans"), each zone's popup stating its own exact rule(s) + dates.
2. **Civilian only** — skip the `_forsvaret` (military) layers. Verified from the live
   data: those zones read "Landingsforbud Forsvaret" / "Lavflyving forbudt Forsvaret"
   — restrictions on *military* aircraft, not civilian drones, so they impose no
   obligation on a sub-250 g recreational pilot. The civilian low-flying layer is the
   one that explicitly covers drones ("modellfly").
3. **Date-aware** like the seabird layer — active-today zones emphasized; the spot-check
   counts them as no-fly.

## Data source

Miljødirektoratet ArcGIS: `https://kart.miljodirektoratet.no/arcgis/rest/services/vern_restriksjonsomrader/MapServer/{0,1,2}/query`
(same keyless pattern as the existing `vern` nature source).

Civilian layers: `0` = ferdselsforbud, `1` = lavflyving_forbudt_under_300m,
`2` = landingsforbud. Fields used: `vernRestriksjonId`, `naturvernId`, `navn`,
`verneform`, `restriksjoner`, `restriksjonerBeskrivelse`, `faktaark`.

A single physical zone (one `vernRestriksjonId`) can carry several restriction types;
`restriksjonerBeskrivelse` lists **all** of them for that zone (e.g. Eggøya:
`Ferdselsforbud (1.3-31.7), Lavflyving forbudt (< 300 m) (1.1-31.12): Gjelder også
bruk av modellfly.`), so the same zone appears across layers 0/1/2 with the same id.

## Scope

**In scope**
- New pipeline step → `data/restrictions.geojson` (civilian restriction zones, deduped).
- A pure, tested `parseRestrictionWindows(text)` helper that extracts date ranges
  from the Norwegian text into `{from,to}` `"MM-DD"` windows (build-time).
- One new toggleable, date-aware **"Protected-area flight bans"** map layer (red,
  no-fly, blocking, on by default), integrated into the spot-check verdict.
- Legend/glossary entry + CSS.
- Service-worker precache + README row (consistency with existing layers).

**Out of scope (documented, not built)**
- Military `_forsvaret` layers (see decision 2).
- Any other Naturbase dataset (naturtyper, friluftsliv, kulturlandskap, ramsar,
  villrein, etc. — none are drone restrictions).
- Re-wiring the existing seabird layer's advisory window to consume these exact dates
  (kept as a possible later refinement; the two layers coexist — seabird shows *which
  reserves are bird reserves*, this layer shows the *exact ban zones + dates*).

## Design

### 1. Date parser — `season.mjs` (extend) + `scripts/season.test.mjs`

Add a pure helper next to `nestingActive`:

```js
// Parse Norwegian restriction date ranges like "15.4-31.7" or "1.1-31.12" out of the
// official restriksjonerBeskrivelse text into {from,to} "MM-DD" windows. A zone may
// list several ranges (one per restriction); we return all of them. "1.1-31.12" is a
// year-round ban → {from:"01-01", to:"12-31"} (always active via nestingActive).
export function parseRestrictionWindows(text) { /* regex /(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{1,2})/g, zero-pad to MM-DD */ }
```

- Tested: `"15.4-31.7"` → `[{from:"04-15",to:"07-31"}]`; `"1.1-31.12"` → year-round;
  multi-range text → multiple windows; no dates → `[]`.
- Reuses the existing `nestingActive(from,to,today)` at view time for "active now".

### 2. Pipeline step — `scripts/build-data.mjs` (`buildRestrictions`)

- Add a `restrictions_arcgis` source base in `config.json`.
- Query civilian layers 0,1,2 with the region envelope (same paging/bbox approach as
  `buildNature`).
- **Dedup by `vernRestriksjonId`** across the three layers; when a duplicate appears,
  keep the record with the longest `restriksjonerBeskrivelse` (most complete).
- Per zone emit a feature with:
  - `layer: "restriction"`, `name`, `verneform`, `naturvernId`, `faktaark`,
  - `restrictions` (the raw `restriksjonerBeskrivelse` — shown verbatim in the popup),
  - `windows` = `parseRestrictionWindows(restrictions)` (array of `{from,to}`),
  - `year_round` = true if any window is `01-01`→`12-31`,
  - `drones_explicit` = `/modellfly/i.test(restrictions)` (for a "also applies to drones" note),
  - `rule` = a plain-language summary built from the restriction text.
- Write `data/restrictions.geojson`. Add the step to the pipeline runner.

### 3. Map layer — `app.js`

- `COLORS.restriction` in the red no-fly family, distinguished from seabird/nature by
  a distinct solid dark-red edge (these are precise ban geometries).
- New `LAYER_DEFS` entry:
  `{ id: "restriction", name: "Protected-area flight bans", color: COLORS.restriction,
     on: true, file: "restrictions", blocking: true, severity: "nofly", stroke: "#7a0010", weight: 2 }`
  (placed after the seabird entry). It is `blocking` so the spot-check treats it as no-fly.
- **Date-aware** (reuse the seabird approach): a zone is "active now" if any of its
  `windows` is active today (or `year_round`). `styleFor` gives active zones a bolder/
  more-opaque fill; dormant ones lighter (rare — most carry a year-round low-fly/landing ban).
- Popup (`popupHtml`) and verdict (`renderHit`) show the exact `restrictions` text, an
  active/dormant line, the "🛩️ also applies to drones" note when `drones_explicit`, and
  the Factsheet link. Reuse/extend the existing `nestingStatusHtml` pattern (generalize
  it to a small shared status helper, or add a sibling `restrictionStatusHtml`).
- These are polygons → handled by the existing `buildLayer` polygon branch (no marker).

### 4. Legend, glossary & CSS — `index.html`, `style.css`

- `--c-restriction` CSS var; reuse `.nesting*` status styles (or add equivalents).
- Glossary `<li>`: "Protected-area flight ban — No-fly", explaining access/low-flying/
  landing bans inside reserves, that the low-flying ban includes drones, and that dates
  vary per zone (shown in the popup).

### 5. Service worker, config & README

- `sw.js`: add `./data/restrictions.geojson` to `SHELL_ASSETS`; bump `SHELL_CACHE`.
- `app.js` `init`: add `"restrictions"` to the data `files` array.
- `config.json`: add the `restrictions_arcgis` source URL.
- `README.md`: add a "Protected-area flight bans" layer row.

### 6. Rebuild & verify

- Run `node scripts/build-data.mjs`; expect a Restrictions step writing
  `data/restrictions.geojson` (~hundreds of zones after dedup).
- Verify: Bliksvær access ban parsed to `04-15`→`07-31`; low-flying zones flagged
  `drones_explicit`; layer toggles; spot-check on a zone returns no-fly; tests pass.

## Files touched

- `season.mjs`, `scripts/season.test.mjs` — date parser + tests.
- `scripts/build-data.mjs`, `config.json` — new pipeline step + source.
- `app.js` — colour, layer def, date-aware style/popup/verdict, files array.
- `index.html`, `style.css` — glossary + legend + CSS.
- `sw.js` — precache + cache bump.
- `README.md` — layer row.
- `data/restrictions.geojson` — new build artifact.

## Risks / honesty notes

- **Date parsing depends on free text.** The official `restriksjonerBeskrivelse` is
  fairly consistent (`d.m-d.m`), but the popup always shows the **raw text verbatim**
  as the source of truth, so a parse miss degrades only the "active now" emphasis, never
  the displayed rule. Zones with no parseable date are treated as always-blocking (the
  safe direction) and labelled "dates — see text".
- **Overlap with seabird/nature layers** is intentional and additive (boundaries vs
  exact ban zones); no layer is removed.
- **Coexistence:** must not disturb the existing nature, seabird, prison, or data-age code.
