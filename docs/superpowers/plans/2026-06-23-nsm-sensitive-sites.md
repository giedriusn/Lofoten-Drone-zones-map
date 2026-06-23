# NSM Sensitive-Site Advisory Markers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 6 advisory point markers at well-known military/sensitive installations, plus a non-blocking "nearest sensitive site → check NSM" line in the spot-check — drawing **no** zone geometry and never producing a no-fly verdict.

**Architecture:** A curated list in `config.sensitive` feeds a pure `sensitiveFeatures()` module (mirroring `season.mjs`), which `build-data.mjs` writes to `data/sensitive.geojson`. `app.js` adds a non-blocking `LAYER_DEFS` entry rendered as diamond markers and a separate distance scan that surfaces the nearest site when within `notify_km`. Every surface ends in "check NSM's map," never "no-fly."

**Tech Stack:** Vanilla ES modules, Leaflet (vendored), Node 20 built-in test runner, zero-dependency build pipeline. No build step.

**Spec:** `docs/superpowers/specs/2026-06-23-nsm-sensitive-sites-design.md`

**Branch:** `feat/nsm-sensitive-sites` (already on it, rebased onto clean `main` `f7ac327`).

---

## File Structure

- **Create** `sensitive.mjs` (repo root) — pure `sensitiveFeatures(sites, {nsm_url})`; no I/O, no Leaflet. One responsibility: curated config → GeoJSON Point Features. Mirrors `season.mjs`/`geometry.mjs`.
- **Create** `scripts/sensitive.test.mjs` — node --test for the pure module.
- **Create** `data/sensitive.geojson` (generated, committed) — 6 Point features.
- **Modify** `config.json` — add the `sensitive` object (nsm_url, notify_km, sites).
- **Modify** `scripts/build-data.mjs` — import `sensitiveFeatures`, add `buildSensitive()` + a pipeline step.
- **Modify** `.github/workflows/test.yml` — add the new test file to the explicit list.
- **Modify** `app.js` — `COLORS.sensitive`, a `LAYER_DEFS` entry, `files` array, an `addSensitive()` renderer, `typeLabel`, the popup NSM link, and the spot-check nearest-site scan/readout.
- **Modify** `style.css` — `.sensitive-icon` diamond + `.nearest--sensitive` advisory line.
- **Modify** `index.html` — one glossary entry + a one-line note in rules §③.
- **Modify** `sw.js` — precache `data/sensitive.geojson`; bump `SHELL_CACHE` v14→v15.
- **Modify** `README.md` — one layer-table row.

**Honesty invariants (must hold in every task):** no polygon/circle/ring is ever drawn for these features; the `sensitive` layer stays `blocking: false`; it never enters the verdict severity; every popup/spot-check string contains an NSM link and never the words "no-fly".

---

### Task 1: Curated config

**Files:**
- Modify: `config.json` (add a `sensitive` block after the `prisons` block, before `sources`)

- [ ] **Step 1: Add the config block**

Insert after the `prisons` object (keep the trailing comma structure valid):

```json
  "sensitive": {
    "_comment": "Curated, hand-verified military/sensitive installations shown as advisory dots — NOT NSM zones (no open feed for those). Every surface points to NSM's own map. notify_km = how close the spot-check must be before it nudges you to check NSM.",
    "nsm_url": "https://nsm.no/tjenester/kart-over-forbudsomrader-for-luftbarne-sensorsystemer/",
    "notify_km": 20,
    "sites": [
      { "name": "Bodø air station",       "lat": 67.2692, "lon": 14.3653 },
      { "name": "Andøya air station",     "lat": 69.2925, "lon": 16.1441 },
      { "name": "Evenes air station",     "lat": 68.4913, "lon": 16.6782 },
      { "name": "Bardufoss air station",  "lat": 69.0558, "lon": 18.5403 },
      { "name": "Ramsund naval station",  "lat": 68.4866, "lon": 16.5320 },
      { "name": "Sortland (Coast Guard)", "lat": 68.6986, "lon": 15.4136 }
    ]
  },
```

