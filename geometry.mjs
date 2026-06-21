// geometry.mjs — pure point-in-zone / nearest-boundary math for the spot check.
// No DOM, no Leaflet: imported by app.js (browser) and scripts/geometry.test.mjs (Node).
// Coordinates are GeoJSON order [lon, lat]; ray casting uses x = lon, y = lat.

export function pointInGeom(x, y, geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (pointInRing(x, y, poly[0])) {
      let inHole = false;
      for (let k = 1; k < poly.length; k++) if (pointInRing(x, y, poly[k])) { inHole = true; break; }
      if (!inHole) return true;
    }
  }
  return false;
}

export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Does the feature contain the point? (airport ring = within radius; polygon =
// point-in-polygon; markers/points have no area.)
export function featureContains(lat, lng, def, f) {
  if (def.id === "airport") {
    if (f.properties.buffer_km > 0) {
      const [flon, flat] = f.geometry.coordinates;
      return haversine(lat, lng, flat, flon) <= f.properties.buffer_km * 1000;
    }
    return false;
  }
  if (def.id === "helipad") {
    // 1 km advisory caution radius so an on/near-pad click surfaces HEMS traffic
    // (non-blocking — appears under "Context / advisory").
    const [flon, flat] = f.geometry.coordinates;
    return haversine(lat, lng, flat, flon) <= 1000;
  }
  if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
    return pointInGeom(lng, lat, f.geometry);
  }
  return false;
}

// Nearest boundary point of a feature the click is OUTSIDE of, as
// { distM, lat, lon } — so distance AND bearing use the same point.
// Returns null for features with no usable area.
export function nearestPointOnFeature(lat, lng, def, f) {
  if (def.id === "airport") {
    if (f.properties.buffer_km > 0) {
      const [flon, flat] = f.geometry.coordinates;
      const d = Math.max(0, haversine(lat, lng, flat, flon) - f.properties.buffer_km * 1000);
      // For a circle, the nearest ring point lies toward the centre, so bearing
      // to the centre IS the bearing to the nearest edge point.
      return { distM: d, lat: flat, lon: flon };
    }
    return null;
  }
  if (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") {
    return minEdgePoint(lat, lng, f.geometry);
  }
  return null;
}

export function minEdgePoint(lat, lng, geom) {
  // Local equirectangular projection consistent with haversine's spherical Earth
  // (R = 6 371 000 m → 111 195 m per degree), accurate for short edge distances.
  const M = 111195, cosLat = Math.cos(lat * Math.PI / 180);
  const toM = (lo, la) => [lo * cosLat * M, la * M];
  const [px, py] = toM(lng, lat);
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let min = Infinity, bestX = lng, bestY = lat;
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = toM(ring[i][0], ring[i][1]);
      const [bx, by] = toM(ring[i + 1][0], ring[i + 1][1]);
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx, qy = ay + t * dy;
      const d = Math.hypot(px - qx, py - qy);
      if (d < min) { min = d; bestX = qx / (cosLat * M); bestY = qy / M; }
    }
  }
  return { distM: min, lat: bestY, lon: bestX };
}

export function bearingTo(lat, lng, [rlat, rlon]) {
  const dLon = (rlon - lng) * Math.cos(lat * Math.PI / 180);
  const ang = (Math.atan2(dLon, rlat - lat) * 180 / Math.PI + 360) % 360;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(ang / 45) % 8];
}

export function fmtDist(m) { return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`; }
