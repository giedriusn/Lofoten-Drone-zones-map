import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nsmZoneFeatures } from "../nsm.mjs";

// The NSM zones are now drawn from NSM's public ArcGIS feed, so the claim that there is
// "no open feed" for them (the bug this pins — config.json said it) is now factually false
// and contradicts the layer the user sees. Pin that exact phrase so it can't creep back
// into a served file. It is deliberately narrow: "no open feed" is unambiguous and never
// legitimate copy, whereas broader phrases like "not drawn" have valid uses ("not drawn to
// scale") and would false-positive. This is a targeted regression guard for the specific
// stale claim, not a semantic check for every possible paraphrase. (Historical design docs
// under docs/ are records of the old assumption — out of scope.)
test("no shipping config/code still claims there is 'no open feed' for the NSM zones", () => {
  const stale = /no open feed/i;
  // The served surfaces the false claim could live in: data/transform modules + user-facing copy.
  for (const rel of ["../config.json", "../sensitive.mjs", "../nsm.mjs", "../index.html", "../README.md"]) {
    const text = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(!stale.test(text), `${rel} still carries the stale "no open feed" claim about NSM zones`);
  }
});

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
  const ring = [[13.88, 66.99], [13.89, 66.99], [13.89, 67.0], [13.88, 66.99]];
  const mp = { features: [{ type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[ring]] }, properties: { navn: "X" } }] };
  assert.equal(nsmZoneFeatures(mp, {}).length, 1);
});

test("empty / garbage input yields empty output", () => {
  assert.deepEqual(nsmZoneFeatures({ features: [] }, {}), []);
  assert.deepEqual(nsmZoneFeatures(null, {}), []);
  assert.deepEqual(nsmZoneFeatures({}, {}), []);
});

test("drops polygons with no usable ring (empty/degenerate geometry)", () => {
  // A Polygon whose `coordinates` is empty (or a MultiPolygon with no rings) has zero
  // area — it conveys no zone, but if it reaches the spot-check it crashes point-in-polygon
  // (ring[0] is undefined), killing EVERY "Can I fly here?" tap. Such features must be
  // dropped at this boundary, not passed through.
  const bad = { features: [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: { navn: "Empty poly" } },
    { type: "Feature", geometry: { type: "MultiPolygon", coordinates: [] }, properties: { navn: "Empty multi" } },
    { type: "Feature", geometry: { type: "Polygon", coordinates: [[]] }, properties: { navn: "Empty ring" } },
  ]};
  assert.deepEqual(nsmZoneFeatures(bad, {}), []);
});
