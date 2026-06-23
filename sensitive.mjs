// sensitive.mjs — pure curated-config → GeoJSON for the NSM advisory markers.
// No DOM, no Leaflet, no I/O: imported by scripts/build-data.mjs (Node) and
// scripts/sensitive.test.mjs. These are well-known military/sensitive sites shown
// as advisory DOTS that complement the real NSM zone polygons (the `nsm` layer);
// every feature also points the pilot to NSM's own map.

const RULE = (nsm) =>
  "Military / sensitive installation. Photo & sensor bans (incl. airborne cameras) " +
  "apply in NSM zones — now drawn on this map as purple areas — but a zone may also " +
  "sit elsewhere or exist at a site not marked here, so always check NSM's map. " +
  "Near a military area, flying itself may need the local commander's OK. " +
  "(BSL A 7-2 §7 · FOR-2018-06-22-951 §6)";

export function sensitiveFeatures(sites = [], { nsm_url = "" } = {}) {
  return sites.map((s) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    properties: {
      layer: "sensitive",
      name: s.name,
      nsm_url,
      rule: RULE(nsm_url),
    },
  }));
}
