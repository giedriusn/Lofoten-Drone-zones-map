// scripts/offline-assets.test.mjs
// Guards the two cross-file invariants the build has no other way to catch:
//  1. every precached shell asset in sw.js actually exists on disk (a rename that
//     misses sw.js would otherwise silently break offline support), and
//  2. the TILE_CACHE name is identical in sw.js and offline.mjs (they must agree
//     for the SW to serve what the downloader wrote), and
//  3. the Kartverket cache key the downloader writes survives the SW's subdomain
//     normalization unchanged (otherwise downloaded tiles would never be found
//     offline — the one invariant the whole offline promise rests on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { kartverketUrl } from "../tiles.mjs";

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

test("Kartverket cache key survives the SW's subdomain normalization", () => {
  // offline.mjs writes a tile under kartverketUrl(...); sw.js looks it up after
  // stripping a leading a./b./c. subdomain. That strip MUST be a no-op for
  // cache.kartverket.no or downloaded tiles would never be served offline. Pull the
  // real regex out of sw.js (no drifting copy) and prove it leaves the host alone.
  const m = sw.match(/hostname\.replace\((\/.+?\/[a-z]*),/);
  assert.ok(m, "subdomain-normalization regex found in sw.js");
  const lit = m[1], lastSlash = lit.lastIndexOf("/");
  const re = new RegExp(lit.slice(1, lastSlash), lit.slice(lastSlash + 1));

  const host = new URL(kartverketUrl({ z: 8, x: 138, y: 60 }, "topo")).hostname;
  assert.equal(host.replace(re, ""), host,
    "SW subdomain normalization must not alter the Kartverket host (downloader key == SW key)");
});
