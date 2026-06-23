/* Drone Zones — Lofoten / Bodø / Narvik
   Loads local GeoJSON layers, renders them on a Leaflet map, and answers
   "can I fly at this point?" via point-in-polygon / distance checks. */

import { registerServiceWorker, kartverketBasemap, setupOfflineUI } from "./offline.mjs";
import { featureContains, nearestPointOnFeature, bearingTo, fmtDist, haversine } from "./geometry.mjs";
import { nestingActive, windowsActive } from "./season.mjs";

const COLORS = {
  // Severity palette: RED = strict no-fly · ORANGE = need permission · others = caution/context
  airport: "#ff9f0a",     // need permission → orange
  ctr: "#ff9500",         // need permission → orange
  tiz: "#ffb02e",         // need permission → amber/gold (distinct from the orange CTR, readable on the light basemap)
  restricted: "#ff2238",  // strict no-fly → red
  danger: "#ff2238",      // strict no-fly → red
  reserve: "#ff2238",     // nature reserve = strict no-fly → red
  seabird: "#ff2238",     // seabird reserve = strict no-fly (red); dashed edge + 🐦 marker set it apart
  park: "#c1121f",        // national park → deeper red
  exercise: "#9a6fb0",    // conditional (NOTAM) → violet
  airsport: "#ffc400",    // caution → yellow (deeper than pale gold for contrast on the light basemap)
  helipad: "#00c2d1",     // caution → cyan
  populated: "#4d8fd6",   // caution → blue
  prison: "#d6447d",      // need permission → magenta (distinct from the orange airport/CTR family)
  restriction: "#ff2238", // protected-area flight ban = strict no-fly (red); dark solid edge
  controlled: "#8aa0b6",  // context (high) → grey
  sensitive: "#7c8aa3", // military/sensitive site (advisory) → NSM grey-blue
};

// Layer definitions: how each is sourced from the data files, styled, and labelled.
// `blocking` = a legal/physical no-fly that should drive the "restricted" verdict;
//   non-blocking layers are context/advisory only.
// `severity` = how the zone is coloured & weighted by styleFor (see COLORS palette above):
//   nofly · permission · conditional · caution · context.
const LAYER_DEFS = [
  { id: "airport", name: "Airport 5 km zone", color: COLORS.airport, on: true, file: "airports", blocking: true, severity: "permission" },
  { id: "ctr", name: "Control zones (CTR)", color: COLORS.ctr, on: true, file: "airspace", match: p => p.category === "ctr", blocking: true, severity: "permission" },
  { id: "tiz", name: "Traffic info zones (TIZ)", color: COLORS.tiz, on: true, file: "airspace", match: p => p.category === "tiz", dashed: true, blocking: true, severity: "permission", stroke: "#e07b00", weight: 2 },
  { id: "restricted", name: "Restricted areas", color: COLORS.restricted, on: true, file: "airspace", match: p => p.category === "restricted", blocking: true, severity: "nofly" },
  { id: "danger", name: "Danger areas (firing/military)", color: COLORS.danger, on: true, file: "airspace", match: p => p.category === "danger", dashed: true, blocking: true, severity: "nofly" },
  { id: "exercise", name: "Military exercise areas (NOTAM)", color: COLORS.exercise, on: true, file: "airspace", match: p => p.category === "exercise", dashed: true, blocking: false, severity: "conditional" },
  { id: "nature", name: "Nature reserves & parks", color: COLORS.reserve, on: true, file: "nature", match: p => !p.seabird, blocking: true, severity: "nofly" },
  { id: "seabird", name: "Seabird reserves (nesting ban)", color: COLORS.seabird, on: true, file: "nature", match: p => p.seabird, dashed: true, blocking: true, severity: "nofly", stroke: "#7a0010", weight: 2 },
  { id: "restriction", name: "Protected-area flight bans", color: COLORS.restriction, on: true, file: "restrictions", blocking: true, severity: "nofly", stroke: "#5a000c", weight: 2.4 },
  { id: "prison", name: "Prisons", color: COLORS.prison, on: true, file: "prisons", blocking: true, severity: "permission" },
  { id: "sensitive", name: "Military / sensitive sites", color: COLORS.sensitive, on: true, file: "sensitive", blocking: false, severity: "permission" },
  { id: "helipad", name: "Hospital / HEMS helipads", color: COLORS.helipad, on: true, file: "helipads", blocking: false, severity: "caution" },
  { id: "airsport", name: "Air sports areas", color: COLORS.airsport, on: false, file: "airspace", match: p => p.category === "airsport", blocking: false, severity: "caution", stroke: "#7a5200", weight: 2 },
  { id: "populated", name: "Populated areas", color: COLORS.populated, on: false, file: "populated", blocking: false, severity: "caution" },
  { id: "controlled", name: "Controlled airspace (high)", color: COLORS.controlled, on: false, file: "airspace", match: p => p.category === "controlled", blocking: false, severity: "context" },
];

