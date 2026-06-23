#!/usr/bin/env node
// Drone restriction data pipeline for the Lofoten / Bodø / Narvik region.
// Fetches from four keyless public sources, normalizes, clips to the region
// bbox, and writes one GeoJSON file per restriction layer into ../data/.
//
// Run:  node scripts/build-data.mjs
// Requires Node 18+ (uses global fetch). No npm dependencies.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "data");

const config = JSON.parse(await readFile(join(ROOT, "config.json"), "utf8"));
const [W, S, E, N] = config.region.bbox;
const SRC = config.sources;

// ---------- geometry helpers ----------

function geometryBbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else for (const x of c) walk(x);
  };
  walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

function bboxIntersectsRegion([x0, y0, x1, y1]) {
  return !(x1 < W || x0 > E || y1 < S || y0 > N);
}

// Dedup key for OSM features that come back as both a node and an enclosing way/relation
// for the same site: snap to a ~0.001° grid (~110 m N–S, ~45 m E–W at this latitude) so
// the duplicate pair collapses to one feature. Shared by the helipad and prison builds.
const gridKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

// ---------- output helpers ----------

function fc(features) {
  return {
    type: "FeatureCollection",
    generated: new Date().toISOString(),
    features,
  };
}

async function save(name, features, label) {
  await writeFile(join(DATA, name), JSON.stringify(fc(features)));
  console.log(`  ✓ ${label}: ${features.length} features -> data/${name}`);
}

// ---------- CSV parser (handles quoted fields) ----------

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header) throw new Error("empty or invalid CSV (no header row)");
  return rows.filter(r => r.length === header.length)
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// ---------- 1. Airports + 5 km no-fly rings ----------

async function buildAirports() {
  const csv = parseCsv(await (await fetch(SRC.airports_csv)).text());
  const ringTypes = new Set(config.airports.ring_types);
  const markerTypes = new Set(config.airports.marker_types);
  const km = config.airports.buffer_km;
  // Capture airports a little beyond the display bbox so a field whose airspace
  // already intrudes (e.g. Bardufoss, just east of E) still gets a marker + ring.
  const m = config.airports.capture_margin_deg ?? 0;
  const features = [];
  for (const a of csv) {
    if (a.iso_country !== "NO") continue;
    if (!markerTypes.has(a.type)) continue;
    const lon = parseFloat(a.longitude_deg), lat = parseFloat(a.latitude_deg);
    if (!isFinite(lon) || !isFinite(lat)) continue;
    if (lon < W - m || lon > E + m || lat < S - m || lat > N + m) continue;

    const scheduled = a.scheduled_service === "yes";
    const isHeliport = a.type === "heliport";
    // The official 5 km + ATC rule applies to airports with an air traffic
    // service. Only ring airports (not heliports) that have scheduled service.
    const isRing = ringTypes.has(a.type) && scheduled;

    let rule;
    if (isRing) {
      rule = `No drone flights within ${km} km without permission from the air traffic service (Luftfartstilsynet rule). Larger airports here also have a control zone (CTR) — see that layer.`;
    } else if (isHeliport) {
      rule = scheduled
        ? "Heliport with scheduled helicopter service — expect regular, sometimes low rotorcraft traffic. Keep well clear."
        : "Heliport — keep clear; helicopter traffic and local restrictions may apply. The 5 km airport rule does not formally apply, but stay well clear.";
    } else {
      rule = "Uncontrolled airfield — no scheduled air traffic service. The 5 km airport rule may not formally apply here, but keep well clear of any local flight activity.";
    }

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        layer: "airport",
        name: a.name,
        kind: a.type,
        controlled: isRing,
        scheduled,
        icao: a.icao_code || a.gps_code || "",
        iata: a.iata_code || "",
        municipality: a.municipality || "",
        buffer_km: isRing ? km : 0,
        rule,
      },
    });
  }
  await save("airports.geojson", features, "Airports");
}

// ---------- 2. Airspace (CTR / restricted / danger) ----------

