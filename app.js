/* Drone Zones — Lofoten / Bodø / Narvik
   Loads local GeoJSON layers, renders them on a Leaflet map, and answers
   "can I fly at this point?" via point-in-polygon / distance checks. */

const COLORS = {
  airport: "#ff3b30",
  ctr: "#ff9500",
  restricted: "#c026d3",
  danger: "#ff2d55",
  exercise: "#9a6fb0",
  airsport: "#ffd60a",
  helipad: "#00c2d1",
  controlled: "#8aa0b6",
  reserve: "#34c759",
  park: "#0a7d3c",
  populated: "#4d8fd6",
};

// Layer definitions: how each is sourced from the data files, styled, and labelled.
// `blocking` = a legal/physical no-fly that should drive the "restricted" verdict;
// non-blocking layers are context/advisory only.
const LAYER_DEFS = [
  { id: "airport", name: "Airport 5 km no-fly", color: COLORS.airport, on: true, file: "airports", blocking: true },
  { id: "ctr", name: "Control & traffic zones (CTR/TIZ)", color: COLORS.ctr, on: true, file: "airspace", match: p => p.category === "ctr" || p.category === "tiz", blocking: true },
  { id: "restricted", name: "Restricted areas", color: COLORS.restricted, on: true, file: "airspace", match: p => p.category === "restricted", blocking: true },
  { id: "danger", name: "Danger areas (firing/military)", color: COLORS.danger, on: true, file: "airspace", match: p => p.category === "danger", dashed: true, blocking: true },
  { id: "exercise", name: "Military exercise areas (NOTAM)", color: COLORS.exercise, on: true, file: "airspace", match: p => p.category === "exercise", dashed: true, blocking: false },
  { id: "nature", name: "Nature reserves & parks", color: COLORS.reserve, on: true, file: "nature", blocking: true },
  { id: "helipad", name: "Hospital / HEMS helipads", color: COLORS.helipad, on: true, file: "helipads", blocking: false },
  { id: "airsport", name: "Air sports areas", color: COLORS.airsport, on: false, file: "airspace", match: p => p.category === "airsport", blocking: false },
  { id: "populated", name: "Populated areas", color: COLORS.populated, on: false, file: "populated", blocking: false },
  { id: "controlled", name: "Controlled airspace (high)", color: COLORS.controlled, on: false, file: "airspace", match: p => p.category === "controlled", blocking: false },
];

let map, config;
const groups = {};          // id -> L.layerGroup
const featuresByLayer = {}; // id -> [{feature, def}] for spot-check
let pickMode = false;
let pickMarker = null;

init();

async function init() {
  config = await (await fetch("config.json")).json();
  const { center, zoom, bbox } = config.region;

  map = L.map("map", {
    center, zoom, zoomControl: true,
    maxBounds: [[bbox[1] - 1.5, bbox[0] - 3], [bbox[3] + 1.5, bbox[2] + 3]],
    maxBoundsViscosity: 0.6,
  });

  setupBasemaps();
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

  // Load all data files in parallel.
  const files = ["airports", "airspace", "nature", "populated", "helipads"];
  const data = {};
  await Promise.all(files.map(async f => {
    try { data[f] = await (await fetch(`data/${f}.geojson`)).json(); }
    catch { data[f] = { features: [] }; }
  }));

  for (const def of LAYER_DEFS) buildLayer(def, data[def.file]);
  buildLayerUI();
  wireControls();

  document.getElementById("loading").classList.add("done");
}

/* ---------------- Basemaps ---------------- */

function setupBasemaps() {
  const bases = {
    Map: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "© OpenStreetMap · airspace luftrom.info · vern Miljødirektoratet",
    }),
    Topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17, attribution: "© OpenTopoMap (CC-BY-SA) · OpenStreetMap",
    }),
    Satellite: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 18, attribution: "© Esri World Imagery",
    }),
  };
  bases.Map.addTo(map);
  const seg = document.getElementById("basemaps");
  let current = bases.Map;
  Object.entries(bases).forEach(([label, layer], i) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (i === 0) b.classList.add("active");
    b.onclick = () => {
      if (layer === current) return;
      map.removeLayer(current);
      layer.addTo(map);
      current = layer;
      [...seg.children].forEach(c => c.classList.remove("active"));
      b.classList.add("active");
    };
    seg.appendChild(b);
  });
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
    } else if (f.geometry.type === "Point") {
      addPlacePoint(group, f, def);
    } else {
      const lyr = L.geoJSON(f, { style: () => styleFor(def, f.properties) });
      lyr.bindPopup(popupHtml(f, def));
      group.addLayer(lyr);
    }
  }

  groups[def.id] = group;
  featuresByLayer[def.id] = stash;
  def.count = feats.length;
  if (def.on) group.addTo(map);
}