let map, config;
const groups = {};          // id -> L.layerGroup
const featuresByLayer = {}; // id -> [{feature, def}] for spot-check
let pickMode = false;
let pickMarker = null;
let accuracyCircle = null; // GPS accuracy ring for the "locate me" feature
// Monotonic token for in-flight "locate me" requests. A GPS fix can take several
// seconds; if the user pans or picks a spot meanwhile, bumping this abandons the
// pending fix so its late callback can't hijack the view/verdict they moved on to.
let locateSeq = 0;

// Surface a fatal init failure (e.g. config.json unreachable) instead of leaving
// the "Loading…" overlay spinning forever. Per-data-file errors fall back to empty
// inside init() and don't reach here.
init().catch(err => {
  console.error("Initialisation failed:", err);
  const el = document.getElementById("loading");
  if (el) {
    el.classList.remove("done");
    el.classList.add("error");
    el.textContent = "Couldn't load the map data. Check your connection and reload the page.";
  }
});

async function init() {
  registerServiceWorker();
  config = await (await fetch("config.json")).json();
  const { center, zoom, bbox } = config.region;

  map = L.map("map", {
    center, zoom, zoomControl: true,
    maxBounds: [[bbox[1] - 1.5, bbox[0] - 3], [bbox[3] + 1.5, bbox[2] + 3]],
    maxBoundsViscosity: 0.6,
  });

  const basemaps = setupBasemaps();
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

  // Load all data files in parallel.
  const files = ["airports", "airspace", "nature", "populated", "helipads", "prisons", "restrictions", "sensitive"];
  const data = {};
  await Promise.all(files.map(async f => {
    try { data[f] = await (await fetch(`data/${f}.geojson`)).json(); }
    catch { data[f] = { features: [] }; }
  }));

  for (const def of LAYER_DEFS) buildLayer(def, data[def.file]);
  showDataAge(data);
  buildLayerUI();
  // Show the nesting-season banner only while the seabird access ban is active today.
  const banner = document.getElementById("seasonBanner");
  if (banner && nestingActive("04-15", "07-31", new Date())) banner.hidden = false;
  wireControls();
  setupOfflineUI({ config, switchBasemap: basemaps.switchTo });

  document.getElementById("loading").classList.add("done");
}

/* ---------------- Basemaps ---------------- */

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
  // Restore the last-used basemap. Offline, force "Norway" (Kartverket) — it's the only
  // basemap whose tiles can be cached, so the online ones would render blank in the field.
  let saved = null;
  try { saved = localStorage.getItem("drone-basemap"); } catch {}
  let initial = saved && bases[saved] ? saved : DEFAULT;
  if (!navigator.onLine && bases.Norway) initial = "Norway";

  const seg = document.getElementById("basemaps");
  const buttons = {};
  let current = bases[initial];
  current.addTo(map);

  function switchTo(label) {
    const layer = bases[label];
    if (!layer || layer === current) return;
    map.removeLayer(current);
    layer.addTo(map);
    current = layer;
    Object.values(buttons).forEach(c => c.classList.remove("active"));
    buttons[label].classList.add("active");
    try { localStorage.setItem("drone-basemap", label); } catch {} // remember across reloads
  }

  Object.keys(bases).forEach(label => {
    const b = document.createElement("button");
    b.textContent = label;
    if (label === initial) b.classList.add("active");
    b.onclick = () => switchTo(label);
    seg.appendChild(b);
    buttons[label] = b;
  });

  return { switchTo };
}

/* ---------------- Layer building ---------------- */