// luftrom.info "class" values map to AIP airspace structures verified against the
// current Avinor AIP (AIRAC 2026-06-11): D = control zones (CTR), G = AFIS traffic
// information zones (TIZ), R = restricted (ENR 5.1), Q = danger/military exercise
// areas (ENR 5.1 / 5.2), Luftsport = air-sports areas (ENR 5.5), C = TMA/CTA.
const CLASS_META = {
  D: { category: "ctr", label: "Control Zone (CTR)",
       rule: "Airport control zone, from ground level. Drone flight requires clearance from air traffic control." },
  G: { category: "tiz", label: "Traffic Information Zone (TIZ)",
       rule: "Airport traffic information zone (AFIS), from ground level. Coordinate with the airport's information service before flying." },
  R: { category: "restricted", label: "Restricted Area",
       rule: "Restricted airspace (AIP ENR 5.1). Flight restricted or prohibited — verify the regulation before flying." },
  Q: { category: "danger", label: "Danger Area",
       rule: "Danger area — military / hazardous activity, e.g. firing or rocket launches (AIP ENR 5.1). Active only at certain times; check NOTAM/AIP for activation before flying." },
  Luftsport: { category: "airsport", label: "Air sports area",
       rule: "Air-sports area (AIP ENR 5.5) — paragliders, hang-gliders, parachutists or GA may share this airspace. A hazard, not a legal ban: check for activity and keep clear." },
  C: { category: "controlled", label: "Controlled airspace (TMA/CTA)",
       rule: "Controlled airspace, high floor — context only, generally above the 120 m drone ceiling." },
};

async function buildAirspace() {
  const data = await (await fetch(SRC.airspace_geojson)).json();
  const floorMax = config.airspace.drone_floor_max_m;
  const droneClasses = new Set(config.airspace.drone_relevant_classes);
  const contextClasses = new Set(config.airspace.context_classes);
  const features = [];
  for (const f of data.features) {
    const cls = f.properties.class;
    const name = f.properties.name || "";
    if (!droneClasses.has(cls) && !contextClasses.has(cls)) continue;
    // Class G is generic uncontrolled airspace; only the named TIZ entries are
    // drone-relevant restrictions. Skip any other class-G airspace.
    if (cls === "G" && !/\bTIZ\b/i.test(name)) continue;
    if (!bboxIntersectsRegion(geometryBbox(f.geometry))) continue;
    const floor = Number(f.properties["from (m amsl)"]);
    const meta = CLASS_META[cls];
    // A drone-relevant class is treated as a real no-fly when it reaches low
    // altitude. If the floor is unknown, keep it blocking (the safe direction).
    // A drone class that is PURELY high-altitude is NOT dropped — it is kept as
    // non-blocking context so a zone can never silently vanish from the map.
    const lowEnough = !isFinite(floor) || floor <= floorMax;
    const droneRelevant = droneClasses.has(cls) && lowEnough;
    const src = f.properties.source_href || "";
    // Class Q from AIP ENR 5.2 = large MILITARY EXERCISE/TRAINING areas, which are
    // active only when activated by NOTAM (not a permanent no-fly). Split them out
    // from the always-relevant ENR 5.1 danger areas (firing ranges etc.).
    const isExercise = cls === "Q" && /ENR-5\.2/.test(src);
    const category = !droneRelevant ? "controlled" : isExercise ? "exercise" : meta.category;
    const label = !droneRelevant ? (cls === "C" ? CLASS_META.C.label : `${meta.label} (high altitude)`)
      : isExercise ? "Military exercise area" : meta.label;
    const rule = !droneRelevant ? CLASS_META.C.rule
      : isExercise ? "Large military exercise/training area (AIP ENR 5.2). Active ONLY during exercises and announced by NOTAM — not a permanent no-fly, but keep out when it is active. Always check NOTAM before flying."
      : meta.rule;
    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        layer: "airspace",
        category,
        airclass: cls,
        label,
        name,
        floor_m: floor,
        ceil_m: Number(f.properties["to (m amsl)"]),
        rule,
        source: src,
      },
    });
  }
  await save("airspace.geojson", features, "Airspace");
}

// ---------- 3. Nature reserves & national parks ----------

