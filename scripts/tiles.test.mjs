// scripts/tiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { lonToTileX, latToTileY, tilesForBbox, countTilesForBbox, kartverketUrl, estimateBytes } from "../tiles.mjs";

const REGION = [11.0, 66.7, 18.5, 69.6]; // [west, south, east, north]

test("lon/lat → tile matches reference points", () => {
  // Null Island at z1 is tile (1,1); region center ~ (14.8,68.2) at z8 is (138,60).
  assert.equal(lonToTileX(0, 1), 1);
  assert.equal(latToTileY(0, 1), 1);
  assert.equal(lonToTileX(14.8, 8), 138);
  assert.equal(latToTileY(68.2, 8), 60);
});

test("single-zoom enumeration covers the bbox (z8 = 7×6 = 42)", () => {
  const z8 = tilesForBbox({ bbox: REGION, minZoom: 8, maxZoom: 8 });
  assert.equal(z8.length, 42);
  for (const t of z8) assert.equal(t.z, 8);
});

test("count matches enumeration length and the measured z5–z12 total", () => {
  const opts = { bbox: REGION, minZoom: 5, maxZoom: 12 };
  assert.equal(countTilesForBbox(opts), tilesForBbox(opts).length);
  assert.equal(countTilesForBbox(opts), 10476);
});

test("maxZoom < minZoom yields no tiles", () => {
  assert.equal(tilesForBbox({ bbox: REGION, minZoom: 12, maxZoom: 5 }).length, 0);
});

test("kartverket URL uses WMTS {z}/{y}/{x} ordering", () => {
  assert.equal(
    kartverketUrl({ z: 8, x: 138, y: 60 }, "topo"),
    "https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/8/60/138.png"
  );
});

test("byte estimate scales with tile count", () => {
  assert.equal(estimateBytes(10, 1000), 10000);
});