function buildLayer(def, fc) {
  const group = L.layerGroup();
  const stash = [];
  const feats = (fc.features || []).filter(f => !def.match || def.match(f.properties));

  for (const f of feats) {
    stash.push({ feature: f, def });
    if (def.id === "airport") {
      addAirport(group, f, def);
    } else if (def.id === "helipad") {
      addHelipad(group, f, def);
    } else if (def.id === "prison") {
      addPrison(group, f, def);
    } else if (def.id === "sensitive") {
      addSensitive(group, f, def);
    } else if (f.geometry.type === "Point") {
      addPlacePoint(group, f, def);
    } else {
      const lyr = L.geoJSON(f, { style: () => styleFor(def, f.properties) });
      lyr.bindPopup(popupHtml(f, def));
      group.addLayer(lyr);
      if (def.id === "seabird") {
        const c = lyr.getBounds().getCenter();
        const icon = L.divIcon({ className: "seabird-icon", html: "🐦", iconSize: [16, 16], iconAnchor: [8, 8] });
        group.addLayer(L.marker(c, { icon, interactive: false }));
      }
    }
  }

  groups[def.id] = group;
  featuresByLayer[def.id] = stash;
  def.count = feats.length;
  if (def.on) group.addTo(map);
}

// Shared advisory/no-fly ring for point features with a radius (airport 5 km zone,
// prison advisory ring). Centralises the L.circle styling both used to duplicate.
function addAdvisoryRing(group, lat, lon, def, f, { radius, dashArray = null, weight = 1.5 }) {
  const ring = L.circle([lat, lon], {
    radius, dashArray, weight, color: def.color, fillColor: def.color, fillOpacity: 0.12,
  });
  ring.bindPopup(popupHtml(f, def));
  group.addLayer(ring);
}

function addAirport(group, f, def) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  if (p.buffer_km > 0) addAdvisoryRing(group, lat, lon, def, f, { radius: p.buffer_km * 1000 });
  // Controlled airports (with a ring) are bold; uncontrolled strips/heliports are smaller and hollow.
  const controlled = p.buffer_km > 0;
  const dot = L.circleMarker([lat, lon], {
    radius: controlled ? 5 : 3.5,
    color: controlled ? "#fff" : def.color,
    weight: 1.5,
    fillColor: controlled ? def.color : "#0f1720",
    fillOpacity: controlled ? 1 : 0.9,
  });
  dot.bindPopup(popupHtml(f, def));
  dot.bindTooltip(esc(p.name), { direction: "top", offset: [0, -6] });
  group.addLayer(dot);
}

function addHelipad(group, f, def) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const icon = L.divIcon({
    className: "helipad-icon",
    html: `<span style="--c:${def.color}">H</span>`,
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  const m = L.marker([lat, lon], { icon });
  m.bindPopup(popupHtml(f, def));
  m.bindTooltip(esc(p.name), { direction: "top", offset: [0, -9] });
  group.addLayer(m);
}

function addPrison(group, f, def) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  // Faint dashed advisory ring (no fixed legal distance — see config.prisons) plus a
  // solid marker. The ring is small (~300 m) so it only reads when zoomed in.
  addAdvisoryRing(group, lat, lon, def, f, { radius: p.advisory_m ?? 300, dashArray: "4 3", weight: 1 });
  const dot = L.circleMarker([lat, lon], {
    radius: 5, color: "#fff", weight: 1.5, fillColor: def.color, fillOpacity: 1,
  });
  dot.bindPopup(popupHtml(f, def));
  dot.bindTooltip(esc(p.name), { direction: "top", offset: [0, -6] });
  group.addLayer(dot);
}

function addSensitive(group, f, def) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const icon = L.divIcon({ className: "sensitive-icon", iconSize: [14, 14], iconAnchor: [7, 7] });
  const m = L.marker([lat, lon], { icon });
  m.bindPopup(popupHtml(f, def));
  m.bindTooltip(esc(p.name), { direction: "top", offset: [0, -8] });
  group.addLayer(m);
}

