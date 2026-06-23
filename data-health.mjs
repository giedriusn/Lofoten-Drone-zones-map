// data-health.mjs — pure helper shared by app.js (browser) and its test (Node).
// Given the layer definitions and the data files that failed to load, return the
// distinct names of BLOCKING (legal no-fly) layers whose data is missing. The spot-check
// uses this to warn — and to withhold a confident "clear" verdict — when a no-fly layer
// couldn't load, instead of silently reading the gap as "nothing here". Non-blocking
// advisory layers (populated, sensitive, helipad…) don't drive the verdict, so a failure
// there must NOT raise the caveat.
export function unloadedBlockingLayers(defs, failedFiles) {
  const failed = new Set(failedFiles);
  const names = [];
  const seen = new Set();
  for (const def of defs) {
    if (def.blocking && failed.has(def.file) && !seen.has(def.name)) {
      seen.add(def.name);
      names.push(def.name);
    }
  }
  return names;
}
