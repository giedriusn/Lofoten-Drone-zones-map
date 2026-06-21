// offline.mjs — service-worker registration, the Kartverket "Norway" basemap,
// and the "Download offline map" control. Imports pure math from tiles.mjs.
import { tilesForBbox, countTilesForBbox, kartverketUrl, estimateBytes } from "./tiles.mjs";

const TILE_CACHE = "drone-tiles-v1"; // MUST match sw.js

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => console.warn("SW register failed", err));
  });
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

// Kartverket topographic basemap. maxNativeZoom caps real tile requests at the
// cached depth; maxZoom 18 lets the user zoom further by upscaling cached tiles.
export function kartverketBasemap(L, { layer = "topo", maxNativeZoom = 12 } = {}) {
  return L.tileLayer(kartverketUrl({ z: "{z}", x: "{x}", y: "{y}" }, layer), {
    maxNativeZoom, maxZoom: 18,
    attribution: "© Kartverket (CC BY 4.0) · airspace luftrom.info · vern Miljødirektoratet",
  });
}

const fmtMB = b => (b / (1024 * 1024)).toFixed(0);

// Download every region tile into TILE_CACHE with bounded concurrency. Opaque
// (no-cors) responses are cacheable and render in Leaflet's cross-origin <img>.
async function downloadRegion({ bbox, minZoom, maxZoom, layer, signal, onProgress }) {
  const tiles = tilesForBbox({ bbox, minZoom, maxZoom });
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0;
  const fetchOne = async t => {
    const url = kartverketUrl(t, layer);
    if (await cache.match(url)) return;       // resumable: skip cached
    const resp = await fetch(url, { mode: "no-cors", signal });
    await cache.put(url, resp);
  };
  const worker = async () => {
    while (i < tiles.length) {
      if (signal.aborted) return;
      const t = tiles[i++];
      try { await fetchOne(t); }
      catch (e) {
        if (signal.aborted) return;
        try { await fetchOne(t); } catch { failed++; } // one retry
      }
      onProgress(++done, tiles.length, failed);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed, total: tiles.length };
}

async function usageText() {
  if (!navigator.storage?.estimate) return "";
  try { const { usage } = await navigator.storage.estimate(); return usage ? ` · ~${fmtMB(usage)} MB used` : ""; }
  catch { return ""; }
}

// Build the offline UI inside #offline. `switchBasemap("Norway")` aligns what is
// cached with what is shown. No-op (section hidden) when SW unsupported.
export function setupOfflineUI({ config, switchBasemap }) {
  const root = document.getElementById("offline");
  if (!root || !("serviceWorker" in navigator) || !("caches" in window)) return;
  const o = config.offline || {};
  const bbox = config.region.bbox;
  const minZoom = o.minZoom ?? 5, maxZoom = o.maxZoom ?? 12, layer = o.layer || "topo";
  const perTile = o.bytesPerTile ?? 15 * 1024;
  const total = countTilesForBbox({ bbox, minZoom, maxZoom });
  const est = estimateBytes(total, perTile);

  root.hidden = false;
  root.innerHTML = `
    <span class="offline__label">Offline use</span>
    <button id="dlOffline" class="rulesbtn">⬇ Save map for offline (Norway)</button>
    <div id="dlStatus" class="offline__status"></div>`;
  const btn = root.querySelector("#dlOffline");
  const status = root.querySelector("#dlStatus");
  let controller = null;

  const showIdle = async () => {
    btn.textContent = "⬇ Save map for offline (Norway)";
    btn.classList.remove("rulesbtn--danger");
    status.innerHTML = `~${total.toLocaleString()} tiles · ~${fmtMB(est)} MB (approx)${await usageText()}`
      + ` · <button id="clrOffline" class="linkbtn">Clear</button>`;
    const clr = status.querySelector("#clrOffline");
    if (clr) clr.onclick = async () => {
      await caches.delete(TILE_CACHE);
      status.textContent = "Offline map cleared.";
      setTimeout(showIdle, 1200);
    };
  };

  btn.onclick = async () => {
    if (controller) { controller.abort(); return; }   // click again = cancel
    if (switchBasemap) switchBasemap("Norway");
    controller = new AbortController();
    btn.textContent = "■ Cancel download";
    btn.classList.add("rulesbtn--danger");
    try {
      const r = await downloadRegion({
        bbox, minZoom, maxZoom, layer, signal: controller.signal,
        onProgress: (done, t, failed) => {
          status.textContent = `Saving… ${done.toLocaleString()} / ${t.toLocaleString()}`
            + ` (~${fmtMB(estimateBytes(done, perTile))} MB)`
            + (failed ? ` · ${failed} failed` : "");
        },
      });
      status.textContent = controller.signal.aborted
        ? `Stopped — partial map saved (${r.done.toLocaleString()} tiles).`
        : `Saved ${(r.done - r.failed).toLocaleString()} tiles${r.failed ? ` (${r.failed} failed)` : ""}. Works offline now.`;
    } catch (e) {
      status.textContent = "Download failed — check your connection and try again.";
    } finally {
      controller = null;
      setTimeout(showIdle, 2500);
    }
  };

  showIdle();
}