Coordinates are best-known values; verify each against an authoritative source (e.g. the installation's official page / Kartverket) before Task 8. All must satisfy `W - margin ≤ lon ≤ E + margin` and `S - margin ≤ lat ≤ N + margin` where bbox is `[11.0, 66.7, 18.5, 69.6]` and margin = `0.15` (Bardufoss at lon 18.54 relies on this margin, same as its airport entry).

- [ ] **Step 2: Verify JSON parses**

Run: `node -e "const c=require('./config.json'); console.log(c.sensitive.sites.length, c.sensitive.notify_km)"`
Expected: `6 20`

- [ ] **Step 3: Commit**

```bash
git add config.json
git commit -m "NSM sites: add curated sensitive-installation config"
```

---

### Task 2: Pure `sensitiveFeatures` module (TDD)

**Files:**
- Test: `scripts/sensitive.test.mjs`
- Create: `sensitive.mjs`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Write the failing test**

`scripts/sensitive.test.mjs`:

```js
// scripts/sensitive.test.mjs
// Pins the curated-config → GeoJSON transform for the NSM advisory markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sensitiveFeatures } from "../sensitive.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8"));
const NSM = "https://nsm.example/map";

test("one Point feature per configured site", () => {
  const sites = [{ name: "A", lat: 68, lon: 15 }, { name: "B", lat: 69, lon: 16 }];
  const fs = sensitiveFeatures(sites, { nsm_url: NSM });
  assert.equal(fs.length, 2);
  for (const f of fs) {
    assert.equal(f.type, "Feature");
    assert.equal(f.geometry.type, "Point");
    assert.equal(f.geometry.coordinates.length, 2);
    assert.equal(f.properties.layer, "sensitive");
  }
});

test("coordinates are [lon, lat] order", () => {
  const [f] = sensitiveFeatures([{ name: "A", lat: 68, lon: 15 }], { nsm_url: NSM });
  assert.deepEqual(f.geometry.coordinates, [15, 68]);
});

test("each feature carries name, nsm_url, and an honest rule", () => {
  const [f] = sensitiveFeatures([{ name: "Bodø", lat: 67, lon: 14 }], { nsm_url: NSM });
  assert.equal(f.properties.name, "Bodø");
  assert.equal(f.properties.nsm_url, NSM);
  assert.match(f.properties.rule, /NSM/);
  // Honesty guard: must point to NSM, must NOT assert a no-fly here.
  assert.doesNotMatch(f.properties.rule, /no-fly/i);
});

test("the real config produces 6 sites, all inside bbox + 0.15° margin", () => {
  const [W, S, E, N] = config.region.bbox;
  const m = 0.15;
  const fs = sensitiveFeatures(config.sensitive.sites, { nsm_url: config.sensitive.nsm_url });
  assert.equal(fs.length, 6);
  for (const f of fs) {
    const [lon, lat] = f.geometry.coordinates;
    assert.ok(lon >= W - m && lon <= E + m, `${f.properties.name} lon ${lon} out of range`);
    assert.ok(lat >= S - m && lat <= N + m, `${f.properties.name} lat ${lat} out of range`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/sensitive.test.mjs`
Expected: FAIL — `Cannot find module '../sensitive.mjs'`.

- [ ] **Step 3: Implement `sensitive.mjs`**

```js
// sensitive.mjs — pure curated-config → GeoJSON for the NSM advisory markers.
// No DOM, no Leaflet, no I/O: imported by scripts/build-data.mjs (Node) and
// scripts/sensitive.test.mjs. These are well-known military/sensitive sites shown
// as advisory DOTS — not NSM's actual sensor-ban zones (no open feed exists for
// those geometries), so every feature points the pilot to NSM's own map.

const RULE = (nsm) =>
  "Military / sensitive installation. Photo & sensor bans (incl. airborne cameras) " +
  "may apply in NSM zones near here. The real NSM zones aren't drawn on this map, " +
  "may sit elsewhere, and may exist at sites not marked here — always check NSM's " +
  "map. Near a military area, flying itself may need the local commander's OK. " +
  "(BSL A 7-2 §7 · FOR-2018-06-22-951 §6)";

export function sensitiveFeatures(sites = [], { nsm_url = "" } = {}) {
  return sites.map((s) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    properties: {
      layer: "sensitive",
      name: s.name,
      nsm_url,
      rule: RULE(nsm_url),
    },
  }));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test scripts/sensitive.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the test in CI**

In `.github/workflows/test.yml`, append `scripts/sensitive.test.mjs` to the explicit `node --test` file list on the `- run:` line (it currently ends with `scripts/season.test.mjs`).

- [ ] **Step 6: Run the whole suite**

Run: `node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs scripts/season.test.mjs scripts/sensitive.test.mjs`
Expected: all PASS. (`offline-assets` still passes — we haven't added the data file to `sw.js` yet.)

- [ ] **Step 7: Commit**

```bash
git add sensitive.mjs scripts/sensitive.test.mjs .github/workflows/test.yml
git commit -m "NSM sites: pure sensitiveFeatures() module + tests + CI"
```

---

### Task 3: Build-pipeline step + generated data file

**Files:**
- Modify: `scripts/build-data.mjs`
- Create: `data/sensitive.geojson`

- [ ] **Step 1: Import the module**

At the top of `scripts/build-data.mjs`, alongside the existing `import { parseRestrictionWindows } from "../season.mjs";`, add:

```js
import { sensitiveFeatures } from "../sensitive.mjs";
```

- [ ] **Step 2: Add the build function**

After `buildRestrictions()` (before the `// ---------- run ----------` section), add:

```js
// ---------- 8. Military / sensitive sites (NSM advisory) ----------
// Curated, hand-verified installations rendered as advisory DOTS — NOT NSM's
// actual sensor-ban zones (no open/authorized feed exists for those geometries).
// Fully offline/deterministic: just transforms config.sensitive into GeoJSON.
async function buildSensitive() {
  const s = config.sensitive || {};
  const feats = sensitiveFeatures(s.sites || [], { nsm_url: s.nsm_url || "" });
  await save("sensitive.geojson", feats, "Military / sensitive sites");
}
```

- [ ] **Step 3: Register it in the pipeline**

Add to the `steps` array (after `["Restrictions", buildRestrictions]`):

```js
  ["Sensitive sites", buildSensitive],
```

- [ ] **Step 4: Generate `data/sensitive.geojson` deterministically**

(No network needed — generate just this file rather than running the whole flaky pipeline.)

Run:
```bash
node --input-type=module -e '
import { readFile, writeFile } from "node:fs/promises";
import { sensitiveFeatures } from "./sensitive.mjs";
const c = JSON.parse(await readFile("config.json", "utf8"));
const fc = { type: "FeatureCollection", generated: new Date().toISOString(),
  features: sensitiveFeatures(c.sensitive.sites, { nsm_url: c.sensitive.nsm_url }) };
await writeFile("data/sensitive.geojson", JSON.stringify(fc));
console.log("wrote", fc.features.length, "features");
'
```
Expected: `wrote 6 features`, and `data/sensitive.geojson` now exists.

- [ ] **Step 5: Verify the file**

Run: `node -e "const d=require('./data/sensitive.geojson'); console.log(d.features.length, d.features.every(f=>f.geometry.type==='Point'))"`
Expected: `6 true`

- [ ] **Step 6: Commit**

```bash
git add scripts/build-data.mjs data/sensitive.geojson
git commit -m "NSM sites: pipeline step + generated sensitive.geojson"
```

---

### Task 4: Render the markers on the map

**Files:**
- Modify: `app.js` (COLORS, LAYER_DEFS, `files`, `buildLayer`, new `addSensitive`, `typeLabel`, `popupHtml`)
- Modify: `style.css` (`.sensitive-icon`)

- [ ] **Step 1: Add the colour**

In the `COLORS` object (`app.js`), add (value = the existing `--c-nsm`):

```js
  sensitive: "#7c8aa3", // military/sensitive site (advisory) → NSM grey-blue
```

- [ ] **Step 2: Add the layer definition**

In `LAYER_DEFS`, add an entry (place it after the `prison` entry). It is **non-blocking** on purpose — it must never drive the verdict:

```js
  { id: "sensitive", name: "Military / sensitive sites", color: COLORS.sensitive, on: true, file: "sensitive", blocking: false, severity: "permission" },
```

- [ ] **Step 3: Load the data file**

In `init()`, add `"sensitive"` to the `files` array:

```js
  const files = ["airports", "airspace", "nature", "populated", "helipads", "prisons", "restrictions", "sensitive"];
```

- [ ] **Step 4: Route to a custom renderer**

In `buildLayer`, add a branch before the generic `else if (f.geometry.type === "Point")`:

```js
    } else if (def.id === "sensitive") {
      addSensitive(group, f, def);
```

- [ ] **Step 5: Implement `addSensitive`**

Add near `addPrison` (no ring — a circle would read as a boundary):

```js
function addSensitive(group, f, def) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const icon = L.divIcon({ className: "sensitive-icon", iconSize: [14, 14], iconAnchor: [7, 7] });
  const m = L.marker([lat, lon], { icon });
  m.bindPopup(popupHtml(f, def));
  m.bindTooltip(esc(p.name), { direction: "top", offset: [0, -8] });
  group.addLayer(m);
}
```

- [ ] **Step 6: Type label + popup NSM link**

In `typeLabel`, add before the final `return def.name;`:

```js
  if (def.id === "sensitive") return "Military / sensitive site";
```

In `popupHtml`, in the block that builds `links`, add (so the popup footer gets a "Check NSM map ↗" link):

```js
  if (p.nsm_url) links.push(`<a href="${esc(safeUrl(p.nsm_url))}" target="_blank" rel="noopener">Check NSM map ↗</a>`);
```

- [ ] **Step 7: Style the diamond marker**

In `style.css`, after the `.helipad-icon span { … }` rule, add:

```css
/* Military / sensitive-site marker — a diamond (rotated square), distinct from the
   round dots; deliberately NO ring (these are NOT drawn NSM zones). */
.sensitive-icon {
  width: 14px; height: 14px;
  background: var(--c-nsm);
  border: 1.5px solid #fff;
  transform: rotate(45deg);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .5);
}
```

- [ ] **Step 8: Verify in the browser**

Run: `python3 -m http.server 8000` (from repo root), open `http://localhost:8000`.
Expected: 6 grey diamond markers (Bodø, Andøya, Evenes, Bardufoss, Ramsund, Sortland); the "Military / sensitive sites" toggle shows count **6** and is on; clicking a diamond opens a popup whose footer has a **"Check NSM map ↗"** link and whose text says to check NSM (no "no-fly"). Toggle the layer off/on — markers disappear/reappear.

- [ ] **Step 9: Commit**

```bash
git add app.js style.css
git commit -m "NSM sites: render diamond markers + popup NSM link"
```

---

### Task 5: Non-blocking "nearest sensitive site" in the spot-check

**Files:**
- Modify: `app.js` (import `haversine`, `analyzePoint`, `renderResult`)
- Modify: `style.css` (`.nearest--sensitive`)

- [ ] **Step 1: Import `haversine`**

Update the geometry import in `app.js` to include `haversine`:

```js
import { featureContains, nearestPointOnFeature, bearingTo, fmtDist, haversine } from "./geometry.mjs";
```

- [ ] **Step 2: Compute the nearest sensitive site**

In `analyzePoint`, after the `for (const def of LAYER_DEFS)` loop closes (just before the `if (pickMarker) …` block), add a **separate, non-blocking** scan (the existing `nearest` only considers `def.blocking`, so it skips this layer):

```js
  // Nearest military/sensitive site — advisory only (non-blocking), surfaced when
  // within notify_km so a sensor-ban near a base prompts an NSM check. Never a hit.
  let nearestSensitive = null;
  const notifyM = (config.sensitive?.notify_km ?? 0) * 1000;
  if (notifyM > 0) {
    for (const { feature: f } of (featuresByLayer.sensitive || [])) {
      const [flon, flat] = f.geometry.coordinates;
      const d = haversine(lat, lng, flat, flon);
      if (d <= notifyM && (!nearestSensitive || d < nearestSensitive.distM)) {
        nearestSensitive = { p: f.properties, distM: d, bearing: bearingTo(lat, lng, [flat, flon]) };
      }
    }
  }
```

- [ ] **Step 3: Pass it to `renderResult`**

Change the call to `renderResult(latlng, hits, nearest);` →

```js
  renderResult(latlng, hits, nearest, nearestSensitive);
```

- [ ] **Step 4: Render the advisory line**

Update `renderResult`'s signature to `function renderResult(latlng, hits, nearest, nearestSensitive)`. After the `nearestHtml` line, add:

```js
  // Advisory — independent of the verdict (a sensor-ban can apply even on an
  // otherwise-clear spot). Never a no-fly; always routes to NSM's own map.
  const sensitiveHtml = nearestSensitive
    ? `<div class="nearest nearest--sensitive">⚠️ Nearest military / sensitive site:
        <strong>${esc(nearestSensitive.p.name)}</strong> — ${fmtDist(nearestSensitive.distM)} ${nearestSensitive.bearing}.
        Photo/sensor bans may apply nearby —
        <a href="${esc(safeUrl(nearestSensitive.p.nsm_url))}" target="_blank" rel="noopener">check NSM map ↗</a>.</div>`
    : "";
```

Then add `sensitiveHtml` into the final `body.innerHTML` assignment, after `nearestHtml`:

```js
  body.innerHTML = verdict + blockHtml + nearestHtml + sensitiveHtml + clearNote + contextHtml +
    `<div class="coords">${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}</div>`;
```

- [ ] **Step 5: Style the advisory line**

In `style.css`, after the `.nearest strong { … }` rule, add (NSM grey-blue, distinct from the amber `.nearest`):

```css
.nearest--sensitive { background: rgba(124, 138, 163, .12); border-color: rgba(124, 138, 163, .45); color: #c2cee0; }
.nearest--sensitive strong { color: #dbe6f4; }
```

- [ ] **Step 6: Verify in the browser**

Reload `http://localhost:8000`. Arm "Can I fly here?" and tap:
- near Bodø (e.g. on the city) → result shows the grey "Nearest military / sensitive site: Bodø air station — … → check NSM map ↗" line; the **verdict headline is unchanged** by it (e.g. still "Permission needed" for the airport zone, or "No drone restriction…" on a clear spot).
- far out at sea (>20 km from every site) → **no** sensitive line appears.
- Confirm tapping a spot *inside* a no-fly still reads as no-fly and the sensitive line is purely additive.

- [ ] **Step 7: Commit**

```bash
git add app.js style.css
git commit -m "NSM sites: non-blocking nearest-site advisory in spot-check"
```

---

### Task 6: Glossary + rules note + offline precache

**Files:**
- Modify: `index.html` (glossary entry + rules §③ note)
- Modify: `sw.js` (precache + cache bump)
- Modify: `README.md` (layer-table row)

- [ ] **Step 1: Glossary entry**

In `index.html`, in `ul.gloss`, add a new `<li>` immediately after the existing "Photo / sensor-ban zone (NSM)" entry:

```html
          <li><span class="chip" style="background:var(--c-nsm);transform:rotate(45deg)"></span><span><span class="gloss-title"><b>Military / sensitive site (marker)</b><span class="badge badge--perm">Need permission</span></span>The well-known military sites are marked as grey diamonds so you know where to be extra careful. <b>These are the installations, not NSM's actual ban zones</b> — the real zones aren't drawn, may sit elsewhere, and may exist at unmarked places.<span class="todo"><b>Before you fly:</b> check <a href="https://nsm.no/tjenester/kart-over-forbudsomrader-for-luftbarne-sensorsystemer/" target="_blank" rel="noopener">NSM's sensor-ban map ↗</a>; near a military area, flying itself needs the local commander's OK. <cite>FOR-2018-06-22-951 §6 · BSL A 7-2 §7</cite></span></span></li>
```

- [ ] **Step 2: One-line note in rules §③**

In the rules modal §③, in the existing NSM `<li>` (the "Filming designated military/prohibited areas…" line), append before its `<cite>`:

```html
 The best-known military sites are now marked with a grey diamond on the map as a reminder.
```

- [ ] **Step 3: Precache the data file**

In `sw.js`, add `"./data/sensitive.geojson"` to `SHELL_ASSETS` (next to `"./data/restrictions.geojson"`).

- [ ] **Step 4: Bump the shell cache**

In `sw.js`, change `const SHELL_CACHE = "drone-shell-v14";` → `"drone-shell-v15";`.

- [ ] **Step 5: README row**

In `README.md`'s layer table, add a row after the Prisons row:

```
| **Military / sensitive sites** | Advisory dots at well-known installations (Bodø, Andøya, Evenes, Bardufoss, Ramsund, Sortland). **Not** NSM's sensor-ban zones (no open feed) — every marker points to NSM's own map. | Curated | Hand-verified |
```

- [ ] **Step 6: Run the full test suite (offline-assets now needs the data file present)**

Run: `node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs scripts/season.test.mjs scripts/sensitive.test.mjs`
Expected: all PASS — in particular `offline-assets` "every precached shell asset exists on disk" passes because `data/sensitive.geojson` exists (Task 3).

- [ ] **Step 7: Commit**

```bash
git add index.html sw.js README.md
git commit -m "NSM sites: glossary, rules note, offline precache (v15) + README"
```

---

### Task 7: Whole-feature verification

**Files:** none (verification only)

- [ ] **Step 1: Full test run**

Run: `node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs scripts/season.test.mjs scripts/sensitive.test.mjs`
Expected: all PASS.

- [ ] **Step 2: Browser smoke test**

Serve (`python3 -m http.server 8000`) and confirm end-to-end:
- 6 diamonds render at the right places; layer toggle count = 6.
- Popup has the "Check NSM map ↗" link and honest text (no "no-fly").
- Spot-check near a site shows the advisory line; far away it doesn't; the verdict is never changed by it.
- Glossary shows the new entry with a diamond chip.
- DevTools → Application → Service Workers: after reload, the active cache is `drone-shell-v15` and `data/sensitive.geojson` is cached.

- [ ] **Step 3: Confirm honesty invariants**

Run: `grep -in "no-fly" data/sensitive.geojson sensitive.mjs` → expect **no matches**.
Confirm `app.js` `LAYER_DEFS` `sensitive` entry is `blocking: false`.

- [ ] **Step 4: Finalize**

If any fixes were needed, commit them. Then this branch is ready for `superpowers:finishing-a-development-branch` (merge / PR decision).

---

## Notes for the implementer

- **Do not draw any radius/polygon** for sensitive sites — markers only. A ring would imply a boundary we don't have.
- **Keep the layer `blocking: false`.** The verdict severity is computed only from blocking hits; the advisory line is additive and must never turn a clear/permission spot into "no-fly."
- The data file is committed (like the others) so the static site + offline PWA work without running the pipeline. Regenerate it with the Task 3 Step 4 command (or the full `node scripts/build-data.mjs`) if the site list changes.
- `notify_km` (20) is a relevance threshold for the spot-check only; it does not affect what's drawn.