function addPlacePoint(group, f, def) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const big = p.place === "town" || p.place === "city";
  const dot = L.circleMarker([lat, lon], {
    radius: big ? 5 : 3, color: def.color, weight: 1,
    fillColor: def.color, fillOpacity: 0.6,
  });
  dot.bindTooltip(esc(p.name || p.place), { permanent: big, direction: "right", className: "place-label", offset: [6, 0] });
  dot.bindPopup(popupHtml(f, def));
  group.addLayer(dot);
}

// National parks render a deeper red than ordinary reserves (both strict no-fly).
// Single source of truth for a feature's colour, shared by styleFor and the popup.
function colorFor(def, p) {
  if (def.id === "nature" && (p.category || "").includes("nasjonalpark")) return COLORS.park;
  return def.color;
}

// A feature's display "type" line — the common base shared by the popup and the
// spot-check result so the two can't drift. Airport/helipad layer on
// context-specific detail (ICAO, "5 km zone") at each call site.
function typeLabel(def, p) {
  if (def.file === "airspace") return p.label;
  if (def.file === "nature") return p.verneform || "Protected area";
  if (def.id === "prison") return "Prison";
  if (def.id === "restriction") return "Protected-area flight ban";
  if (def.id === "sensitive") return "Military / sensitive site";
  return def.name;
}

function styleFor(def, p) {
  const fill = colorFor(def, p);
  // Strict no-fly zones (severity "nofly": restricted / danger / nature) are drawn
  // bolder & more opaque so the red reads unmistakably. TIZ are large Class-G advisory
  // zones (coordinate with AFIS, not a hard clearance) — given a lighter fill but a dark
  // amber edge for definition, so a ~30 km zone reads clearly without shouting like a 5 km
  // hard ring. A def may set `stroke`
  // (a darker outline than its fill) and/or `weight`: pale-yellow zones wash out on the
  // light basemap, so they get a dark amber edge drawn a little heavier.
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
}

/* ---------------- Popups ---------------- */

// Live nesting-ban status for a seabird feature, shown in both the popup and the
// spot-check verdict. Computed at view time from today's date (the data file is static).
function nestingStatusHtml(p) {
  if (!p.seabird) return "";
  const active = nestingActive(p.nesting_from, p.nesting_to, new Date());
  return active
    ? `<div class="pp-rule nesting nesting--on">🐦 Nesting ban ACTIVE now — closed until 31 Jul (ferdselsforbud)</div>`
    : `<div class="pp-rule nesting nesting--off">🐦 Nesting ban — dormant now (applies ~15 Apr–31 Jul)</div>`;
}

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

function popupHtml(f, def) {
  const p = f.properties;
  let type = typeLabel(def, p), extra = "";
  if (def.file === "airspace") {
    if (Number.isFinite(p.floor_m)) extra += `<div class="pp-rule">Floor: ${p.floor_m} m · Ceiling: ${fmtCeil(p.ceil_m)}</div>`;
  } else if (def.file === "nature") {
    if (p.municipality) extra += `<div class="pp-rule">${esc(p.municipality)}${p.protected_since ? " · since " + esc(p.protected_since) : ""}</div>`;
  } else if (def.id === "airport") {
    const base = p.kind === "heliport" ? "Heliport" : p.buffer_km > 0 ? "Airport" : "Uncontrolled airfield";
    type = p.icao ? `${base} · ${p.icao}` : base;
  } else if (def.id === "helipad") {
    type = p.hospital ? "Hospital helipad (HEMS)" : "Helipad";
  }
  const name = p.name || type;
  const links = [];
  if (p.regulation) links.push(`<a href="${esc(safeUrl(p.regulation))}" target="_blank" rel="noopener">Regulation ↗</a>`);
  if (p.factsheet) links.push(`<a href="${esc(safeUrl(p.factsheet))}" target="_blank" rel="noopener">Factsheet ↗</a>`);
  if (p.source) links.push(`<a href="${esc(safeUrl(p.source))}" target="_blank" rel="noopener">AIP source ↗</a>`);
  if (p.nsm_url) links.push(`<a href="${esc(safeUrl(p.nsm_url))}" target="_blank" rel="noopener">Check NSM map ↗</a>`);
  return `<h3>${esc(name)}</h3>
    <div class="pp-type">${esc(type)}</div>
    <div class="pp-rule">${esc(p.rule || "")}</div>
    ${nestingStatusHtml(p)}
    ${restrictionStatusHtml(p)}
    ${extra}
    ${links.length ? `<div class="pp-rule">${links.join(" · ")}</div>` : ""}`;
}

