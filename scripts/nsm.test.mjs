import { test } from "node:test";
import assert from "node:assert/strict";
import { nsmZoneFeatures } from "../nsm.mjs";

const POLY = { type: "Polygon", coordinates: [[[13.88, 66.99], [13.89, 66.99], [13.89, 67.0], [13.88, 66.99]]] };
const sample = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: POLY, properties: { navn: "Høgnakken/Novik", typeforbud: "Alle sensorer. (Inkludert foto/video).", refnr: "0074" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [14, 67] }, properties: { navn: "Stray point" } },
  ],
};

test("maps ArcGIS attrs to layer properties, drops non-polygons", () => {
  const out = nsmZoneFeatures(sample, { nsm_url: "https://nsm.no/x" });
  assert.equal(out.length, 1);
  const p = out[0].properties;
  assert.equal(p.layer, "nsm");
  assert.equal(p.name, "Høgnakken/Novik");
  assert.equal(p.typeforbud, "Alle sensorer. (Inkludert foto/video).");
  assert.equal(p.refnr, "0074");
  assert.equal(p.nsm_url, "https://nsm.no/x");
});

test("rule names NSM registration as the permission route", () => {
  assert.match(nsmZoneFeatures(sample, {})[0].properties.rule, /register with NSM/i);
});

test("passes geometry through unchanged", () => {
  assert.deepEqual(nsmZoneFeatures(sample, {})[0].geometry, POLY);
});

test("keeps MultiPolygon", () => {
  const mp = { features: [{ type: "Feature", geometry: { type: "MultiPolygon", coordinates: [] }, properties: { navn: "X" } }] };
  assert.equal(nsmZoneFeatures(mp, {}).length, 1);
});

test("empty / garbage input yields empty output", () => {
  assert.deepEqual(nsmZoneFeatures({ features: [] }, {}), []);
  assert.deepEqual(nsmZoneFeatures(null, {}), []);
  assert.deepEqual(nsmZoneFeatures({}, {}), []);
});