// Rule text tiered by protection type (verified against Miljødirektoratet /
// Lovdata). There is NO high-altitude exemption — bans cover the whole air column.
function natureRule(cat, seasonal) {
  const season = seasonal
    ? " Seasonal: bird/seabird reserves have a strict access ban (ferdselsforbud), typically 15 Apr–31 Jul (some to 15 Aug) during nesting — stay out and do not fly."
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

async function buildNature() {
  const features = [];
  const seenIds = new Set();
  let offset = 0;
  const page = 1000;
  for (;;) {
    const params = new URLSearchParams({
      where: "1=1",
      geometry: `${W},${S},${E},${N}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326", outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "naturvernId,navn,offisieltNavn,verneform,verneformAggregert,kommune,verneforskrift,faktaark,vernedato,forvaltningsmyndighet,iucn",
      f: "geojson",
      // Simplify server-side: ~10 m tolerance + 6-decimal precision. Keeps
      // boundaries tight for planning while cutting the payload ~10x.
      maxAllowableOffset: "0.0001",
      geometryPrecision: "6",
      resultOffset: String(offset),
      resultRecordCount: String(page),
    });
    const data = await (await fetch(`${SRC.nature_arcgis}?${params}`)).json();
    const batch = data.features || [];
    for (const f of batch) {
      const id = f.properties?.naturvernId ?? f.id;
      if (id != null) { if (seenIds.has(id)) continue; seenIds.add(id); }
      const p = f.properties;
      const cat = (p.verneformAggregert || "").toLowerCase();
      const name = p.offisieltNavn || p.navn || "";
      const vf = (p.verneform || "").toLowerCase();
      // Wildlife/bird reserves typically carry a seasonal access ban (ferdselsforbud,
      // ~15 Apr–31 Jul) during nesting. Flag from the authoritative verneform plus a
      // "fugl" name token. (Bare egg/holm/vær were dropped — they false-match names
      // like Eggum/Heggedalen/Langholmen; the global banner covers any we miss.)
      const seasonal = /dyreliv|dyrefredning|fugl/.test(vf) || /fugl/i.test(name);
      features.push({
        type: "Feature",
        geometry: f.geometry,
        properties: {
          layer: "nature",
          name,
          verneform: p.verneform,
          category: cat,
          seasonal,
          municipality: p.kommune || "",
          iucn: p.iucn || "",
          protected_since: p.vernedato ? new Date(p.vernedato).toISOString().slice(0, 10) : "",
          regulation: p.verneforskrift || "",
          factsheet: p.faktaark || "",
          rule: natureRule(cat, seasonal),
        },
      });
    }
    // Page using ArcGIS's canonical flag; fall back to batch-size heuristic if
    // the server omits it. Advance by the actual batch size, not the page const.
    const more = data.exceededTransferLimit === true ||
      (data.exceededTransferLimit === undefined && batch.length === page);
    if (!more || batch.length === 0) break;
    offset += batch.length;
  }
  await save("nature.geojson", features, "Nature reserves & parks");
}

// ---------- 4. Populated areas (OSM via Overpass) ----------

async function overpassQuery(q) {
  const endpoints = Array.isArray(SRC.overpass) ? SRC.overpass : [SRC.overpass];
  const maxAttempts = endpoints.length * 2;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = endpoints[attempt % endpoints.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          // Overpass instances reject UA-less clients (overpass-api.de → 406,
          // kumi → 429 "include a meaningful User-Agent"). Identify ourselves so
          // the public mirrors serve us instead of throttling.
          "User-Agent": "Lofoten-Drone-Zones-Map/1.0 (+https://github.com/giedriusn/Lofoten-Drone-zones-map; non-commercial drone-safety map)",
        },
        body: q,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const text = await res.text();
      if (!text.trimStart().startsWith("{")) throw new Error(`non-JSON response from ${url}`);
      const data = JSON.parse(text);
      if (!Array.isArray(data.elements)) throw new Error(`missing elements array from ${url}`);
      return data;
    } catch (err) {
      lastErr = err;
      const last = attempt === maxAttempts - 1;
      console.log(`    …Overpass ${url} failed (${err.message}); ${last ? "giving up" : "trying next mirror"}`);
      if (!last) await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function buildPopulated() {
  const q = `[out:json][timeout:120];
(
  node["place"~"^(city|town|village)$"](${S},${W},${N},${E});
  way["landuse"="residential"](${S},${W},${N},${E});
);
out tags center geom;`;
  const data = await overpassQuery(q);
  const features = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (el.type === "node") {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [el.lon, el.lat] },
        properties: {
          layer: "populated",
          kind: "place",
          place: t.place,
          name: t.name || "",
          population: t.population || "",
          rule: "Built-up area. Do not fly over crowds or assemblies of people; keep distance from uninvolved persons.",
        },
      });
    } else if (el.type === "way" && el.geometry) {
      const ring = el.geometry.map(p => [p.lon, p.lat]);
      if (ring.length < 4) continue;
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          layer: "populated",
          kind: "residential",
          name: t.name || "",
          rule: "Residential / built-up area. Keep distance from people not involved in the flight.",
        },
      });
    }
  }
  await save("populated.geojson", features, "Populated areas");
}

// ---------- 5. Hospital / HEMS helipads (air-ambulance sites) ----------

async function buildHelipads() {
  const q = `[out:json][timeout:120];
(
  node["aeroway"="helipad"](${S},${W},${N},${E});
  way["aeroway"="helipad"](${S},${W},${N},${E});
  node["emergency"="landing_site"](${S},${W},${N},${E});
  way["emergency"="landing_site"](${S},${W},${N},${E});
);
out tags center;`;
  const data = await overpassQuery(q);
  const features = [];
  const seen = new Set();
  for (const el of data.elements || []) {
    const t = el.tags || {};
    const name = t.name || "";
    // Match against more than just the name — many hospital/air-ambulance pads carry
    // the hospital in `operator`/`description` rather than `name`, and were missed by
    // the old name-only filter. Designated emergency landing sites (emergency=landing_site)
    // are HEMS infrastructure by definition and kept regardless. Still skip the many
    // unnamed private/mountain helipads so the layer stays signal, not noise.
    const hay = `${name} ${t.operator || ""} ${t.description || ""} ${t["operator:type"] || ""} ${t.healthcare || ""}`;
    const isLandingSite = t.emergency === "landing_site";
    const matched = /sykehus|helikopterplass|helikopterhavn|luftambulanse|ambulanse|HEMS|hospital/i.test(hay);
    if (!matched && !isLandingSite) continue;
    const lon = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
    if (!isFinite(lon) || !isFinite(lat)) continue;
    const key = gridKey(lat, lon);
    if (seen.has(key)) continue;
    seen.add(key);
    // "hospital" really means "air-ambulance/HEMS-grade" — give it the strong keep-clear
    // rule. Pads admitted via an air-ambulance operator (luftambulanse/HEMS) but with no
    // literal "hospital"/"sykehus" token must still get the HEMS warning, not the weak one.
    const hospital = /sykehus|hospital|luftambulanse|ambulanse|HEMS/i.test(hay);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        layer: "helipad",
        name: name || (hospital ? "Hospital helipad" : isLandingSite ? "Emergency landing site" : "Helipad"),
        hospital,
        rule: hospital
          ? "Hospital helipad — air-ambulance (HEMS) helicopters operate here, often low and unannounced. Keep well clear; never obstruct emergency flights."
          : isLandingSite
          ? "Designated emergency (HEMS) landing site — air-ambulance helicopters may land here at short notice. Keep clear and give way."
          : "Helipad — helicopter traffic, often low and unscheduled. Keep clear.",
      },
    });
  }
  await save("helipads.geojson", features, "Hospital / HEMS helipads");
}

// ---------- 6. Prisons ----------

// Flying over / near a prison needs permission from the local authority
// (BSL A 7-2 §7). The law gives no fixed distance, so we render the facility as a
// point with a modest advisory radius (config.prisons.advisory_m) — clearly a
// "keep well clear" caution, not a surveyed legal boundary.
async function buildPrisons() {
  const q = `[out:json][timeout:120];
(
  node["amenity"="prison"](${S},${W},${N},${E});
  way["amenity"="prison"](${S},${W},${N},${E});
  relation["amenity"="prison"](${S},${W},${N},${E});
);
out tags center;`;
  const data = await overpassQuery(q);
  const advisory_m = config.prisons?.advisory_m ?? 300;
  const features = [];
  const seen = new Set();
  for (const el of data.elements || []) {
    const t = el.tags || {};
    // An OSM prison is often mapped as an unnamed amenity=prison perimeter. Under-reporting
    // a blocking no-fly is the unsafe direction, so keep it with a generic label rather than
    // dropping it (every query element is already a prison facility; dedup handles duplicates).
    const name = t.name || "Prison";
    const lon = el.lon ?? el.center?.lon, lat = el.lat ?? el.center?.lat;
    if (!isFinite(lon) || !isFinite(lat)) continue;
    const key = gridKey(lat, lon);
    if (seen.has(key)) continue;
    seen.add(key);
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        layer: "prison",
        name,
        advisory_m,
        rule: "Prison — flying over or near a prison needs permission from the facility / local authority (BSL A 7-2 §7). No fixed distance is set in law; keep well clear.",
      },
    });
  }
  await save("prisons.geojson", features, "Prisons");
}

// ---------- run ----------

console.log(`Building drone-restriction data for: ${config.region.name}`);
console.log(`Region bbox [W,S,E,N]: ${config.region.bbox.join(", ")}\n`);

const steps = [
  ["Airports", buildAirports],
  ["Airspace", buildAirspace],
  ["Nature", buildNature],
  ["Populated", buildPopulated],
  ["Helipads", buildHelipads],
  ["Prisons", buildPrisons],
];

let failures = 0;
for (const [name, fn] of steps) {
  try {
    await fn();
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name} FAILED: ${err.message}`);
  }
}

console.log(`\nDone. ${steps.length - failures}/${steps.length} layers built.`);
if (failures) process.exitCode = 1;