function fmtCeil(m) {
  if (!Number.isFinite(m)) return "—";
  return m >= 18000 ? "unlimited" : `${m} m`;
}

/* ---------------- Layer toggle UI ---------------- */

// Stamp the disclaimer with the data build date so the "may be out of date" caveat
// is concrete: airspace reflects the AIRAC cycle current on that date, and a snapshot
// older than ~28 days has likely missed a cycle. Uses the newest `generated` stamp
// across the loaded layers.
function showDataAge(data) {
  const el = document.getElementById("dataAge");
  if (!el) return;
  // The caveat names the airspace layer, so stamp it from airspace's OWN build date —
  // not the newest across layers, which would overstate freshness if airspace failed
  // to rebuild while another layer refreshed. Fall back to the OLDEST stamp so the
  // banner can never claim the data is fresher than its stalest layer.
  const stamps = Object.values(data).map(d => d?.generated).filter(Boolean).sort();
  const built = data.airspace?.generated || stamps[0];
  if (built) el.textContent = ` Data built ${built.slice(0, 10)} — airspace reflects the AIRAC cycle current then.`;
}

function buildLayerUI() {
  const root = document.getElementById("layers");
  for (const def of LAYER_DEFS) {
    const row = document.createElement("label");
    row.className = "layer" + (def.on ? "" : " off");
    row.innerHTML = `
      <span class="layer__swatch" style="background:${def.on ? def.color : "transparent"};border-color:${def.color}"></span>
      <span class="layer__name">${def.name}</span>
      <span class="layer__count">${def.count}</span>
      <input type="checkbox" ${def.on ? "checked" : ""} />`;
    const cb = row.querySelector("input");
    cb.onchange = () => {
      if (cb.checked) { groups[def.id].addTo(map); row.classList.remove("off"); row.querySelector(".layer__swatch").style.background = def.color; }
      else { map.removeLayer(groups[def.id]); row.classList.add("off"); row.querySelector(".layer__swatch").style.background = "transparent"; }
    };
    root.appendChild(row);
  }
}

/* ---------------- Spot check ---------------- */

function wireControls() {
  const panel = document.getElementById("panel");
  const panelToggle = document.getElementById("panelToggle");
  const checkBtn = document.getElementById("checkBtn");
  const pickHint = document.getElementById("pickHint");
  // Re-checked at each interaction rather than via a resize listener: a real phone
  // never crosses this breakpoint mid-session, and re-running the initial collapse on
  // resize would fight a user who deliberately expanded/collapsed the panel.
  const isMobile = () => window.matchMedia("(max-width: 640px)").matches;

  // The hint stands in for the (hidden) armed check button whenever the panel is
  // collapsed — on phones that's the only cue that the next map tap is a query.
  const updatePickHint = () =>
    pickHint.classList.toggle("pickhint--hidden", !(pickMode && panel.classList.contains("collapsed")));

  function setCollapsed(collapsed) {
    panel.classList.toggle("collapsed", collapsed);
    panelToggle.textContent = collapsed ? "+" : "–";
    const label = collapsed ? "Show controls" : "Collapse panel";
    panelToggle.setAttribute("aria-label", label);
    panelToggle.title = label;
    updatePickHint();
  }
  panelToggle.onclick = () => setCollapsed(!panel.classList.contains("collapsed"));

  function setPick(on) {
    pickMode = on;
    checkBtn.classList.toggle("active", on);
    map.getContainer().style.cursor = on ? "crosshair" : "";
    // On phones the expanded panel covers the whole map, so arming "Can I fly here?"
    // must also get the panel out of the way — otherwise there is nothing to tap.
    if (on && isMobile()) setCollapsed(true);
    else updatePickHint();
  }
  checkBtn.onclick = () => setPick(!pickMode);
  document.getElementById("pickHintCancel").onclick = () => setPick(false);
  // Locating is a complete action — disarm "Can I fly here?" so the map isn't left
  // armed (crosshair + hint) after the verdict appears.
  document.getElementById("locateBtn").onclick = () => { setPick(false); locateMe(); };

  // "Click" is a desktop verb; touch devices tap.
  if (window.matchMedia("(pointer: coarse)").matches) {
    const em = checkBtn.querySelector("em");
    if (em) em.textContent = "Tap the map";
  }

  // Only analyse when the user has explicitly armed "Can I fly here?" — otherwise
  // a click is just panning/exploring and must NOT produce an unsolicited verdict.
  map.on("click", e => { if (pickMode) { locateSeq++; analyzePoint(e.latlng); } });

  // A click that lands on a zone/marker opens that feature's popup and never reaches
  // the map-level handler above — so on a zone-dense map the verdict would only ever
  // fire over empty water. While armed, suppress the popup and analyse its point instead.
  map.on("popupopen", e => {
    if (!pickMode) return;
    locateSeq++;
    const latlng = e.popup.getLatLng();
    map.closePopup(e.popup);
    analyzePoint(latlng);
  });

  // A deliberate drag abandons any pending "locate me" too. `dragstart` fires only on a
  // pointer drag — not on the programmatic setView that locating itself performs (so it
  // won't self-invalidate), and not on zoom/keyboard-pan, which usually mean "show me this
  // fix better" and are fine to let the incoming fix recentre.
  map.on("dragstart", () => { locateSeq++; });

  document.getElementById("resultClose").onclick = () => {
    document.getElementById("result").classList.add("result--hidden");
    if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
    if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
  };

  // Start collapsed on phones so the map — not a wall of controls — is what loads.
  if (isMobile()) setCollapsed(true);

  // Modals (rules + glossary) share focus/inert handling for keyboard & AT users.
  wireModal("rulesBtn", "rulesModal", "rulesClose");
  wireModal("glossaryBtn", "glossaryModal", "glossaryClose");
}

