// scripts/offline-assets.test.mjs
// Guards the two cross-file invariants the build has no other way to catch:
//  1. every precached shell asset in sw.js actually exists on disk (a rename that
//     misses sw.js would otherwise silently break offline support), and
//  2. the TILE_CACHE name is identical in sw.js and offline.mjs (they must agree
//     for the SW to serve what the downloader wrote).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(resolve(root, "sw.js"), "utf8");
const off = readFileSync(resolve(root, "offline.mjs"), "utf8");

test("every precached shell asset exists on disk", () => {
  const m = sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(m, "SHELL_ASSETS array found in sw.js");
  const paths = [...m[1].matchAll(/"(\.\/[^"]*)"/g)].map(x => x[1]);
  let checked = 0;
  for (const p of paths) {
    if (p === "./") continue;               // "./" is the directory index, not a file
    assert.ok(existsSync(resolve(root, p)), `precached asset missing on disk: ${p}`);
    checked++;
  }
  assert.ok(checked > 15, `expected the full shell asset list, only saw ${checked}`);
});

test("TILE_CACHE name matches between sw.js and offline.mjs", () => {
  const a = sw.match(/TILE_CACHE = "([^"]+)"/);
  const b = off.match(/TILE_CACHE = "([^"]+)"/);
  assert.ok(a && b, "TILE_CACHE declared in both files");
  assert.equal(a[1], b[1]);
});
