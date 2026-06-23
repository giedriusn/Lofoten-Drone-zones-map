// nsm.mjs — pure transform: NSM ArcGIS GeoJSON → app "nsm" zone Features.
// No DOM/IO: imported by scripts/build-data.mjs (Node) and scripts/nsm.test.mjs.
// These are NSM's real published sensor-ban zones (Forbudsområder for luftbårne
// sensorsystemer). Operating a camera/sensor drone inside one requires registering
// with NSM — so the shared rule routes the pilot there (not Ninox, which is for
// airport/airspace clearance).

const RULE =
  "NSM sensor/photo-ban zone. Airborne cameras and sensors are prohibited here " +
  "(including photo/video). Flying a camera/sensor drone needs NSM permission — " +
  "register with NSM before you fly. The zone is defined by NSM; verify on NSM's map. " +
  "(FOR-2018-06-22-951 §6)";

// A polygon geometry the spot-check can actually use: a non-empty outer ring. ArcGIS can
// emit a "Polygon"/"MultiPolygon" with empty coordinates (null/degenerate geometry); such
// a feature has zero area (you can't be inside it) but its empty outer ring makes
// point-in-polygon read `ring[0]` of undefined and THROW — which would kill every
// "Can I fly here?" tap. Drop these here so only real, testable zones reach the map.
function hasPolygonArea(geom) {
  const ringOK = ring => Array.isArray(ring) && ring.length > 0;
  if (geom.type === "Polygon") return ringOK(geom.coordinates?.[0]);
  if (geom.type === "MultiPolygon") return Array.isArray(geom.coordinates) && geom.coordinates.some(poly => ringOK(poly?.[0]));
  return false;
}

export function nsmZoneFeatures(geojson, { nsm_url = "" } = {}) {
  const feats = geojson && Array.isArray(geojson.features) ? geojson.features : [];
  return feats
    .filter(f => f && f.geometry && hasPolygonArea(f.geometry))
    .map(f => {
      const a = f.properties || {};
      return {
        type: "Feature",
        geometry: f.geometry,
        properties: {
          layer: "nsm",
          name: a.navn || "NSM zone",
          typeforbud: a.typeforbud || "",
          refnr: a.refnr || "",
          nsm_url,
          rule: RULE,
        },
      };
    });
}