function addAirport(group, f, def) {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  if (p.buffer_km > 0) {
    const ring = L.circle([lat, lon], {
      radius: p.buffer_km * 1000,
      color: def.color, weight: 1.5, fillColor: def.color, fillOpacity: 0.12,
    });
    ring.bindPopup(popupHtml(f, def));
    group.addLayer(ring);
  }
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
  dot.bindTooltip(p.name, { direction: "top", offset: [0, -6] });
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
  m.bindTooltip(p.name, { direction: "top", offset: [0, -9] });
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
  dot.bindTooltip(p.name || p.place, { permanent: big, direction: "right", className: "place-label", offset: [6, 0] });
  dot.bindPopup(popupHtml(f, def));
  group.addLayer(dot);
}

function styleFor(def, p) {
  // National parks get a deeper green than ordinary reserves.
  let color = def.color, fillColor = def.color;
  if (def.id === "nature" && (p.category || "").includes("nasjonalpark")) {
    color = COLORS.park; fillColor = COLORS.park;
  }
  return {
    color, fillColor,
    weight: 1.5,
    fillOpacity: def.id === "exercise" ? 0.06 : def.id === "populated" ? 0.18 : 0.16,
    dashArray: def.dashed ? "6 4" : null,
  };
}

/* ---------------- Popups ---------------- */

function popupHtml(f, def) {
  const p = f.properties;
  let type = def.name, extra = "";
  if (def.file === "airspace") {
    type = p.label;
    if (isFinite(p.floor_m)) extra += `<div class="pp-rule">Floor: ${p.floor_m} m · Ceiling: ${fmtCeil(p.ceil_m)}</div>`;
  } else if (def.file === "nature") {
    type = p.verneform || "Protected area";
    if (p.municipality) extra += `<div class="pp-rule">${p.municipality}${p.protected_since ? " · since " + p.protected_since : ""}</div>`;
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
  return `<h3>${esc(name)}</h3>
    <div class="pp-type">${esc(type)}</div>
    <div class="pp-rule">${esc(p.rule || "")}</div>
    ${extra}
    ${links.length ? `<div class="pp-rule">${links.join(" · ")}</div>` : ""}`;
}

function fmtCeil(m) {
  if (!isFinite(m)) return "—";
  return m >= 18000 ? "unlimited" : `${m} m`;
}

/* ---------------- Layer toggle UI ---------------- */

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
  const checkBtn = document.getElementById("checkBtn");
  checkBtn.onclick = () => {
    pickMode = !pickMode;
    checkBtn.classList.toggle("active", pickMode);
    map.getContainer().style.cursor = pickMode ? "crosshair" : "";
  };

  // Only analyse when the user has explicitly armed "Can I fly here?" — otherwise
  // a click is just panning/exploring and must NOT produce an unsolicited verdict.
  map.on("click", e => { if (pickMode) analyzePoint(e.latlng); });

  document.getElementById("resultClose").onclick = () => {
    document.getElementById("result").classList.add("result--hidden");
    if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
  };

  const panel = document.getElementById("panel");
  document.getElementById("panelToggle").onclick = () => {
    panel.classList.toggle("collapsed");
    document.getElementById("panelToggle").textContent = panel.classList.contains("collapsed") ? "+" : "–";
  };

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
  const bg = ["panel", "result", "map"].map(id => document.getElementById(id)).filter(Boolean);
  const open = () => { bg.forEach(el => el.setAttribute("inert", "")); modal.classList.remove("modal--hidden"); closeBtn.focus(); };
  const close = () => { modal.classList.add("modal--hidden"); bg.forEach(el => el.removeAttribute("inert")); btn.focus(); };
  btn.onclick = open;
  closeBtn.onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  modal.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
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

  if (pickMarker) map.removeLayer(pickMarker);
  pickMarker = L.circleMarker(latlng, { radius: 7, color: "#fff", weight: 2, fillColor: "#4ea1ff", fillOpacity: 1 }).addTo(map);

  renderResult(latlng, hits, nearest);
}

