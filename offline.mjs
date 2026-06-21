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

const fmtMB = b => { const mb = b / (1024 * 1024); return mb < 1 ? "<1" : mb.toFixed(0); };

// Download every region tile into TILE_CACHE with bounded concurrency. Kartverket
// sends `Access-Control-Allow-Origin: *`, so we fetch with CORS and can verify the
// status — a 4xx/5xx/429 is NOT cached (it would otherwise masquerade as a saved
// tile and be skipped forever by the resumability check, leaving a silent hole).
// Failed tiles are left uncached so re-running the download fills the gaps.
async function downloadRegion({ bbox, minZoom, maxZoom, layer, signal, onProgress }) {
  const tiles = tilesForBbox({ bbox, minZoom, maxZoom });
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0, quotaHit = false;
  const fetchOne = async t => {
    const url = kartverketUrl(t, layer);
    if (await cache.match(url)) return;       // resumable: skip already-cached
    const resp = await fetch(url, { mode: "cors", signal });
    if (!resp.ok) throw new Error("tile " + resp.status);
    await cache.put(url, resp);               // rejects with QuotaExceededError if disk full
  };
  const worker = async () => {
    while (i < tiles.length && !quotaHit) {
      if (signal.aborted) return;
      const t = tiles[i++];
      try { await fetchOne(t); }
      catch (e) {
        if (signal.aborted) return;
        if (e && e.name === "QuotaExceededError") { quotaHit = true; return; }
        try { await fetchOne(t); }            // one retry (transient network/429)
        catch (e2) {
          if (signal.aborted) return;         // cancelled mid-retry — not a real failure
          if (e2 && e2.name === "QuotaExceededError") { quotaHit = true; return; }
          failed++;
        }
      }
      onProgress(++done, tiles.length, failed);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { done, failed, total: tiles.length, quotaHit };
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

  const idleLabel = "⬇ Save map for offline (Norway)";

  root.hidden = false;
  root.innerHTML = `
    <span class="offline__label">Offline use</span>
    <button id="dlOffline" class="rulesbtn">${idleLabel}</button>
    <div id="dlStatus" class="offline__status"></div>`;
  const btn = root.querySelector("#dlOffline");
  const status = root.querySelector("#dlStatus");
  let controller = null, idleTimer = null;
  const deferIdle = ms => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(showIdle, ms); };

  async function showIdle() {
    btn.textContent = idleLabel;
    btn.classList.remove("rulesbtn--danger");
    status.innerHTML = `~${total.toLocaleString()} tiles · ~${fmtMB(est)} MB (approx)${await usageText()}`
      + ` · <button id="clrOffline" class="linkbtn">Clear</button>`;
    const clr = status.querySelector("#clrOffline");
    if (clr) clr.onclick = async () => {
      await caches.delete(TILE_CACHE);
      status.textContent = "Offline map cleared.";
      deferIdle(1200);
    };
  }

  btn.onclick = async () => {
    if (controller) { controller.abort(); return; }   // click again = cancel
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
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
      const saved = (r.done - r.failed).toLocaleString();
      status.textContent = r.quotaHit
        ? `Storage full — saved ${saved} tiles. Lower offline.maxZoom or free space, then try again.`
        : controller.signal.aborted
        ? `Stopped — partial map saved (${saved} tiles).`
        : `Saved ${saved} tiles${r.failed ? ` (${r.failed} failed — tap again to fill the gaps)` : ""}. Works offline now.`;
    } catch (e) {
      status.textContent = "Download failed — check your connection and try again.";
    } finally {
      controller = null;
      // `controller` is now null, so the next tap means "start a new download" — reset
      // the button immediately so its label says so instead of still reading "Cancel"
      // during the 3 s the completion message lingers.
      btn.textContent = idleLabel;
      btn.classList.remove("rulesbtn--danger");
      deferIdle(3000);
    }
  };

  showIdle();
}
