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

export function nsmZoneFeatures(geojson, { nsm_url = "" } = {}) {
  const feats = geojson && Array.isArray(geojson.features) ? geojson.features : [];
  return feats
    .filter(f => f && f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon"))
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
