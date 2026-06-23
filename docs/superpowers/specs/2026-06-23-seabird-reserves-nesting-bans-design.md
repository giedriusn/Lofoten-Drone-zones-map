# Seabird Reserves & Nesting Bans — Design

**Date:** 2026-06-23
**Status:** Design (approved by user in brainstorming; to be double-checked by spec + code review)

## Problem

The map already has a **"Nature reserves & parks"** layer (208 protected areas:
national parks, nature reserves, landscape areas), drawn red as no-fly, with a
wildlife disclaimer and a `naturmangfoldloven §15` note. Review feedback was that
**nesting bans aren't really covered** — and that's correct:

- The seasonal nesting-ban flag is derived from a narrow heuristic (the
  `verneform` or `name` contains "fugl"), so only **20 of 208** areas are flagged.
- It **misses almost every real seabird reserve**, including:
  - **Bliksvær** — the exact reserve our own law notes cite for the seasonal
    access ban (`FOR-2002-12-06-1426 §3`).
  - **Bleiksøya** — the famous puffin colony.
  - **Karlsøyvær, Engelvær, Støttvær, Anda, Laukvikøyene…** — all genuine
    seabird reserves with nesting-season access bans, none flagged.
- Because most Norwegian seabird reserves are classified plainly as
  `verneform = "Naturreservat"`, name/verneform matching can't reliably find them.

A drone pilot reading the map today (2026-06-23 — *inside* nesting season) would
not see that these reserves are under an active access ban.

## Goal

Make seabird reserves and their seasonal nesting bans a **first-class, accurate,
date-aware** part of the map, using an authoritative signal instead of a name guess.

Keep all existing project constraints: **no build step, no npm dependencies,
vanilla JS, keyless data sources, static files.** Permanent/seasonal zones only —
no NOTAMs (existing scope choice stands).

## Key data finding

The Miljødirektoratet `vern` dataset (already our nature source) exposes a field
we don't currently request: **`verneplan`**. The value **`"VerneplanSjoefugl"`**
(the national *seabird conservation plan*) reliably identifies **~45 seabird
reserves** in the region — Bliksvær and Bleiksøya included — versus the 20 the
name heuristic catches today. This is the authoritative, machine-readable signal
for "this reserve exists to protect (sea)birds and carries a nesting access ban."

The dataset does **not** expose per-reserve ferdselsforbud dates (those live only
in each reserve's verneforskrift text on Lovdata), so exact dates stay advisory.

## Decisions (made with the user during brainstorming)

1. **Scope:** full treatment — authoritative detection **+** date-aware
   "active now / dormant" status **+** a separate, toggleable, styled layer with
   its own legend entry.
2. **Nesting window:** use the typical **15 Apr – 31 Jul** window for the
   "active now" logic, always shown with an "exact dates vary — check the
   verneforskrift" caveat.
3. **Visual style:** keep the no-fly **red** family (preserve the map's
   "red = no-fly" language); distinguish seabird reserves with a **dark dashed
   outline + a 🐦 marker**, and **date-aware emphasis** (bold/saturated fill when
   the ban is active now, faint when dormant).

## Scope

**In scope**
- Authoritative seabird detection in the data pipeline via `verneplan`.
- New `seabird` boolean + advisory window fields on nature features.
- A new toggleable **"Seabird reserves (nesting ban)"** map layer, split out of
  the existing nature layer so each polygon lives in exactly one toggle.
- Client-side date-aware status (active now vs dormant) reflected in: map
  styling, feature popups, the "Can I fly here?" verdict, and a season banner.
- Legend/glossary entry, supporting CSS, and tightened wildlife copy.
- Regenerated `data/nature.geojson`.

**Out of scope (documented, not built)**
- Parsing exact ferdselsforbud dates from Lovdata verneforskrift text (window
  stays advisory; popups link the regulation for the exact dates).
- Any new data source or external dependency.
- Changes to the other layers (airspace, airports, populated, helipads).
- NOTAM / dynamic-activation scope (unchanged project decision).

## Design

### 1. Data pipeline — `scripts/build-data.mjs` (`buildNature`)

- Add `verneplan` to the ArcGIS `outFields`.
- Compute `const seabird = p.verneplan === "VerneplanSjoefugl";`.
- `seasonal = seabird || /dyreliv|dyrefredning|fugl/.test(vf) || /fugl/i.test(name)`
  — `verneplan` becomes the primary signal; the old tokens stay as a fallback so
  non-seabird wildlife areas (e.g. `Dyrelivsfredning`) keep their seasonal flag.
- Emit new feature properties:
  - `seabird` (boolean)
  - `nesting_from: "04-15"`, `nesting_to: "07-31"` (month-day strings; only on
    seabird features). Storing the **window**, not a computed "active" flag — the
    data file is static and pre-built, so "active now" must be evaluated live in
    the browser, never baked in.
- Rewrite `natureRule(cat, seasonal)` → add a seabird branch whose text states:
  the year-round reserve ban, the **seasonal access ban (ferdselsforbud) ~15 Apr–
  31 Jul during nesting**, that **exact dates vary — check the verneforskrift**,
  and that take-off/landing/flying-in are all covered with no altitude exemption.
  The seabird branch must **fully own its text** — it returns its complete rule
  and does not also append the generic `seasonal` clause, so the ferdselsforbud
  sentence is never duplicated.

### 2. New map layer — `app.js`

- Add a `LAYER_DEFS` entry:
  `{ id: "seabird", name: "Seabird reserves (nesting ban)", color: COLORS.seabird,
     on: true, file: "nature", match: p => p.seabird, blocking: true,
     severity: "nofly", dashed: true }`
- Change the existing nature def to `match: p => !p.seabird` so seabird reserves
  appear only in the new layer (no double-draw, accurate per-layer counts).
- Add `COLORS.seabird` in the red no-fly family (e.g. `#ff2238`, distinguished by
  the dashed edge + marker rather than hue).
- The layer toggle UI is generated from `LAYER_DEFS`, so the new toggle, swatch,
  and count appear automatically.

### 3. Date-aware status — `app.js`

- New pure helper `nestingActive(from, to, today)`:
  - `from`/`to` are `"MM-DD"` strings; compares by month-day so it is
    year-independent and correct across the build/runtime boundary.
  - Window does not wrap the year here (Apr→Jul), but the compare is written
    wrap-safe so an over-winter window would still work.
  - `today` defaults to the browser's current date (`new Date()` — valid in the
    browser; the workflow/data layer never computes this).
