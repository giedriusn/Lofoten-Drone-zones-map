# Seabird Reserves & Nesting Bans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface seabird reserves and their seasonal nesting bans as an accurate, date-aware, toggleable no-fly layer on the drone map.

**Architecture:** Detect seabird reserves at the data-pipeline source using the authoritative `verneplan = "VerneplanSjoefugl"` field (replacing a name guess that misses ~25 real reserves). Split them into their own Leaflet layer. A new pure ES module computes whether the nesting ban is active *today* (the data file is static, so "active now" must be evaluated live in the browser); that drives map styling, popups, the spot-check verdict, and an in-season banner.

**Tech Stack:** Vanilla JS ES modules (no build, no deps), Leaflet (vendored), Node 18+ built-in test runner (`node --test`), zero-dependency Node data pipeline.

**Spec:** `docs/superpowers/specs/2026-06-23-seabird-reserves-nesting-bans-design.md`

---

## File Structure

- **Create** `season.mjs` (repo root) — one pure function `nestingActive(from, to, today)`. New module so it is unit-testable in isolation, matching the existing `geometry.mjs` / `tiles.mjs` pattern (pure module at root, test in `scripts/`).
- **Create** `scripts/season.test.mjs` — `node --test` unit tests for the helper.
- **Modify** `.github/workflows/test.yml` — add `season.test.mjs` to the explicit test file list.
- **Modify** `scripts/build-data.mjs` (`buildNature`, `natureRule`) — request `verneplan`, derive `seabird`, emit window fields, seabird rule branch.
- **Modify** `app.js` — `COLORS.seabird`, new `LAYER_DEFS` entry + nature split, import `nestingActive`, date-aware styling/popup/verdict, season banner toggle.
- **Modify** `index.html` — season-banner element, glossary entry, copy tweak.
- **Modify** `style.css` — `--c-seabird`, dashed legend chip, banner + "active" emphasis styles.
- **Regenerate** `data/nature.geojson` — build artifact, committed.

---

## Task 1: Pure nesting-window helper (`nestingActive`)

**Files:**
- Create: `season.mjs`
- Test: `scripts/season.test.mjs`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Write the failing test**

Create `scripts/season.test.mjs`:

```js
// scripts/season.test.mjs
// Pins the "is the nesting ban active today?" date math. Windows are "MM-DD"
// strings so they are year-independent across the build → runtime boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nestingActive } from "../season.mjs";

const on = (iso) => new Date(iso + "T12:00:00Z");

test("inside the typical 15 Apr–31 Jul window is active", () => {
  assert.equal(nestingActive("04-15", "07-31", on("2026-06-23")), true);
});

test("window bounds are inclusive", () => {
  assert.equal(nestingActive("04-15", "07-31", on("2026-04-15")), true);
  assert.equal(nestingActive("04-15", "07-31", on("2026-07-31")), true);
});

test("outside the window is dormant", () => {
  assert.equal(nestingActive("04-15", "07-31", on("2026-08-01")), false);
  assert.equal(nestingActive("04-15", "07-31", on("2026-04-14")), false);
  assert.equal(nestingActive("04-15", "07-31", on("2026-01-10")), false);
});

test("a year-wrapping window is handled (defensive — not used today)", () => {
  assert.equal(nestingActive("11-01", "02-28", on("2026-01-15")), true);
  assert.equal(nestingActive("11-01", "02-28", on("2026-12-20")), true);
  assert.equal(nestingActive("11-01", "02-28", on("2026-06-01")), false);
});

test("missing window → not active (never assert a ban we can't bound)", () => {
  assert.equal(nestingActive(null, null, on("2026-06-23")), false);
  assert.equal(nestingActive("04-15", "", on("2026-06-23")), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/season.test.mjs`
Expected: FAIL — `Cannot find module '../season.mjs'` (or `nestingActive is not a function`).

- [ ] **Step 3: Write the minimal implementation**

Create `season.mjs`:

```js
// season.mjs
// Is a seasonal window active on a given day? Windows are "MM-DD" strings, so the
// result is year-independent — the data file bakes the window, the browser decides
// "now". Bounds inclusive. Handles a window that wraps the new year (from > to),
// though the seabird nesting window (Apr→Jul) does not.
export function nestingActive(from, to, today = new Date()) {
  const md = (s) => {
    const m = /^(\d{2})-(\d{2})$/.exec(s || "");
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  };
  const f = md(from), t = md(to);
  if (f == null || t == null) return false; // never claim a ban we can't bound
  const now = (today.getMonth() + 1) * 100 + today.getDate();
  return f <= t ? now >= f && now <= t : now >= f || now <= t;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/season.test.mjs`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Wire the test into CI**

