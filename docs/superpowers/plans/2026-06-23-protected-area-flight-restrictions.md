# Protected-Area Flight Restriction Zones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Naturbase's exact protected-area restriction zones (access bans, low-flying-under-300m, landing bans) as one date-aware no-fly map layer with real per-zone rules and dates.

**Architecture:** A new pipeline step pulls the three civilian `vern_restriksjonsomrader` layers into `data/restrictions.geojson` (deduped by `vernRestriksjonId`), parsing exact dates from the official text at build time. A new toggleable Leaflet layer renders them red/no-fly; "active now" is computed live in the browser, reusing the seabird feature's `season.mjs` helpers.

**Tech Stack:** Vanilla JS ES modules (no build, no deps), Leaflet (vendored), Node 18+ built-in test runner, zero-dependency Node data pipeline.

**Spec:** `docs/superpowers/specs/2026-06-23-protected-area-flight-restrictions-design.md`

---

## Coexistence note (read first)

The codebase already has a **seabird/nesting** feature (`season.mjs` `nestingActive`, the `seabird` layer, `nestingStatusHtml`, date-aware `styleFor`) and a **prisons** feature, both in these same files. All edits below ADD alongside them — do not remove or alter seabird, prison, or data-age code. Read each file before editing; use the string anchors given.

## File Structure

- **Modify** `season.mjs` + `scripts/season.test.mjs` — add `parseRestrictionWindows` + `windowsActive` (pure, tested). `season.test.mjs` is already in CI.
- **Modify** `config.json` — add `restrictions_arcgis` source base.
- **Modify** `scripts/build-data.mjs` — import the parser, add `buildRestrictions`, register the step.
- **Modify** `app.js` — colour, layer def, `files` array, `typeLabel`, date-aware `styleFor`, `restrictionStatusHtml`, popup + verdict wiring, import.
- **Modify** `index.html`, `style.css` — glossary entry + `--c-restriction`.
- **Modify** `sw.js` — precache `restrictions.geojson`, bump `SHELL_CACHE`.
- **Modify** `README.md` — layer row.
- **Create** `data/restrictions.geojson` — build artifact (committed).

---

## Task 1: Date helpers (`parseRestrictionWindows`, `windowsActive`)

**Files:** Modify `season.mjs`; Test `scripts/season.test.mjs`

- [ ] **Step 1: Add the failing tests** — append to `scripts/season.test.mjs`:

```js
import { parseRestrictionWindows, windowsActive } from "../season.mjs";

test("parseRestrictionWindows: single d.m-d.m range → MM-DD window", () => {
  assert.deepEqual(parseRestrictionWindows("Ferdselsforbud (15.4-31.7)"),
    [{ from: "04-15", to: "07-31" }]);
});
test("parseRestrictionWindows: year-round 1.1-31.12", () => {
  assert.deepEqual(parseRestrictionWindows("Lavflyving forbudt (1.1-31.12)"),
    [{ from: "01-01", to: "12-31" }]);
});
test("parseRestrictionWindows: multiple ranges, ignores '< 300 m'", () => {
  assert.deepEqual(
    parseRestrictionWindows("Ferdselsforbud (1.3-31.7), Lavflyving forbudt (< 300 m) (1.1-31.12)"),
    [{ from: "03-01", to: "07-31" }, { from: "01-01", to: "12-31" }]);
});
test("parseRestrictionWindows: no dates → []", () => {
  assert.deepEqual(parseRestrictionWindows("Ferdselsforbud"), []);
  assert.deepEqual(parseRestrictionWindows(""), []);
});
test("windowsActive: year-round is always active", () => {
  assert.equal(windowsActive([], true, on("2026-01-10")), true);
});
test("windowsActive: true if any window active today", () => {
  const w = [{ from: "04-15", to: "07-31" }, { from: "11-01", to: "12-01" }];
  assert.equal(windowsActive(w, false, on("2026-06-23")), true);
  assert.equal(windowsActive(w, false, on("2026-09-01")), false);
});
test("windowsActive: no windows, not year-round → false", () => {
  assert.equal(windowsActive([], false, on("2026-06-23")), false);
});
```
(`on()` and `test`/`assert` are already defined at the top of this file from the seabird tests.)

- [ ] **Step 2: Run → fail**

Run: `node --test scripts/season.test.mjs`
Expected: FAIL — `parseRestrictionWindows`/`windowsActive` not exported.

- [ ] **Step 3: Implement** — append to `season.mjs` (after `nestingActive`):

