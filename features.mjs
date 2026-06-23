// features.mjs — pure per-feature validation for the map layers, extracted from app.js
// so it can be unit-tested (app.js runs init() at import and needs the DOM/Leaflet, so a
// test can't import it). No DOM: imported by app.js (browser) and scripts/features.test.mjs.
//
// Why this exists: a single malformed feature (null geometry, null/absent properties, or
// non-array coordinates — reachable from a corrupted/older cached geojson the service worker
// serves, or a reshaped upstream feed) used to throw inside buildLayer. Uncaught, that one
// bad feature blanked the WHOLE map AND aborted init() before the missing-no-fly-layer
// verdict downgrade could run — the opposite of the stated "one bad layer never blanks the
// whole map" invariant. Dropping the bad feature here costs only itself.

// A feature the map can actually render and spot-check: it needs a geometry with a string
// type and an array of coordinates (markers/rings destructure f.geometry.coordinates; the
// point check reads f.geometry.type), and a properties object (def.match and popupHtml read
// p.*). Anything else has no usable location/metadata, so it can't be drawn or analysed.
export function isRenderableFeature(f) {
  return !!(
    f &&
    f.geometry &&
    typeof f.geometry.type === "string" &&
    Array.isArray(f.geometry.coordinates) &&
    f.geometry.coordinates.length > 0 &&
    f.properties && typeof f.properties === "object"
  );
}

// The renderable features of a layer's data file that this def covers, plus how many of the
// file's features were DROPPED as malformed. Drops malformed features first, THEN applies the
// def's match predicate (safe now — every survivor has a properties object). The `dropped`
// count lets a BLOCKING layer flag the gap and downgrade the verdict instead of silently
// losing a real no-fly zone — a dropped zone reading as "clear" is the worst outcome here.
// `dropped` counts the whole file's malformed features (not just this def's matches): a
// malformed feature has no usable properties, so we can't know which def it belonged to, and
// over-flagging a shared file (e.g. airspace) is the safe direction. Tolerates a missing/
// garbled feature collection by returning no features and 0 drops.
export function layerFeatures(fc, def) {
  const all = fc?.features || [];
  const renderable = all.filter(isRenderableFeature);
  const features = def && def.match ? renderable.filter(f => def.match(f.properties)) : renderable;
  return { features, dropped: all.length - renderable.length };
}