In `.github/workflows/test.yml`, find the line:

```yaml
      - run: node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs
```

Append `scripts/season.test.mjs` to it:

```yaml
      - run: node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs scripts/season.test.mjs
```

- [ ] **Step 6: Run the full local test list to confirm nothing else broke**

Run: `node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs scripts/season.test.mjs`
Expected: PASS — all suites green.

- [ ] **Step 7: Commit**

```bash
git add season.mjs scripts/season.test.mjs .github/workflows/test.yml
git commit -m "Add nestingActive: pure date helper for seasonal ban status"
```

---

## Task 2: Data pipeline — seabird detection, window fields, rule text

**Files:**
- Modify: `scripts/build-data.mjs` (`natureRule` ~209-222, `buildNature` ~224-285)

- [ ] **Step 1: Add `verneplan` to the ArcGIS `outFields`**

In `buildNature`, in the `outFields` value, append `,verneplan` so the field is returned:

```js
      outFields: "naturvernId,navn,offisieltNavn,verneform,verneformAggregert,kommune,verneforskrift,faktaark,vernedato,forvaltningsmyndighet,iucn,verneplan",
```

- [ ] **Step 2: Derive `seabird` and emit window + properties**

In the feature loop, after `const seasonal = ...`, add seabird detection and make `verneplan` the primary seasonal signal. Replace the existing `seasonal` line and properties block so it reads:

```js
      const seabird = (p.verneplan || "") === "VerneplanSjoefugl";
      // verneplan is the authoritative seabird signal (most seabird reserves are
      // plain "Naturreservat" by verneform, so name/verneform matching misses them).
      // Keep the old tokens as a fallback for non-seabird wildlife areas (Dyrelivsfredning…).
      const seasonal = seabird || /dyreliv|dyrefredning|fugl/.test(vf) || /fugl/i.test(name);
      features.push({
        type: "Feature",
        geometry: f.geometry,
        properties: {
          layer: "nature",
          name,
          verneform: p.verneform,
          category: cat,
          seabird,
          seasonal,
          ...(seabird ? { nesting_from: "04-15", nesting_to: "07-31" } : {}),
          municipality: p.kommune || "",
          iucn: p.iucn || "",
          protected_since: p.vernedato ? new Date(p.vernedato).toISOString().slice(0, 10) : "",
          regulation: p.verneforskrift || "",
          factsheet: p.faktaark || "",
          rule: natureRule(cat, seasonal, seabird),
        },
      });
```

- [ ] **Step 3: Add the seabird branch to `natureRule`**

Change the signature to `natureRule(cat, seasonal, seabird)` and have the seabird case fully own its text (it must NOT also append the generic `season` clause — that would duplicate the ferdselsforbud sentence):

```js
function natureRule(cat, seasonal, seabird) {
  if (seabird) {
    return "Seabird reserve (Verneplan for sjøfugl). A nature reserve — drone flight is banned year-round under its verneforskrift (take-off, landing AND flying in; no altitude exemption). On top of that, a seasonal access ban (ferdselsforbud) closes it during nesting, typically 15 Apr–31 Jul (some areas to 15 Aug) — exact dates vary, check the verneforskrift.";
  }
  const season = seasonal
    ? " Seasonal: wildlife reserves may add a strict access ban (ferdselsforbud) during breeding — stay out and do not fly. Check the verneforskrift for dates."
    : "";
  let base;
  if (cat.includes("nasjonalpark")) {
    base = "National park — drone flight is forbidden as a general rule (verneforskrift under naturmangfoldloven). Take-off, landing AND flying into the area are all banned. Exemptions require Statsforvalteren approval.";
  } else if (cat.includes("naturreservat")) {
    base = "Nature reserve — drone flight is banned in many reserves (especially bird areas). Older rules ban 'modellfly', interpreted to include drones. Check the verneforskrift before flying.";
  } else {
    base = "Protected area — a drone ban may apply via the verneforskrift. Even where not banned, naturmangfoldloven §15 prohibits disturbing wildlife. Check the regulation.";
  }
  return base + season;
}
```

- [ ] **Step 4: Regenerate the data (live fetch)**

Run: `node scripts/build-data.mjs`
Expected: prints `✓ Nature reserves & parks: 208 features -> data/nature.geojson` (count may vary slightly as upstream data changes) and `5/5 layers built`. Requires network. If Overpass mirrors fail, the Nature step still succeeds — only Populated/Helipads depend on Overpass.