```js
// Parse Norwegian restriction date ranges ("15.4-31.7", "1.1-31.12") out of the
// official restriksjonerBeskrivelse text into {from,to} "MM-DD" windows. The text is
// day.month-day.month; a zone may list several ranges (one per restriction). "1.1-31.12"
// is a year-round ban. "< 300 m" and other non-range numbers are ignored (no D.M-D.M).
export function parseRestrictionWindows(text) {
  const pad = (n) => String(n).padStart(2, "0");
  const out = [];
  const re = /(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{1,2})/g;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const [, d1, mo1, d2, mo2] = m;
    out.push({ from: `${pad(mo1)}-${pad(d1)}`, to: `${pad(mo2)}-${pad(d2)}` });
  }
  return out;
}

// A restriction zone is "in force today" if it is year-round or any of its windows is
// active now. Bridges the windows[] array shape to the scalar nestingActive helper.
export function windowsActive(windows, yearRound, today = new Date()) {
  if (yearRound) return true;
  return Array.isArray(windows) && windows.some((w) => nestingActive(w.from, w.to, today));
}
```

- [ ] **Step 4: Run → pass**

Run: `node --test scripts/season.test.mjs`
Expected: PASS (all seabird + new restriction tests).

- [ ] **Step 5: Commit**

```bash
git add season.mjs scripts/season.test.mjs
git commit -m "Add parseRestrictionWindows + windowsActive date helpers"
```
End the message with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 2: Pipeline step (`buildRestrictions`)

**Files:** Modify `config.json`, `scripts/build-data.mjs`

- [ ] **Step 1: Add the data source** — in `config.json`, in the `sources` object, after the `nature_arcgis` line, add:

```json
    "restrictions_arcgis": "https://kart.miljodirektoratet.no/arcgis/rest/services/vern_restriksjonsomrader/MapServer",
```

- [ ] **Step 2: Import the parser** — at the top of `scripts/build-data.mjs`, after the existing `import` lines (the file already imports `node:fs/promises` etc.), add:

```js
import { parseRestrictionWindows } from "../season.mjs";
```

- [ ] **Step 3: Add `buildRestrictions`** — insert this function just before the `// ---------- run ----------` section (after `buildPrisons`):

