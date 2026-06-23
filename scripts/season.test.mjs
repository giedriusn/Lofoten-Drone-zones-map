// scripts/season.test.mjs
// Pins the "is the nesting ban active today?" date math. Windows are "MM-DD"
// strings so they are year-independent across the build → runtime boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nestingActive } from "../season.mjs";

const on = (iso) => new Date(iso + "T12:00:00Z");

test("inside the typical 15 Apr–31 Jul window is active", () => {
  assert.equal(nestingActive("04-15", "07-31", on("2026-06-23")), true);
});

test("window bounds are inclusive", () => {
  assert.equal(nestingActive("04-15", "07-31", on("2026-04-15")), true);
  assert.equal(nestingActive("04-15", "07-31", on("2026-07-31")), true);
});

test("outside the window is dormant", () => {
  assert.equal(nestingActive("04-15", "07-31", on("2026-08-01")), false);
  assert.equal(nestingActive("04-15", "07-31", on("2026-04-14")), false);
  assert.equal(nestingActive("04-15", "07-31", on("2026-01-10")), false);
});

test("a year-wrapping window is handled (defensive — not used today)", () => {
  assert.equal(nestingActive("11-01", "02-28", on("2026-01-15")), true);
  assert.equal(nestingActive("11-01", "02-28", on("2026-12-20")), true);
  assert.equal(nestingActive("11-01", "02-28", on("2026-06-01")), false);
});

test("missing window → not active (never assert a ban we can't bound)", () => {
  assert.equal(nestingActive(null, null, on("2026-06-23")), false);
  assert.equal(nestingActive("04-15", "", on("2026-06-23")), false);
});
