// scripts/geometry.test.mjs
// Pins the safety-critical "are you in a no-fly zone?" math extracted from app.js.
// Coordinates are GeoJSON order [lon, lat] throughout, matching the data files.
//
// Every containment case uses a NON-square shape probed at an off-diagonal point
// (and its transpose) so a lon/lat swap anywhere in the chain flips the verdict and
// fails the test — a false "clear" over a real no-fly polygon is the worst outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pointInRing, pointInGeom, haversine,
  featureContains, nearestPointOnFeature, minEdgePoint, featureRadiusM,
  bearingTo, fmtDist,
} from "../geometry.mjs";

// A closed ring for the axis-aligned rectangle [x0,y0]–[x1,y1] (x = lon, y = lat).
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

test("pointInRing: a tall ring distinguishes the axes", () => {
  const ring = rect(0, 0, 1, 5); // narrow (lon 0–1), tall (lat 0–5)
  assert.equal(pointInRing(0.5, 3, ring), true);   // inside
  assert.equal(pointInRing(3, 0.5, ring), false);  // the transpose is outside → catches a lon/lat swap
});

test("pointInGeom: a hole punches a void in a wide, short ring", () => {
  const outer = rect(0, 0, 10, 2);
  const hole = rect(4, 0.5, 6, 1.5);
  const geom = { type: "Polygon", coordinates: [outer, hole] };
  assert.equal(pointInGeom(8, 1, geom), true);    // in outer ring, clear of the hole
  assert.equal(pointInGeom(5, 1, geom), false);   // inside the hole → not contained
  assert.equal(pointInGeom(1, 8, geom), false);   // transpose of (8,1) → outside → catches a swap
});

test("pointInGeom: MultiPolygon matches either part, axis-sensitive", () => {
  const a = rect(0, 0, 1, 5);    // tall
  const b = rect(4, 0, 10, 1);   // wide, short
  const geom = { type: "MultiPolygon", coordinates: [[a], [b]] };
  assert.equal(pointInGeom(8, 0.5, geom), true);   // in part b
  assert.equal(pointInGeom(0.5, 8, geom), false);  // transpose → in neither → catches a swap
});

test("haversine: a degree of latitude is ~111.2 km; longitude shrinks with latitude", () => {
  assert.ok(Math.abs(haversine(0, 0, 1, 0) - 111195) < 1);
  // At lat 60 a degree of longitude is ~half a degree of latitude — pins the arg order.
  assert.ok(Math.abs(haversine(60, 0, 60, 1) - 111195 * Math.cos(60 * Math.PI / 180)) < 50);
  assert.ok(Math.abs(haversine(60, 0, 61, 0) - 111195) < 20);
});

test("featureContains: a polygon zone reads lon/lat in the right order", () => {
  // The live no-fly path: a tall ring (lon 0–1, lat 60–65), probed off-diagonal.
  const def = { id: "restricted" };
  const f = { geometry: { type: "Polygon", coordinates: [rect(0, 60, 1, 65)] }, properties: {} };
  assert.equal(featureContains(63, 0.5, def, f), true);   // lat 63, lon 0.5 → inside
  assert.equal(featureContains(0.5, 63, def, f), false);  // axes swapped → outside → catches a transposition
});

test("featureContains: airport ring uses the buffer radius (lat/lon order pinned)", () => {
  const def = { id: "airport" };
  const f = { geometry: { type: "Point", coordinates: [14.0, 68.0] }, properties: { buffer_km: 5 } };
  // Offset in BOTH axes, mostly east where cos(lat) matters: a swapped haversine would
  // read this as ~11 km (outside) instead of ~4.3 km (inside).
  assert.equal(featureContains(68.01, 14.10, def, f), true);
  assert.equal(featureContains(68.2, 14.5, def, f), false);  // ~30 km away
});

test("featureContains: an uncontrolled airfield (no buffer) contains nothing", () => {
  const def = { id: "airport" };
  const f = { geometry: { type: "Point", coordinates: [14.0, 68.0] }, properties: { buffer_km: 0 } };
  assert.equal(featureContains(68.0, 14.0, def, f), false);
});