// Wire a modal dialog: open/close, backdrop click, Escape, focus management,
// and mark the rest of the page inert so `aria-modal` is honest.
function wireModal(btnId, modalId, closeId) {
  const modal = document.getElementById(modalId);
  const btn = document.getElementById(btnId);
  const closeBtn = document.getElementById(closeId);
  const bg = ["panel", "result", "map", "pickHint", "locateBtn"].map(id => document.getElementById(id)).filter(Boolean);
  const open = () => { bg.forEach(el => el.setAttribute("inert", "")); modal.classList.remove("modal--hidden"); closeBtn.focus(); };
  const close = () => { modal.classList.add("modal--hidden"); bg.forEach(el => el.removeAttribute("inert")); btn.focus(); };
  btn.onclick = open;
  closeBtn.onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  // Bind Escape on document, not the modal: a click on non-focusable modal content
  // moves focus out of the modal subtree, after which a modal-scoped keydown never fires.
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal.classList.contains("modal--hidden")) close(); });
}

function analyzePoint(latlng) {
  const { lat, lng } = latlng;
  const hits = [];
  let nearest = null; // closest blocking restriction the point is NOT inside

  for (const def of LAYER_DEFS) {
    for (const { feature: f } of featuresByLayer[def.id]) {
      const p = f.properties;
      if (featureContains(lat, lng, def, f)) { hits.push({ def, p, f }); continue; }
      // Nearest readout only needs blocking layers; skip the polygon math otherwise.
      if (def.blocking) {
        const np = nearestPointOnFeature(lat, lng, def, f);
        if (np && isFinite(np.distM) && (!nearest || np.distM < nearest.distM)) {
          // Bear to the ACTUAL nearest boundary point, not the centroid.
          nearest = { def, p, f, distM: np.distM, bearing: bearingTo(lat, lng, [np.lat, np.lon]) };
        }
      }
    }
  }

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

  if (pickMarker) map.removeLayer(pickMarker);
  // A GPS accuracy ring belongs only to a located point — clear it on every (re)analyze.
  if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
  pickMarker = L.circleMarker(latlng, { radius: 7, color: "#fff", weight: 2, fillColor: "#4ea1ff", fillOpacity: 1 }).addTo(map);

  renderResult(latlng, hits, nearest, nearestSensitive);
}