- [ ] **Step 5: Verify the new fields landed**

Run:
```bash
node -e 'const fc=JSON.parse(require("fs").readFileSync("data/nature.geojson","utf8"));
const sb=fc.features.filter(f=>f.properties.seabird);
console.log("seabird:",sb.length);
const has=n=>sb.some(f=>(f.properties.name||"").startsWith(n));
console.log("Bliksvær:",has("Bliksvær"),"Bleiksøya:",has("Bleiksøya"));
console.log("window sample:",sb[0].properties.nesting_from,sb[0].properties.nesting_to);
console.log("rule sample:",sb[0].properties.rule.slice(0,60));'
```
Expected: `seabird: 45` (±a few), `Bliksvær: true Bleiksøya: true`, `window sample: 04-15 07-31`, rule begins "Seabird reserve…".

- [ ] **Step 6: Commit (code + regenerated data together)**

```bash
git add scripts/build-data.mjs data/nature.geojson
git commit -m "Pipeline: detect seabird reserves via verneplan; add nesting window + rule"
```

---

## Task 3: Map layer — split seabird out of the nature layer

**Files:**
- Modify: `app.js` (`COLORS` ~8-22, `LAYER_DEFS` ~29-41, import line ~6)

- [ ] **Step 1: Import the helper**

At the top of `app.js`, alongside the existing geometry import, add:

```js
import { nestingActive } from "./season.mjs";
```

- [ ] **Step 2: Add the seabird colour**

In `COLORS`, add (red no-fly family — distinguished by edge + marker, not hue):

```js
  seabird: "#ff2238",     // seabird reserve = strict no-fly (red); dashed edge + 🐦 marker set it apart
```

- [ ] **Step 3: Add the layer def and split the nature layer**

In `LAYER_DEFS`, change the existing nature entry to exclude seabird, and add the seabird entry right after it:

```js
  { id: "nature", name: "Nature reserves & parks", color: COLORS.reserve, on: true, file: "nature", match: p => !p.seabird, blocking: true, severity: "nofly" },
  { id: "seabird", name: "Seabird reserves (nesting ban)", color: COLORS.seabird, on: true, file: "nature", match: p => p.seabird, dashed: true, blocking: true, severity: "nofly", stroke: "#7a0010", weight: 2 },
```

- [ ] **Step 4: Verify the split in the browser**

Run: `python3 -m http.server 8000` (from repo root), open `http://localhost:8000`.
Expected: two layer rows — "Nature reserves & parks" (count ~163) and "Seabird reserves (nesting ban)" (count ~45); together they equal the old nature count. Seabird polygons draw with a dashed dark-red edge. Toggling each works. (Marker + date-aware emphasis come in Task 4.) Stop the server with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "Add seabird-reserve map layer, split from nature layer"
```

---

## Task 4: Date-aware styling, marker, popup & verdict

**Files:**
- Modify: `app.js` (`buildLayer` ~152-176, `styleFor` ~246-263, `popupHtml` ~267-290, `renderResult`/`renderHit` ~524-557)

- [ ] **Step 1: Add a shared status-line helper (DRY across popup + verdict)**

Add near the other presentation helpers (e.g. above `popupHtml`):

```js
// Live nesting-ban status for a seabird feature, shown in both the popup and the
// spot-check verdict. Computed at view time from today's date (the data file is static).
function nestingStatusHtml(p) {
  if (!p.seabird) return "";
  const active = nestingActive(p.nesting_from, p.nesting_to, new Date());
  return active
    ? `<div class="pp-rule nesting nesting--on">🐦 Nesting ban ACTIVE now — closed until 31 Jul (ferdselsforbud)</div>`
    : `<div class="pp-rule nesting nesting--off">🐦 Nesting ban — dormant now (applies ~15 Apr–31 Jul)</div>`;
}
```

- [ ] **Step 2: Show the status line in popups**

In `popupHtml`, insert the status line into the returned template (right after the `pp-rule` rule line):

```js
  return `<h3>${esc(name)}</h3>
    <div class="pp-type">${esc(type)}</div>
    <div class="pp-rule">${esc(p.rule || "")}</div>
    ${nestingStatusHtml(p)}
    ${extra}
    ${links.length ? `<div class="pp-rule">${links.join(" · ")}</div>` : ""}`;