test("nearestPointOnFeature: airport distance is to the ring edge, not the centre", () => {
  const def = { id: "airport" };
  const f = { geometry: { type: "Point", coordinates: [14.0, 68.0] }, properties: { buffer_km: 5 } };
  const np = nearestPointOnFeature(68.2, 14.0, def, f); // ~22.2 km north of centre
  assert.ok(np && Math.abs(np.distM - (haversine(68.2, 14.0, 68.0, 14.0) - 5000)) < 1);
});

test("featureContains: prison uses its advisory radius (lat/lon order pinned)", () => {
  const def = { id: "prison" };
  const f = { geometry: { type: "Point", coordinates: [14.0, 68.0] }, properties: { advisory_m: 300 } };
  // ~200 m away (mostly east, where cos(lat) matters) → inside the 300 m ring.
  // A swapped haversine would misread this point and flip the verdict.
  assert.equal(featureContains(68.001, 14.004, def, f), true);
  assert.equal(featureContains(68.01, 14.0, def, f), false); // ~1.1 km away → outside
});

test("nearestPointOnFeature: prison distance is to the advisory ring edge", () => {
  const def = { id: "prison" };
  const f = { geometry: { type: "Point", coordinates: [14.0, 68.0] }, properties: { advisory_m: 300 } };
  const np = nearestPointOnFeature(68.2, 14.0, def, f); // ~22.2 km north of centre
  assert.ok(np && Math.abs(np.distM - (haversine(68.2, 14.0, 68.0, 14.0) - 300)) < 1);
});

test("featureRadiusM: a configured advisory_m of 0 is honoured, not bumped to a default", () => {
  // Pins the ?? -vs- || fix: advisory_m:0 means "no ring", so nothing is contained.
  const def = { id: "prison" };
  const f = { geometry: { type: "Point", coordinates: [14.0, 68.0] }, properties: { advisory_m: 0 } };
  assert.equal(featureRadiusM(def, f), 0);
  assert.equal(featureContains(68.0, 14.0001, def, f), false); // ~4 m away, but radius 0
  // Airport with no buffer (uncontrolled airfield) is not a circular feature.
  assert.equal(featureRadiusM({ id: "airport" }, { properties: { buffer_km: 0 } }), null);
});

test("nearestPointOnFeature: polygon branch finds the nearest edge point", () => {
  const def = { id: "restricted" };
  const f = { geometry: { type: "Polygon", coordinates: [rect(0, 0, 2, 2)] }, properties: {} };
  const np = nearestPointOnFeature(1, -1, def, f); // due west of the left edge at lat 1
  assert.ok(np && Number.isFinite(np.distM));
  assert.ok(Math.abs(np.lon - 0) < 1e-6 && Math.abs(np.lat - 1) < 1e-6);
  assert.ok(Math.abs(np.distM - 111195) < 200);
});

test("minEdgePoint: nearest point on a square's west edge", () => {
  // Square straddling the equator (cosLat ~ 1); query point due west of the left edge.
  const geom = { type: "Polygon", coordinates: [rect(0, 0, 2, 2)] };
  const np = minEdgePoint(1, -1, geom); // lat=1, lng=-1
  assert.ok(Math.abs(np.lon - 0) < 1e-6);
  assert.ok(Math.abs(np.lat - 1) < 1e-6);
  assert.ok(Math.abs(np.distM - 111195) < 200); // ~1° of lon at lat 1
});

test("bearingTo: cardinal directions", () => {
  assert.equal(bearingTo(68, 14, [69, 14]), "N");
  assert.equal(bearingTo(68, 14, [68, 15]), "E");
  assert.equal(bearingTo(68, 14, [67, 14]), "S");
  assert.equal(bearingTo(68, 14, [68, 13]), "W");
});

test("fmtDist: metres round to 10, ≥950 m switches to km", () => {
  assert.equal(fmtDist(100), "100 m");
  assert.equal(fmtDist(944), "940 m");
  assert.equal(fmtDist(1500), "1.5 km");
});
