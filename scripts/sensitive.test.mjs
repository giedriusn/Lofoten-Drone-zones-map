// scripts/sensitive.test.mjs
// Pins the curated-config → GeoJSON transform for the NSM advisory markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sensitiveFeatures } from "../sensitive.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(resolve(root, "config.json"), "utf8"));
const NSM = "https://nsm.example/map";

test("one Point feature per configured site", () => {
  const sites = [{ name: "A", lat: 68, lon: 15 }, { name: "B", lat: 69, lon: 16 }];
  const fs = sensitiveFeatures(sites, { nsm_url: NSM });
  assert.equal(fs.length, 2);
  for (const f of fs) {
    assert.equal(f.type, "Feature");
    assert.equal(f.geometry.type, "Point");
    assert.equal(f.geometry.coordinates.length, 2);
    assert.equal(f.properties.layer, "sensitive");
  }
});

test("coordinates are [lon, lat] order", () => {
  const [f] = sensitiveFeatures([{ name: "A", lat: 68, lon: 15 }], { nsm_url: NSM });
  assert.deepEqual(f.geometry.coordinates, [15, 68]);
});

test("each feature carries name, nsm_url, and an honest rule", () => {
  const [f] = sensitiveFeatures([{ name: "Bodø", lat: 67, lon: 14 }], { nsm_url: NSM });
  assert.equal(f.properties.name, "Bodø");
  assert.equal(f.properties.nsm_url, NSM);
  assert.match(f.properties.rule, /NSM/);
  // Honesty guard: must point to NSM, must NOT assert a no-fly here.
  assert.doesNotMatch(f.properties.rule, /no-fly/i);
});

test("the real config produces 6 sites, all inside bbox + 0.15° margin", () => {
  const [W, S, E, N] = config.region.bbox;
  const m = 0.15;
  const fs = sensitiveFeatures(config.sensitive.sites, { nsm_url: config.sensitive.nsm_url });
  assert.equal(fs.length, 6);
  for (const f of fs) {
    const [lon, lat] = f.geometry.coordinates;
    assert.ok(lon >= W - m && lon <= E + m, `${f.properties.name} lon ${lon} out of range`);
    assert.ok(lat >= S - m && lat <= N + m, `${f.properties.name} lat ${lat} out of range`);
  }
});