// "Locate me" — one-shot GPS fix → centre, mark, and run the spot check for where
// you're standing. The coordinates are used in place and never stored or sent:
// there is no backend, and nothing here writes to storage or the network.
function locateMe() {
  const btn = document.getElementById("locateBtn");
  // Always clears the spinner so the button can never get stuck disabled.
  const fail = msg => {
    btn.classList.remove("locating");
    showResultMessage(`<div class="verdict permission"><span class="verdict__dot"></span>Couldn't get your location</div>
      <div class="hit__rule">${esc(msg)}</div>`);
  };
  if (!navigator.geolocation) {
    fail(`This device can't share its location. Tap "Can I fly here?" and pick a spot on the map instead.`);
    return;
  }
  btn.classList.add("locating");
  // Claim this request. Any user pan/pick before the fix lands bumps locateSeq, after
  // which this fix is stale and must not touch the map. The button is inert while
  // locating, so a second locate can't race us — only a map interaction invalidates.
  const myToken = ++locateSeq;
  try {
    navigator.geolocation.getCurrentPosition(
      pos => {
        btn.classList.remove("locating");
        // Stale fix: the user panned or picked a spot while we waited. Honour their
        // current view/verdict instead of yanking the map back to where they were.
        if (myToken !== locateSeq) return;
        const { latitude, longitude, accuracy } = pos.coords;
        const latlng = L.latLng(latitude, longitude);
        // Coverage guard: keep verdicts inside the region the app is built for. The
        // curated layers (nature, populated, airports, helipads) and the basemap focus
        // only cover it, and setView clamps to maxBounds so an out-of-region marker would
        // sit off-screen. Refuse a verdict for the out-of-region case and say why.
        if (map.options.maxBounds && !map.options.maxBounds.contains(latlng)) {
          showResultMessage(`<div class="verdict permission"><span class="verdict__dot"></span>You're outside the mapped area</div>
            <div class="hit__rule">${esc(`This map only covers ${config.region.name}, so it can't give a verdict for where you are (±${Math.round(accuracy)} m from GPS). Wherever you fly, the standard rules still apply: max 120 m above the surface, keep clear of people, and check NOTAMs.`)}</div>`);
          return;
        }
        map.setView(latlng, Math.max(map.getZoom(), 13));
        analyzePoint(latlng); // drops the marker + renders the verdict (and clears any stale ring)
        accuracyCircle = L.circle(latlng, {
          radius: accuracy, color: "#4ea1ff", weight: 1, fillColor: "#4ea1ff", fillOpacity: 0.1,
          interactive: false, // a purely visual ring — don't let it swallow clicks on zones beneath it
        }).addTo(map);
        // Honest note: the coordinates never leave the page, but map tiles for this area
        // are still fetched from the basemap provider (none if Norway is saved offline).
        document.getElementById("resultBody").insertAdjacentHTML("beforeend",
          `<div class="hit__rule">📍 GPS fix, ±${Math.round(accuracy)} m. Your coordinates aren't uploaded or saved — map tiles for this area still load from the map provider, unless you've saved the Norway map offline.</div>`);
      },
      err => {
        // Stale error: the user moved on while we waited — clear the spinner but don't
        // overwrite their current verdict with a "couldn't locate" message.
        if (myToken !== locateSeq) { btn.classList.remove("locating"); return; }
        fail(
          err.code === err.PERMISSION_DENIED
            ? "Location permission is off. Allow it in your browser settings, or tap the map to pick a spot."
            : err.code === err.TIMEOUT
            ? "Location is taking too long — try again outdoors, or tap the map to pick a spot."
            : "Couldn't get a location fix — try again outdoors, or tap the map to pick a spot."
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  } catch {
    // Some engines throw synchronously when geolocation is blocked by permissions policy.
    fail("Couldn't access location on this device. Tap the map to pick a spot instead.");
  }
}

// Show a one-off message (e.g. a geolocation error) in the result panel, clearing
// any spot-check markers so a stale dot doesn't imply a real verdict.
function showResultMessage(html) {
  if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
  if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }
  document.getElementById("resultBody").innerHTML = html;
  document.getElementById("result").classList.remove("result--hidden");
}

function renderResult(latlng, hits, nearest, nearestSensitive) {
  const body = document.getElementById("resultBody");
  // Context-only hits do NOT legally block a drone flown at/below 120 m:
  //  - "controlled" = high-altitude TMA/CTA (floor above the drone ceiling)
  //  - "populated"  = built-up area (a behavioural rule, not a geofence)
  //  - "airsport"   = shared-airspace hazard (caution, not a ban)
  const blocking = hits.filter(h => h.def.blocking);
  const context = hits.filter(h => !h.def.blocking);

  // The headline reflects the WORST severity present, not a flat "blocked vs clear":
  // a hard no-fly (restricted / danger / nature) reads red, while a permission-only
  // hit (airport / CTR / TIZ — you may fly once cleared) reads orange. This matches
  // the zone colours and glossary badges instead of alarming red for every zone.
  const noFly = blocking.filter(h => h.def.severity === "nofly");
  const count = blocking.length, plural = count > 1 ? "s" : "";
  const verdict = !count
    ? `<div class="verdict clear"><span class="verdict__dot"></span>No drone restriction at ≤120 m</div>`
    : noFly.length
    ? `<div class="verdict blocked"><span class="verdict__dot"></span>${count} restriction${plural} here</div>`
    : `<div class="verdict permission"><span class="verdict__dot"></span>Permission needed — ${count} zone${plural} here</div>`;

  const renderHit = h => {
    const color = colorFor(h.def, h.p);
    let type = typeLabel(h.def, h.p);
    if (h.def.id === "airport") type = h.p.buffer_km > 0 ? "Airport · 5 km zone" : type;
    const reg = h.p.regulation ? ` <a href="${esc(safeUrl(h.p.regulation))}" target="_blank" rel="noopener">regulation ↗</a>` : "";
    const alt = h.def.file === "airspace" && Number.isFinite(h.p.floor_m) ? ` (floor ${h.p.floor_m} m)` : "";
    return `<div class="hit">
      <div class="hit__top"><span class="hit__chip" style="background:${color}"></span>
        <span class="hit__name">${esc(h.p.name || type)}</span></div>
      <div class="hit__type">${esc(type)}${alt}</div>
      <div class="hit__rule">${esc(h.p.rule || "")}${reg}</div>
      ${nestingStatusHtml(h.p)}
      ${restrictionStatusHtml(h.p)}
    </div>`;
  };

  const blockHtml = blocking.map(renderHit).join("");

  // Only show the margin-to-nearest readout when the point is otherwise clear.
  const nearestHtml = (!blocking.length && nearest)
    ? `<div class="nearest">Nearest restriction: <strong>${esc(nearest.p.name || nearest.def.name)}</strong> — ${fmtDist(nearest.distM)} ${nearest.bearing}</div>`
    : "";

  // Advisory — independent of the verdict (a sensor-ban can apply even on an
  // otherwise-clear spot). Never a no-fly; always routes to NSM's own map.
  const sensitiveHtml = nearestSensitive
    ? `<div class="nearest nearest--sensitive">⚠️ Nearest military / sensitive site:
        <strong>${esc(nearestSensitive.p.name)}</strong> — ${fmtDist(nearestSensitive.distM)} ${nearestSensitive.bearing}.
        Photo/sensor bans may apply nearby —
        <a href="${esc(safeUrl(nearestSensitive.p.nsm_url))}" target="_blank" rel="noopener">check NSM map ↗</a>.</div>`
    : "";

  const clearNote = !blocking.length
    ? `<div class="hit__rule">No airport/control/traffic zone, restricted or danger area, protected area, or prison covers this point at drone altitude. Standard rules still apply: max 120 m above the surface, keep clear of people, check NOTAMs.</div>
       <div class="hit__rule wildlife">🐦 Wildlife rule (everywhere, even here): under <em>naturmangfoldloven §15</em> you must not disturb wildlife — especially nesting birds. Don't fly low over animals, flocks or nests.</div>`
    : "";
  const contextHtml = context.length
    ? `<div class="hit__section">Context / advisory (not a no-fly below 120 m)</div>` + context.map(renderHit).join("")
    : "";

  body.innerHTML = verdict + blockHtml + nearestHtml + sensitiveHtml + clearNote + contextHtml +
    `<div class="coords">${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}</div>`;
  document.getElementById("result").classList.remove("result--hidden");
}

/* ---------------- Presentation helpers ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Only allow http(s) links from external data — blocks javascript:/data: URIs.
function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    return /^https?:$/.test(url.protocol) ? url.href : "#";
  } catch { return "#"; }
}