```

- [ ] **Step 3: Show the status line in the spot-check verdict**

In the `renderHit` closure inside `renderResult`, append the status line to the hit block (after the `hit__rule` div):

```js
    return `<div class="hit">
      <div class="hit__top"><span class="hit__chip" style="background:${color}"></span>
        <span class="hit__name">${esc(h.p.name || type)}</span></div>
      <div class="hit__type">${esc(type)}${alt}</div>
      <div class="hit__rule">${esc(h.p.rule || "")}${reg}</div>
      ${nestingStatusHtml(h.p)}
    </div>`;
```

- [ ] **Step 4: Date-aware fill emphasis in `styleFor`**

In `styleFor`, after computing `noFly`, add a seabird active/dormant adjustment. Active → bolder & more opaque; dormant → lighter. Keeps the dashed red identity in both states:

```js
  const noFly = def.severity === "nofly";
  const seabirdActive = def.id === "seabird" && nestingActive(p.nesting_from, p.nesting_to, new Date());
  return {
    color: def.stroke || fill, fillColor: fill,
    weight: def.id === "seabird" ? (seabirdActive ? 2.6 : 1.6) : (def.weight ?? (noFly ? 2.2 : def.id === "tiz" ? 1 : 1.5)),
    fillOpacity: def.id === "seabird" ? (seabirdActive ? 0.32 : 0.12)
      : def.id === "exercise" ? 0.06 : def.id === "tiz" ? 0.15
      : def.id === "populated" ? 0.18 : noFly ? 0.24 : 0.16,
    dashArray: def.dashed ? "6 4" : null,
  };
```

- [ ] **Step 5: Add the 🐦 centre marker for seabird polygons**

In `buildLayer`, in the polygon branch (the `else` that builds `L.geoJSON`), add a centroid marker for seabird features. Replace that `else` block with:

```js
    } else {
      const lyr = L.geoJSON(f, { style: () => styleFor(def, f.properties) });
      lyr.bindPopup(popupHtml(f, def));
      group.addLayer(lyr);
      if (def.id === "seabird") {
        const c = lyr.getBounds().getCenter();
        const icon = L.divIcon({ className: "seabird-icon", html: "🐦", iconSize: [16, 16], iconAnchor: [8, 8] });
        const m = L.marker(c, { icon, interactive: false });
        group.addLayer(m);
      }
    }