function renderResult(latlng, hits, nearest) {
  const body = document.getElementById("resultBody");
  // Context-only hits do NOT legally block a drone flown at/below 120 m:
  //  - "controlled" = high-altitude TMA/CTA (floor above the drone ceiling)
  //  - "populated"  = built-up area (a behavioural rule, not a geofence)
  //  - "airsport"   = shared-airspace hazard (caution, not a ban)
  const blocking = hits.filter(h => h.def.blocking);
  const context = hits.filter(h => !h.def.blocking);

  const verdict = blocking.length
    ? `<div class="verdict blocked"><span class="verdict__dot"></span>${blocking.length} restriction${blocking.length > 1 ? "s" : ""} here</div>`
    : `<div class="verdict clear"><span class="verdict__dot"></span>No drone restriction at ≤120 m</div>`;

  const renderHit = h => {
    const color = (h.def.id === "nature" && (h.p.category || "").includes("nasjonalpark")) ? COLORS.park : h.def.color;
    let type = h.def.file === "airspace" ? h.p.label : h.def.file === "nature" ? (h.p.verneform || "Protected area") : h.def.name;
    if (h.def.id === "airport") type = h.p.buffer_km > 0 ? "Airport · 5 km zone" : type;
    const reg = h.p.regulation ? ` <a href="${esc(safeUrl(h.p.regulation))}" target="_blank" rel="noopener">regulation ↗</a>` : "";
    const alt = h.def.file === "airspace" && isFinite(h.p.floor_m) ? ` (floor ${h.p.floor_m} m)` : "";
    return `<div class="hit">
      <div class="hit__top"><span class="hit__chip" style="background:${color}"></span>
        <span class="hit__name">${esc(h.p.name || type)}</span></div>
      <div class="hit__type">${esc(type)}${alt}</div>
      <div class="hit__rule">${esc(h.p.rule || "")}${reg}</div>
    </div>`;
  };

  const blockHtml = blocking.map(renderHit).join("");

  // Only show the margin-to-nearest readout when the point is otherwise clear.
  const nearestHtml = (!blocking.length && nearest)
    ? `<div class="nearest">Nearest no-fly: <strong>${esc(nearest.p.name || nearest.def.name)}</strong> — ${fmtDist(nearest.distM)} ${nearest.bearing}</div>`
    : "";

  const clearNote = !blocking.length
    ? `<div class="hit__rule">No airport/control/traffic zone, restricted or danger area, or protected area covers this point at drone altitude. Standard rules still apply: max 120 m above the surface, keep clear of people, check NOTAMs.</div>
       <div class="hit__rule wildlife">🐦 Wildlife rule (everywhere, even here): under <em>naturmangfoldloven §15</em> you must not disturb wildlife — especially nesting birds. Don't fly low over animals, flocks or nests.</div>`
    : "";
  const contextHtml = context.length
    ? `<div class="hit__section">Context / advisory (not a no-fly below 120 m)</div>` + context.map(renderHit).join("")
    : "";

  body.innerHTML = verdict + blockHtml + nearestHtml + clearNote + contextHtml +
    `<div class="coords">${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}</div>`;
  document.getElementById("result").classList.remove("result--hidden");
}

/* ---------------- Geometry math ---------------- */

function pointInGeom(x, y, geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (pointInRing(x, y, poly[0])) {
      let inHole = false;
      for (let k = 1; k < poly.length; k++) if (pointInRing(x, y, poly[k])) { inHole = true; break; }
      if (!inHole) return true;
    }
  }
  return false;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Does the feature contain the point? (airport ring = within radius; polygon =
// point-in-polygon; markers/points have no area.)
function featureContains(lat, lng, def, f) {
  if (def.id === "airport") {
    if (f.properties.buffer_km > 0) {
      const [flon, flat] = f.geometry.coordinates;
      return haversine(lat, lng, flat, flon) <= f.properties.buffer_km * 1000;
    }
    return false;
  }
  if (def.id === "helipad") {
    // 1 km advisory caution radius so an on/near-pad click surfaces HEMS traffic
    // (non-blocking — appears under "Context / advisory").
    const [flon, flat] = f.geometry.coordinates;
    return haversine(lat, lng, flat, flon) <= 1000;
  }
  if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
    return pointInGeom(lng, lat, f.geometry);
  }
  return false;
}

// Nearest boundary point of a feature the click is OUTSIDE of, as
// { distM, lat, lon } — so distance AND bearing use the same point.
// Returns null for features with no usable area.
function nearestPointOnFeature(lat, lng, def, f) {
  if (def.id === "airport") {
    if (f.properties.buffer_km > 0) {
      const [flon, flat] = f.geometry.coordinates;
      const d = Math.max(0, haversine(lat, lng, flat, flon) - f.properties.buffer_km * 1000);
      // For a circle, the nearest ring point lies toward the centre, so bearing
      // to the centre IS the bearing to the nearest edge point.
      return { distM: d, lat: flat, lon: flon };
    }
    return null;
  }
  if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
    return minEdgePoint(lat, lng, f.geometry);
  }
  return null;
}

function minEdgePoint(lat, lng, geom) {
  // Local equirectangular projection consistent with haversine's spherical Earth
  // (R = 6 371 000 m → 111 195 m per degree), accurate for short edge distances.
  const M = 111195, cosLat = Math.cos(lat * Math.PI / 180);
  const toM = (lo, la) => [lo * cosLat * M, la * M];
  const [px, py] = toM(lng, lat);
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let min = Infinity, bestX = lng, bestY = lat;
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = toM(ring[i][0], ring[i][1]);
      const [bx, by] = toM(ring[i + 1][0], ring[i + 1][1]);
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(px - qx, py - qy);
      if (d < min) { min = d; bestX = qx / (cosLat * M); bestY = qy / M; }
    }
  }
  return { distM: min, lat: bestY, lon: bestX };
}

function bearingTo(lat, lng, [rlat, rlon]) {
  const dLon = (rlon - lng) * Math.cos(lat * Math.PI / 180);
  const ang = (Math.atan2(dLon, rlat - lat) * 180 / Math.PI + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(ang / 45) % 8];
}

function fmtDist(m) { return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }

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
