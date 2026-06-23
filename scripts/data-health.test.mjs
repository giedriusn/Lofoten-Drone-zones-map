// scripts/data-health.test.mjs
// Pins the "which no-fly layers are missing?" logic behind the spot-check's safety
// caveat. A blocking layer whose data file failed to load must be reported so the
// verdict can warn instead of falsely reading "clear"; a non-blocking advisory layer
// must NOT trigger the caveat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unloadedBlockingLayers } from "../data-health.mjs";

const DEFS = [
  { id: "airport", name: "Airport 5 km zone", file: "airports", blocking: true },
  { id: "ctr", name: "Control zones (CTR)", file: "airspace", blocking: true },
  { id: "restricted", name: "Restricted areas", file: "airspace", blocking: true },
  { id: "sensitive", name: "Military / sensitive sites", file: "sensitive", blocking: false },
  { id: "populated", name: "Populated areas", file: "populated", blocking: false },
];

test("no failed files → nothing missing", () => {
  assert.deepEqual(unloadedBlockingLayers(DEFS, []), []);
});

test("a failed blocking layer's file is reported by name", () => {
  assert.deepEqual(unloadedBlockingLayers(DEFS, ["airports"]), ["Airport 5 km zone"]);
});

test("one failed file shared by several blocking layers reports each blocking name", () => {
  assert.deepEqual(unloadedBlockingLayers(DEFS, ["airspace"]),
    ["Control zones (CTR)", "Restricted areas"]);
});

test("a failed NON-blocking (advisory) layer is not reported", () => {
  assert.deepEqual(unloadedBlockingLayers(DEFS, ["sensitive", "populated"]), []);
});

test("mixed: only the blocking failures surface", () => {
  assert.deepEqual(unloadedBlockingLayers(DEFS, ["populated", "airports"]),
    ["Airport 5 km zone"]);
});
