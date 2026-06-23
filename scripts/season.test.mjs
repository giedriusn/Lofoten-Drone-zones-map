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

// --- protected-area restriction windows ---
import { parseRestrictionWindows, windowsActive } from "../season.mjs";

test("parseRestrictionWindows: single d.m-d.m range → MM-DD window", () => {
  assert.deepEqual(parseRestrictionWindows("Ferdselsforbud (15.4-31.7)"),
    [{ from: "04-15", to: "07-31" }]);
});
test("parseRestrictionWindows: year-round 1.1-31.12", () => {
  assert.deepEqual(parseRestrictionWindows("Lavflyving forbudt (1.1-31.12)"),
    [{ from: "01-01", to: "12-31" }]);
});
test("parseRestrictionWindows: multiple ranges, ignores '< 300 m'", () => {
  assert.deepEqual(
    parseRestrictionWindows("Ferdselsforbud (1.3-31.7), Lavflyving forbudt (< 300 m) (1.1-31.12)"),
    [{ from: "03-01", to: "07-31" }, { from: "01-01", to: "12-31" }]);
});
test("parseRestrictionWindows: no dates → []", () => {
  assert.deepEqual(parseRestrictionWindows("Ferdselsforbud"), []);
  assert.deepEqual(parseRestrictionWindows(""), []);
});
test("windowsActive: year-round is always active", () => {
  assert.equal(windowsActive([], true, on("2026-01-10")), true);
});
test("windowsActive: true if any window active today", () => {
  const w = [{ from: "04-15", to: "07-31" }, { from: "11-01", to: "12-01" }];
  assert.equal(windowsActive(w, false, on("2026-06-23")), true);
  assert.equal(windowsActive(w, false, on("2026-09-01")), false);
});
test("windowsActive: no windows, not year-round → false", () => {
  assert.equal(windowsActive([], false, on("2026-06-23")), false);
});
