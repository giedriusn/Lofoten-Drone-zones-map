// scripts/source-utils.test.mjs
// Pins the data-pipeline fetch guards. The point of these helpers is that a failed or
// error-shaped source response must abort a layer LOUDLY, never silently write an empty
// no-fly GeoJSON (which would make the map under-report restrictions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchOk, requireFeatures } from "./source-utils.mjs";

test("fetchOk: returns the response on a 2xx status", async () => {
  const res = { ok: true, status: 200 };
  assert.equal(await fetchOk("http://x/y", async () => res), res);
});

test("fetchOk: throws on a non-OK HTTP status (4xx/5xx)", async () => {
  await assert.rejects(
    () => fetchOk("http://x/y", async () => ({ ok: false, status: 503 })),
    /503/);
});

test("requireFeatures: returns the features array, including a valid empty page", () => {
  assert.deepEqual(requireFeatures({ features: [1, 2] }, "Nature"), [1, 2]);
  assert.deepEqual(requireFeatures({ features: [] }, "Nature"), []);
});

test("requireFeatures: throws on an ArcGIS error object (HTTP 200, no features array)", () => {
  // ArcGIS returns errors as 200 + {error:{...}} — res.ok passes, so the shape check
  // is what stops an empty no-fly layer from being written.
  assert.throws(() => requireFeatures({ error: { code: 500 } }, "Restrictions"), /Restrictions/);
  assert.throws(() => requireFeatures(null, "Nature"));
  assert.throws(() => requireFeatures({}, "Nature"));
});
