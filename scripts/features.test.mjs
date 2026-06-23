// scripts/features.test.mjs
// Pins the per-feature robustness extracted from app.js's buildLayer. A single
// malformed feature (null geometry, null/absent properties, non-array coordinates —
// possible from a corrupted cache or a reshaped upstream feed) used to throw inside
// buildLayer and, uncaught, blank the WHOLE map AND skip the missing-no-fly-layer
// verdict downgrade. layerFeatures must drop the bad one and keep the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRenderableFeature, layerFeatures } from "../features.mjs";

const goodPoint = { type: "Feature", geometry: { type: "Point", coordinates: [14, 68] }, properties: { category: "ctr", name: "X" } };

// Guard: the exact access patterns app.js used (def.match(f.properties) and
// f.geometry.type) throw on these shapes — so they MUST be classed unrenderable.
test("isRenderableFeature: a well-formed feature is renderable", () => {
  assert.equal(isRenderableFeature(goodPoint), true);
});

test("isRenderableFeature: rejects null/undefined and non-objects", () => {
  assert.equal(isRenderableFeature(null), false);
  assert.equal(isRenderableFeature(undefined), false);
  assert.equal(isRenderableFeature("nope"), false);
});

test("isRenderableFeature: rejects null geometry (GeoJSON allows it; addPlacePoint/match would throw)", () => {
  assert.equal(isRenderableFeature({ type: "Feature", geometry: null, properties: {} }), false);
});

test("isRenderableFeature: rejects a geometry with no string type", () => {
  assert.equal(isRenderableFeature({ type: "Feature", geometry: { coordinates: [14, 68] }, properties: {} }), false);
});

test("isRenderableFeature: rejects non-array / empty coordinates (destructuring would throw)", () => {
  assert.equal(isRenderableFeature({ type: "Feature", geometry: { type: "Point", coordinates: null }, properties: {} }), false);
  assert.equal(isRenderableFeature({ type: "Feature", geometry: { type: "Point", coordinates: [] }, properties: {} }), false);
});

test("isRenderableFeature: rejects null/absent properties (def.match & popupHtml read p.*)", () => {
  assert.equal(isRenderableFeature({ type: "Feature", geometry: { type: "Point", coordinates: [14, 68] }, properties: null }), false);
  assert.equal(isRenderableFeature({ type: "Feature", geometry: { type: "Point", coordinates: [14, 68] } }), false);
});

test("layerFeatures: drops a malformed feature, keeps valid ones, and REPORTS the drop count", () => {
  const fc = { features: [goodPoint, { type: "Feature", geometry: null, properties: { category: "ctr" } }] };
  const out = layerFeatures(fc, {});
  // A blocking layer uses `dropped` to flag the gap (downgrade the verdict) instead of
  // silently losing a real no-fly zone, which would read as a false "clear".
  assert.deepEqual(out.features, [goodPoint]);
  assert.equal(out.dropped, 1);
});

test("layerFeatures: a GeometryCollection / null geometry counts as a dropped no-fly zone", () => {
  const gc = { type: "Feature", geometry: { type: "GeometryCollection", geometries: [] }, properties: { name: "zone" } };
  const fc = { features: [goodPoint, gc] };
  const out = layerFeatures(fc, {});
  assert.deepEqual(out.features, [goodPoint]);
  assert.equal(out.dropped, 1);
});

test("layerFeatures: applies def.match safely AFTER dropping malformed features", () => {
  const seabird = { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0]]] }, properties: { seabird: true } };
  const noProps = { type: "Feature", geometry: { type: "Point", coordinates: [1, 1] } }; // would crash p.seabird
  const fc = { features: [goodPoint, seabird, noProps] };
  // def.match selects only seabird features; the no-properties feature must not throw,
  // and is still counted as a drop (it's a malformed feature regardless of which def matches).
  const out = layerFeatures(fc, { match: p => p.seabird === true });
  assert.deepEqual(out.features, [seabird]);
  assert.equal(out.dropped, 1);
});

test("layerFeatures: no match predicate keeps every renderable feature, 0 dropped", () => {
  const fc = { features: [goodPoint] };
  assert.deepEqual(layerFeatures(fc, {}), { features: [goodPoint], dropped: 0 });
});

test("layerFeatures: tolerates a missing/empty feature collection", () => {
  assert.deepEqual(layerFeatures(undefined, {}), { features: [], dropped: 0 });
  assert.deepEqual(layerFeatures({}, {}), { features: [], dropped: 0 });
  assert.deepEqual(layerFeatures({ features: null }, {}), { features: [], dropped: 0 });
});
