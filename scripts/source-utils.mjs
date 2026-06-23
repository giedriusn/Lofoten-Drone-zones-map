// scripts/source-utils.mjs — fetch guards for the data pipeline, split out of
// build-data.mjs so they can be unit-tested (build-data.mjs runs fetches at import
// time and so can't itself be imported by a test). Used by the ArcGIS/CSV sources to
// match the loud-failure standard overpassQuery already enforces.

// Fetch a URL and throw on a non-OK HTTP status, so a 4xx/5xx source failure aborts the
// layer build instead of feeding an error body into .json()/.text() and silently writing
// an empty no-fly file. `fetchImpl` is injectable for testing; defaults to global fetch.
export async function fetchOk(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

// An ArcGIS/GeoJSON response MUST carry a features array. ArcGIS reports errors as a
// 200 with an {error:{...}} body (so res.ok passes), which would otherwise become an
// empty layer via `data.features || []`. Throw instead, naming the layer, so the build
// fails loudly and the previous good file is kept.
export function requireFeatures(data, label) {
  if (!data || !Array.isArray(data.features)) {
    throw new Error(`${label}: source response has no features array (server error?)`);
  }
  return data.features;
}

// Did ArcGIS truncate this page (more records remain)? ArcGIS signals it via
// `exceededTransferLimit` — but the flag's LOCATION depends on the output format:
//   f=json    → top-level `data.exceededTransferLimit`
//   f=geojson → NESTED `data.properties.exceededTransferLimit` (top level is undefined)
// Reading only the top level silently misses truncation for every geojson source, which
// would ship a truncated no-fly layer. Check both. When neither flag is present, fall back
// to the "the page came back completely full" heuristic. Callers page until this is false.
export function hasMorePages(data, batchLength, pageSize) {
  const flag = data?.exceededTransferLimit ?? data?.properties?.exceededTransferLimit;
  if (typeof flag === "boolean") return flag;
  return batchLength === pageSize;
}
