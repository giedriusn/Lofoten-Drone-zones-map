// scripts/geometry.test.mjs
// Pins the safety-critical "are you in a no-fly zone?" math extracted from app.js.
// Coordinates are GeoJSON order [lon, lat] throughout, matching the data files.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pointInRing, pointInGeom, haversine,
  featureContains, nearestPointOnFeature, minEdgePoint,
  bearingTo, fmtDist,
} from "../geometry.mjs";

// A closed CCW ring for the axis-aligned rectangle [x0,y0]–[x1,y1].
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

test("pointInRing: inside vs outside a unit square", () => {
  const ring = square(0, 0, 1, 1);
  assert.equal(pointInRing(0.5, 0.5, ring), true);
  assert.equal(pointInRing(2, 2, ring), false);
  assert.equal(pointInRing(0.5, 2, ring), false); // directly above the ring
});

test("pointInGeom: a Polygon hole punches a void", () => {
  const geom = { type: "Polygon", coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] };
  assert.equal(pointInGeom(1, 1, geom), true);   // in outer ring, clear of the hole
  assert.equal(pointInGeom(5, 5, geom), false);  // inside the hole → not contained
});

test("pointInGeom: MultiPolygon matches either part", () => {
  const geom = { type: "MultiPolygon", coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] };
  assert.equal(pointInGeom(5.5, 5.5, geom), true);
  assert.equal(pointInGeom(3, 3, geom), false);
});

test("haversine: one degree of latitude is ~111.2 km", () => {
  assert.ok(Math.abs(haversine(0, 0, 1, 0) - 111195) < 1);
});

test("featureContains: airport ring uses the buffer radius", () => {
  const def = { id: "airport" };
  const f = { geometry: { type: "Point", coordinates: [14.0, 68.0] }, properties: { buffer_km: 5 } };
  assert.equal(featureContains(68.01, 14.0, def, f), true);  // ~1.1 km < 5 km
  assert.equal(featureContains(68.1, 14.0, def, f), false);  // ~11 km > 5 km
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

test("minEdgePoint: nearest point on a square's west edge", () => {
  // Square straddling the equator (cosLat ~ 1); query point due west of the left edge.
  const geom = { type: "Polygon", coordinates: [square(0, 0, 2, 2)] };
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