- Used in:
  - **Map styling** (`styleFor`): for seabird features, active → bolder weight +
    higher `fillOpacity`; dormant → lighter. Keeps the dashed red identity in
    both states.
  - **Popup** (`popupHtml`): inject a status line —
    `🐦 Nesting ban ACTIVE now — until 31 Jul` (emphasised) vs
    `🐦 Nesting ban — dormant now (applies 15 Apr–31 Jul)` (muted).
  - **Verdict** (`renderHit` / `renderResult`): a point inside a seabird reserve
    shows the same active/dormant line within its hit block.
  - **Season banner:** a dedicated, initially-hidden element in the control panel
    body (placed beside the existing wildlife disclaimer, e.g. `id="seasonBanner"`)
    shown **only while the window is active**:
    `🐦 Nesting season — seabird reserves are closed (ferdselsforbud) until 31 Jul.`
    Toggled at init from `nestingActive`; stays hidden out of season. (Panel-body
    placement, not a map overlay, so it never covers the map or zones.)

### 4. Legend, glossary & copy — `index.html`, `style.css`

- New glossary `<li>`: **"Seabird reserve"**, `No-fly` badge, plain-language note
  that the seasonal nesting access ban (15 Apr–31 Jul) is *on top of* the
  year-round reserve ban, citing Bliksvær `FOR-2002-12-06-1426 §3`.
- `style.css`: add `--c-seabird` and any small class needed for the dashed legend
  chip and the "active now" emphasis (e.g. a `.badge--season`).
- Keep the existing wildlife disclaimer and the §15 verdict note; tighten wording
  so they read consistently with the new live banner (no contradictions).

### 5. Rebuild & verify

- Run `node scripts/build-data.mjs` to regenerate `data/nature.geojson`.
- Verify in the browser:
  - Bliksvær and Bleiksøya are now in the Seabird layer and flagged.
  - ~45 seabird features; nature layer count drops by the same amount.
  - Season banner shows (today is in-season); popup/verdict say "ACTIVE now".
  - Toggling the new layer works; legend entry present.

## Files touched

- `scripts/build-data.mjs` — `verneplan` field, `seabird` detection, window
  fields, seabird rule text.
- `app.js` — new layer def + nature split, `COLORS.seabird`, `nestingActive`,
  styling/popup/verdict/banner integration.
- `index.html` — glossary entry, season-banner container, copy tweaks.
- `style.css` — `--c-seabird`, dashed chip, season emphasis.
- `data/nature.geojson` — regenerated (build artifact).

## Risks / honesty notes

- **Advisory dates:** the 15 Apr–31 Jul window is the common case, not exact per
  reserve. Mitigated by always captioning it as advisory and linking the
  verneforskrift for the authoritative dates.
- **`verneplan` coverage:** a seabird reserve created outside the formal
  "Verneplan for sjøfugl" could be missed; the retained name/`dyreliv` fallback
  and the global wildlife banner backstop this, and §15 applies everywhere
  regardless.
- **Data freshness:** detection improves only after `build-data.mjs` is re-run;
  the regenerated `data/nature.geojson` is committed so the deployed map reflects
  it.