```js
// ---------- 7. Protected-area flight restriction zones ----------
// Naturbase vern_restriksjonsomrader: the exact restriction zones INSIDE protected
// areas. Civilian layers only — 0 ferdselsforbud (access ban), 1 lavflyving<300m
// (low flying banned — text says "Gjelder også bruk av modellfly" = incl. drones),
// 2 landingsforbud. The _forsvaret (3,4) layers restrict MILITARY aircraft, not
// civilian drones, so they are intentionally excluded.
async function buildRestrictions() {
  const byId = new Map(); // vernRestriksjonId -> feature; keep the longest (most complete) description
  for (const lyr of [0, 1, 2]) {
    let offset = 0;
    const page = 1000;
    for (;;) {
      const params = new URLSearchParams({
        where: "1=1",
        geometry: `${W},${S},${E},${N}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326", outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "vernRestriksjonId,navn,verneform,faktaark,restriksjoner,restriksjonerBeskrivelse",
        f: "geojson",
        maxAllowableOffset: "0.0001",
        geometryPrecision: "6",
        resultOffset: String(offset),
        resultRecordCount: String(page),
      });
      const data = await (await fetch(`${SRC.restrictions_arcgis}/${lyr}/query?${params}`)).json();
      const batch = data.features || [];
      for (const f of batch) {
        const p = f.properties || {};
        const id = p.vernRestriksjonId ?? f.id;
        const desc = p.restriksjonerBeskrivelse || "";
        const prev = byId.get(id);
        // dedup across layers: keep longest description; tie → first seen (deterministic)
        if (prev && (prev.properties.restrictions || "").length >= desc.length) continue;
        const windows = parseRestrictionWindows(desc);
        byId.set(id, {
          type: "Feature",
          geometry: f.geometry,
          properties: {
            layer: "restriction",
            name: p.navn || "",
            verneform: p.verneform || "",
            restrictions: desc,
            windows,
            year_round: windows.some(w => w.from === "01-01" && w.to === "12-31"),
            drones_explicit: /modellfly/i.test(desc),
            factsheet: p.faktaark || "",
            rule: "Flight ban inside a protected area. The official restriction(s) and dates:",
          },
        });
      }
      const more = data.exceededTransferLimit === true ||
        (data.exceededTransferLimit === undefined && batch.length === page);
      if (!more || batch.length === 0) break;
      offset += batch.length;
    }
  }
  await save("restrictions.geojson", [...byId.values()], "Protected-area flight bans");
}
```

- [ ] **Step 4: Register the step** — in the `const steps = [` array, after `["Prisons", buildPrisons],` add:

```js
  ["Restrictions", buildRestrictions],
```

- [ ] **Step 5: Run the build (live fetch)**

Run: `node scripts/build-data.mjs`
Expected: a line `✓ Protected-area flight bans: N features -> data/restrictions.geojson` (N in the low hundreds after dedup). Needs network. **If fetch is unavailable, report BLOCKED** (do not hand-write the data); the controller will run it.

- [ ] **Step 6: Verify the data**

Run:
```bash
node -e 'const fc=JSON.parse(require("fs").readFileSync("data/restrictions.geojson","utf8"));
const F=fc.features; console.log("zones:",F.length);
const b=F.find(f=>(f.properties.name||"").startsWith("Bliksvær"));
console.log("Bliksvær windows:",JSON.stringify(b&&b.properties.windows));
console.log("with drones_explicit:",F.filter(f=>f.properties.drones_explicit).length);
console.log("year_round:",F.filter(f=>f.properties.year_round).length);
console.log("no parsed window:",F.filter(f=>!f.properties.windows.length&&!f.properties.year_round).length);'
```
Expected: zones in low hundreds; Bliksvær window includes `{"from":"04-15","to":"07-31"}`; many `drones_explicit` and `year_round`.

- [ ] **Step 7: Commit**

```bash
git add config.json scripts/build-data.mjs data/restrictions.geojson
git commit -m "Pipeline: build protected-area restriction zones (vern_restriksjonsomrader)"
```
End with the Co-Authored-By trailer.

---

## Task 3: Map layer + date-aware rendering (`app.js`)

**Files:** Modify `app.js`

- [ ] **Step 1: Import `windowsActive`** — change the existing import line
  `import { nestingActive } from "./season.mjs";` to:
```js
import { nestingActive, windowsActive } from "./season.mjs";
```

- [ ] **Step 2: Add the colour** — in `COLORS`, add (red no-fly; distinguished by a dark solid edge in the layer def):
```js
  restriction: "#ff2238",  // protected-area flight ban = strict no-fly (red); dark solid edge
```

- [ ] **Step 3: Add the layer def** — in `LAYER_DEFS`, immediately AFTER the existing `seabird` entry, add:
```js
  { id: "restriction", name: "Protected-area flight bans", color: COLORS.restriction, on: true, file: "restrictions", blocking: true, severity: "nofly", stroke: "#5a000c", weight: 2.4 },
```

- [ ] **Step 4: Load the data file** — in `init`, change the `files` array to include `"restrictions"`:
```js
  const files = ["airports", "airspace", "nature", "populated", "helipads", "prisons", "restrictions"];
```

- [ ] **Step 5: Type label** — in `typeLabel`, before the final `return def.name;`, add:
```js
  if (def.id === "restriction") return "Protected-area flight ban";
```

- [ ] **Step 6: Date-aware styling** — in `styleFor`, replace the contiguous block **from the existing `const noFly = def.severity === "nofly";` line (app.js:289) through the closing `};` of the `return` (app.js:298)** with the block below. (The block re-states the `const noFly` line, so replace the existing one too — do NOT keep it, or you'll double-declare `noFly` and throw a SyntaxError.) This unified version covers seabird AND restriction and preserves every other branch:
```js
  const noFly = def.severity === "nofly";
  // Seabird + restriction layers are date-aware no-fly zones: bolder/more opaque while
  // their ban is in force today, lighter when dormant.
  const dateAware = def.id === "seabird" || def.id === "restriction";
  const activeNow = def.id === "seabird" ? nestingActive(p.nesting_from, p.nesting_to, new Date())
    : def.id === "restriction" ? windowsActive(p.windows, p.year_round, new Date())
    : false;
  return {
    color: def.stroke || fill, fillColor: fill,
    weight: dateAware ? (activeNow ? 2.6 : 1.7) : (def.weight ?? (noFly ? 2.2 : def.id === "tiz" ? 1 : 1.5)),
    fillOpacity: dateAware ? (activeNow ? 0.32 : 0.12)
      : def.id === "exercise" ? 0.06 : def.id === "tiz" ? 0.15
      : def.id === "populated" ? 0.18 : noFly ? 0.24 : 0.16,
    dashArray: def.dashed ? "6 4" : null,
  };
