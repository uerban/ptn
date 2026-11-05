import type { TileAnchor } from "@pt/shared";
import { cacheByteTotal, ensureUnderBudget } from "./tileCache.ts";
import { getTile } from "./tileCache.ts";
import type { TileLoader } from "./tileLoader.ts";

export interface PrefetchPlan {
  cityId: string;
  edgeKm: number;
  anchor: TileAnchor;
  /** Viewport-first ordering: center tile first, then Chebyshev ring expansion. */
  orderedTileKeys: string[];
}

export interface PrefetchPacing {
  /** Active privacy-tier budget; pass getPolicy().m11TileCacheBudgetBytes. The
   *  SINGLE budget authority shared with tileCache.ensureUnderBudget. */
  budgetBytes: number;
  /** Conservative per-tile UPPER-BOUND estimate for the admission check BEFORE
   *  the fetch; ACTUAL post-decode byteSize drives eviction. */
  estTileBytes: number;
}

function deltaRing(centerCoords: string, tileKey: string): number {
  const [cx, cy] = centerCoords.split("_").map(Number);
  const [x, y] = tileKey.split("/")[2].split("_").map(Number);
  return Math.max(Math.abs(x - cx), Math.abs(y - cy));
}

/**
 * Viewport-first ordering producer: sorts `tiles` by Chebyshev (ring) distance from
 * `centerTile`. centerTile is index 0; ring N precedes ring N+1. Stable within a ring
 * (preserves input order).
 */
export function orderViewportFirst(centerTile: string, tiles: string[]): string[] {
  const centerCoords = centerTile.split("/")[2];
  return [...tiles]
    .map((t, i) => ({ t, i, d: deltaRing(centerCoords, t) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.t);
}

/** Drives prefetch in plan order: for each not-cached tile, if
 *  (runningCounter + estTileBytes) <= budgetBytes, fetch+decode (via loader) and
 *  bump the counter by the ACTUAL decoded byteSize the loader REPORTS; else SKIP
 *  (never breach). Each successful insert invokes onTileLanded().
 *

 * * COST MODEL (protects this path): read cacheByteTotal() — the full poiTileCache.each() scan
 * — exactly ONCE before the loop into `running`, then maintain `running` purely from the
 * byteSize prefetchTiles RETURNS (`insertedBytes`). Re-read the full total ONLY after an
 * eviction actually fires (ensureUnderBudget may have removed rows the counter can't predict).
 * A per-tile cacheByteTotal() before/after would be O(tiles^2) IndexedDB scans competing with
 * input responsiveness.

 *

 * * 503 / abort: prefetchTiles returns `cityDeliveryDisabled` once the server said delivery is
 * off — break the WHOLE loop then (do NOT keep calling prefetchTiles for every remaining tile —
 * AC-21). Abort also breaks promptly.
 */
export async function runViewportPrefetch(
  plan: PrefetchPlan,
  pacing: PrefetchPacing,
  signal: AbortSignal,
  onTileLanded: () => void,
  loader: Pick<TileLoader, "prefetchTiles">,
): Promise<void> {
  // Read the full-table total ONCE; thereafter maintain a running counter from the loader-reported
  // byteSize (no per-tile re-scan — cost model).
  let running = await cacheByteTotal();

  for (const tileKey of plan.orderedTileKeys) {
    if (signal.aborted) return;
    if (await getTile(tileKey)) continue;
    // estimate-guards-admission.
    if (running + pacing.estTileBytes > pacing.budgetBytes) continue;

    const result = await loader.prefetchTiles([tileKey], signal);
    if (signal.aborted) return;

    if (result.insertedBytes > 0) {
      running += result.insertedBytes; // ACTUAL decoded byteSize, loader-reported
      onTileLanded();
    }

    // 503: the city's delivery is disabled — stop the whole loop (AC-21).
    if (result.cityDeliveryDisabled) return;

    // actual-guards-eviction: converge under the shared per-tier ceiling. An
    // eviction can remove rows the running counter can't predict, so re-read the
    // full total ONLY when the counter says we MIGHT be over (the only case
    // ensureUnderBudget can actually evict). When we're comfortably under, skip
    // the scan entirely — keeping the steady-state cost at O(1) per tile.
    if (running > pacing.budgetBytes) {
      await ensureUnderBudget(pacing.budgetBytes);
      running = await cacheByteTotal(); // re-sync after a real eviction
    }
  }
}
