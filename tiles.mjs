// tiles.mjs — pure Web Mercator tile math for the offline tile cache.
// No DOM; imported by offline.mjs (browser) and scripts/tiles.test.mjs (Node).

export function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

// Every {z,x,y} tile covering bbox=[west,south,east,north] for minZoom..maxZoom.
export function tilesForBbox({ bbox, minZoom, maxZoom }) {
  const [w, s, e, n] = bbox;
  const out = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xa = lonToTileX(w, z), xb = lonToTileX(e, z);
    const ya = latToTileY(n, z), yb = latToTileY(s, z); // north → smaller y
    for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++)
      for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++)
        out.push({ z, x, y });
  }
  return out;
}

// Same coverage as tilesForBbox().length without building the array.
export function countTilesForBbox({ bbox, minZoom, maxZoom }) {
  const [w, s, e, n] = bbox;
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const nx = Math.abs(lonToTileX(e, z) - lonToTileX(w, z)) + 1;
    const ny = Math.abs(latToTileY(s, z) - latToTileY(n, z)) + 1;
    total += nx * ny;
  }
  return total;
}

// Kartverket WMTS webmercator: TileMatrix(z) / TileRow(y) / TileCol(x).
// Pass literal {z}/{x}/{y} strings to build a Leaflet template URL.
export function kartverketUrl({ z, x, y }, layer = "topo") {
  return `https://cache.kartverket.no/v1/wmts/1.0.0/${layer}/default/webmercator/${z}/${y}/${x}.png`;
}

export function estimateBytes(tileCount, bytesPerTile = 15 * 1024) {
  return tileCount * bytesPerTile;
}