```

- [ ] **Step 7: Status helper** — add this function right after `nestingStatusHtml`:
```js
// Restriction-zone detail + live status, shown in the popup and the spot-check verdict.
function restrictionStatusHtml(p) {
  if (p.layer !== "restriction") return "";
  const detail = p.restrictions ? `<div class="pp-rule">${esc(p.restrictions)}</div>` : "";
  const drones = p.drones_explicit ? " — explicitly includes drones (modellfly)" : "";
  const active = windowsActive(p.windows, p.year_round, new Date());
  const status = active
    ? `<div class="pp-rule nesting nesting--on">🚫 In force now${drones}</div>`
    : `<div class="pp-rule nesting nesting--off">Seasonal — not in force today${drones}</div>`;
  return detail + status;
}
```

- [ ] **Step 8: Wire into the popup** — in `popupHtml`, after the `${nestingStatusHtml(p)}` line, add:
```js
    ${restrictionStatusHtml(p)}
```

- [ ] **Step 9: Wire into the verdict** — in the `renderHit` closure, after the `${nestingStatusHtml(h.p)}` line, add:
```js
      ${restrictionStatusHtml(h.p)}
```

- [ ] **Step 10: Verify parse + manual check**

Run: `node --check app.js` → expect no output (valid).
Then `python3 -m http.server 8137` and open `http://localhost:8137`. Expect: a "Protected-area flight bans" layer row with a count, red zones on the map, a zone popup showing the verbatim official restriction text + "In force now" (today). Stop the server.

- [ ] **Step 11: Commit**

```bash
git add app.js
git commit -m "Add protected-area flight-bans layer: date-aware style, popup, verdict"
```
End with the Co-Authored-By trailer.

---

## Task 4: Legend, CSS, service worker, README

**Files:** Modify `style.css`, `index.html`, `sw.js`, `README.md`

- [ ] **Step 1: CSS var** — in `style.css` `:root`, after `--c-seabird`, add:
```css
  --c-restriction: #ff2238;
```

- [ ] **Step 2: Glossary entry** — in `index.html`, in `<ul class="gloss">`, immediately AFTER the "Seabird reserve" `<li>`, add:
```html
          <li><span class="chip" style="background:var(--c-restriction);border:1.5px solid #5a000c"></span><span><span class="gloss-title"><b>Protected-area flight ban</b><span class="badge badge--nofly">No-fly</span></span>Exact zones inside reserves where flying is banned — seasonal access bans, "no low flying below 300 m" (this includes drones), and no-landing. Each zone's popup shows its official rule and dates.<span class="todo"><b>To fly:</b> don't — these are the precise no-fly areas; read the popup for the exact dates.</span></span></li>
```

- [ ] **Step 3: Service worker** — in `sw.js`, add `restrictions.geojson` to `SHELL_ASSETS` (the `./data/...geojson` lines) and bump the cache version:
  - change `"./data/populated.geojson", "./data/helipads.geojson", "./data/prisons.geojson",` to end with `"./data/restrictions.geojson",` on the same group, i.e.:
```js
  "./data/populated.geojson", "./data/helipads.geojson", "./data/prisons.geojson",
  "./data/restrictions.geojson",
```
  - change `const SHELL_CACHE = "drone-shell-v13";` to `"drone-shell-v14";`

- [ ] **Step 4: README row** — in `README.md`, after the **Nature reserves & parks** row, add:
```md
| **Protected-area flight bans** | Exact restriction zones inside protected areas — access bans (ferdselsforbud), low-flying-under-300 m (includes drones) and landing bans, with the official per-zone dates. Civilian zones only; military (Forsvaret) zones excluded. | [Miljødirektoratet](https://kart.miljodirektoratet.no/) | **Official government data** |
```

- [ ] **Step 5: Verify** — `python3 -m http.server 8137`, open the app, open "❓ What do the zones mean?" → the "Protected-area flight ban" legend row is present. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add style.css index.html sw.js README.md
git commit -m "Legend, CSS, SW precache + README for protected-area flight bans"
```
End with the Co-Authored-By trailer.

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Tests** — `node --test scripts/tiles.test.mjs scripts/geometry.test.mjs scripts/offline-assets.test.mjs scripts/season.test.mjs` → all PASS.
- [ ] **Step 2: Syntax** — `node --check app.js && node --check scripts/build-data.mjs && node --check season.mjs` → clean.
- [ ] **Step 3: Browser end-to-end** — `python3 -m http.server 8137`, open `http://localhost:8137`:
  - "Protected-area flight bans" layer present with a count, toggles on/off.
  - A zone popup shows the official restriction text + dates + "In force now".
  - "Can I fly here?" on a restriction zone returns a red no-fly verdict including the restriction line.
  - Seabird, nature, prison layers still work. Stop the server.
- [ ] **Step 4: Clean tree** — `git status` → clean.
- [ ] **Step 5: Code review** — use superpowers:requesting-code-review over the feature commits before merge.