```

- [ ] **Step 6: Verify in the browser**

Run: `python3 -m http.server 8000`, open `http://localhost:8000`.
Expected (today is in-season): seabird polygons show a 🐦 at centre and a bolder/more-saturated red fill; clicking one shows "🐦 Nesting ban ACTIVE now — closed until 31 Jul"; "Can I fly here?" on a seabird reserve shows the same active line in the verdict. (Temporarily test the dormant path by editing the helper's date to e.g. `new Date("2026-09-01")` → fill lighter, popup says "dormant"; revert after.) Stop the server.

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "Seabird layer: 🐦 marker, date-aware fill, active/dormant popup + verdict"
```

---

## Task 5: In-season banner

**Files:**
- Modify: `index.html` (panel body, near `disclaimer--wild` ~67-71)
- Modify: `app.js` (`init` ~67-95)
- Modify: `style.css`

- [ ] **Step 1: Add the (hidden) banner element**

In `index.html`, immediately after the `disclaimer--wild` paragraph, add:

```html
      <p class="seasonbanner" id="seasonBanner" hidden>
        🐦 <strong>Nesting season is on</strong> — seabird reserves are closed
        (ferdselsforbud) until ~31 Jul. Don't fly in or over them.
      </p>
```

- [ ] **Step 2: Toggle it at init from today's date**

In `app.js` `init`, after `buildLayerUI();`, add:

```js
  // Show the nesting-season banner only while the seabird access ban is active today.
  const banner = document.getElementById("seasonBanner");
  if (banner && nestingActive("04-15", "07-31", new Date())) banner.hidden = false;
```

- [ ] **Step 3: Style the banner**

In `style.css`, add (sits with the wildlife disclaimer; amber/red emphasis so it reads as an active restriction):

```css
.seasonbanner { margin-top: 8px; padding: 8px 10px; font-size: 13px; line-height: 1.4;
  background: rgba(255,34,56,.10); border: 1px solid rgba(255,34,56,.40);
  border-radius: 8px; color: #ffb3c0; }
.seasonbanner strong { color: #ff8aa0; }
```

- [ ] **Step 4: Verify**

Run: `python3 -m http.server 8000`, open `http://localhost:8000`.
Expected: the banner is visible in the control panel today (in-season). (Confirm the hidden path by setting the init date to `"2026-09-01"` → banner absent; revert.) Stop the server.

- [ ] **Step 5: Commit**

```bash
git add index.html app.js style.css
git commit -m "Add in-season nesting banner (shown only during the ban window)"
```

---

## Task 6: Legend, glossary chip & copy

**Files:**
- Modify: `style.css` (`:root` vars ~10-22; chip styles; `.nesting` styles)
- Modify: `index.html` (glossary `<ul class="gloss">` ~166-178; wildlife copy ~67-71, 135)

- [ ] **Step 1: Add the CSS colour var and the nesting status styles**

In `style.css` `:root`, after `--c-reserve`, add:

```css
  --c-seabird: #ff2238;
```

And add status-line styles (used by `nestingStatusHtml`):

```css
.nesting { margin-top: 6px; border-radius: 6px; padding: 4px 8px; font-weight: 600; }
.nesting--on { background: rgba(255,34,56,.14); border: 1px solid rgba(255,34,56,.45); color: #ff9aab; }
.nesting--off { background: rgba(138,160,182,.12); border: 1px solid rgba(138,160,182,.30); color: #b7c4d2; font-weight: 500; }
```

- [ ] **Step 2: Add a dashed-chip modifier for the legend**

In `style.css`, near the existing `.chip` rules, add. NOTE: it MUST be scoped under
`ul.gloss` to out-specify the existing `ul.gloss .chip { border: 1px solid … }` rule
— a bare `.chip--dashed` has lower specificity and would render solid, not dashed
(mirror the existing `ul.gloss .chip--ring` pattern):

```css
ul.gloss .chip--dashed { border: 1.5px dashed #7a0010; }
```

- [ ] **Step 3: Add the glossary entry**

In `index.html`, in `<ul class="gloss">`, immediately after the "Nature reserve / national park" `<li>` (~174), add:

```html
          <li><span class="chip chip--dashed" style="background:var(--c-seabird)"></span><span><span class="gloss-title"><b>Seabird reserve</b><span class="badge badge--nofly">No-fly</span></span>A nature reserve that protects nesting seabirds. Flying is banned year-round, and on top of that a seasonal access ban (ferdselsforbud) closes it during nesting — typically 15 Apr–31 Jul. The map highlights these in bold while the ban is active.<span class="todo"><b>To fly:</b> don't — pick another spot. Exact dates vary; check the area's verneforskrift. <cite>e.g. Bliksvær FOR-2002-12-06-1426 §3</cite></span></span></li>
```

- [ ] **Step 4: Tighten the wildlife copy for consistency**

The existing `disclaimer--wild` (index.html ~67-71) and rule-§④ seabird line (~135) already mention the 15 Apr–31 Jul ferdselsforbud — leave their wording, but confirm they don't contradict the new banner (both say "~15 Apr–31 Jul" / "exact dates per area"). No change needed unless a contradiction is found; if so, align them to "typically 15 Apr–31 Jul; exact dates per area". (No-op step if already consistent.)

- [ ] **Step 5: Verify**

Run: `python3 -m http.server 8000`, open `http://localhost:8000`, open "❓ What do the zones mean?".
Expected: a "Seabird reserve" legend row with a dashed red chip, No-fly badge, and the nesting-ban explanation. Popup/verdict nesting lines are styled (red when active). Stop the server.

- [ ] **Step 6: Commit**

```bash
git add style.css index.html
git commit -m "Legend + glossary + styles for seabird reserves and nesting status"
```

---

## Task 7: Full verification & wrap-up

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs scripts/season.test.mjs`
Expected: all suites PASS.

- [ ] **Step 2: Manual end-to-end check**

Run: `python3 -m http.server 8000`, open `http://localhost:8000`. Confirm:
- Season banner visible (in-season today).
- "Seabird reserves (nesting ban)" layer present, ~45 count, toggles on/off.
- Bliksvær & Bleiksøya are in the seabird layer with 🐦 markers and bold red fill.
- Popup on a seabird reserve: seabird rule text + "ACTIVE now" line + Regulation/Factsheet links.
- "Can I fly here?" on a seabird reserve: red "restriction here" verdict including the nesting line.
- Nature layer no longer double-draws those polygons (each appears once).
- Stop the server.

- [ ] **Step 3: Confirm the working tree is clean & committed**

Run: `git status`
Expected: clean (all changes committed across Tasks 1-6).

- [ ] **Step 4: Request code review**

Use superpowers:requesting-code-review to review the full diff against the spec before merging to `main`.
