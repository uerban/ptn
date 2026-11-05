import { tilesForViewport, tileKeyAt, type Bbox } from "@pt/shared/poi";
import type { PoiIndexRecord } from "../db/index.ts";
import type { CityPoiTiling } from "./poiManifest.ts";
import type { TileLoader } from "./tileLoader.ts";
import type { SearchPrefetchDriver } from "./searchSuggestions.ts";
import {
  awaitTileGenerationReadBarrier,
  isPoiRecordInCurrentTileGeneration,
  isTileGenerationHydrated,
} from "./tileCache.ts";
import {
  orderViewportFirst,
  runViewportPrefetch,
  type PrefetchPacing,
  type PrefetchPlan,
} from "./poiSearchStream.ts";

/** Injected deps so the fan-out + flush logic is unit-testable without booting
 *  the app or touching IndexedDB (Search.tsx wires the real impls). */
export interface SearchPrefetchDriverDeps {
  /** Frontend cityId → the POI cityIds whose corpora make up its search union.
   *  MUST match searchSuggestionsStream's union (poiCityIds) — see FIX 3. */
  poiCityIds: (frontendCityId: string) => string[];
  /** Resolve a POI city's shipped tiling (edge/anchor) or null when not tiled. */
  getTiling: (cityId: string) => Promise<CityPoiTiling | null>;
  /** The active per-POI-city tileLoader, or undefined (eager fallback). */
  getLoader: (cityId: string) => Pick<TileLoader, "prefetchTiles"> | undefined;
  /** The active frontend city's current viewport bbox. */
  getViewportBbox: () => Bbox;
  /** Read back the just-landed tile rows across the POI-city UNION (FIX 4:
   *  consistent with poiCityIds, not a single city). */
  readLandedRows: (cityIds: string[]) => Promise<PoiIndexRecord[]>;
  /** Schedule a task on idle (utils/idle.scheduleIdle in production). */
  scheduleIdle: (task: () => void) => unknown;
  /** The prefetch engine (poiSearchStream.runViewportPrefetch in production). */
  runPrefetch: typeof runViewportPrefetch;
  /** Active privacy-tier pacing (budget + est tile bytes). */
  getPacing: () => PrefetchPacing;
}

/** Builds the progressive-search prefetch driver.
 *
 *  FIX 3 (1→N fan-out): the registry (loaders, manifest tiling, tile poiIndex
 *  rows) is keyed by POI cityIds (gdansk/gdynia/sopot), not the frontend cityId
 *  (tricity). The driver therefore fans out over poiCityIds(frontendCityId): for
 *  EACH POI city it resolves that city's own (edgeKm, anchor) + loader, builds a
 *  PrefetchPlan from the active viewport bbox, and runs runViewportPrefetch. A
 *  POI city missing tiling or a loader is skipped (eager fallback). The per-city
 *  prefetches run SERIALLY (each awaited before the next) so the single shared
 *  tile-cache budget is enforced globally across the fan-out — see the loop
 *  comment — and they share ONE coalesced land callback.
 *
 *  FIX 4 (flush before resolve): the coalesced land schedules its DB read-back +
 *  onTileLanded on idle and returns immediately, so a land can still be pending
 *  when the prefetches resolve. The driver tracks the pending idle promise and
 *  AWAITS a final flush before returning, so the final landed rows are merged
 *  into the stream BEFORE its done:true emit and no onTileLanded fires after the
 *  driver resolves. The read-back is over the POI-city UNION (consistent with
 *  FIX 3). All flush work respects the abort signal. */
export function buildSearchPrefetchDriver(
  frontendCityId: string,
  deps: SearchPrefetchDriverDeps,
): SearchPrefetchDriver {
  const poiCities = deps.poiCityIds(frontendCityId);
  // Snapshot BEFORE any await, synchronously — this factory call happens in
  // the SAME tick as searchSuggestionsStream's own call site, strictly
  // BEFORE its initial DB scan (computeInitial) gets a chance to run. If
  // hydration was NOT yet installed for every POI city at this exact
  // moment, computeInitial()'s scan is racing hydration and may filter out
  // valid cached rows via isPoiRecordInCurrentTileGeneration (which reads
  // "no state yet" as "not current") — see the corrective re-emit below.
  const hydratedBeforeInitialScan = poiCities.every(isTileGenerationHydrated);
  // The factory is called before searchSuggestionsStream starts its initial DB
  // scan. Start both operations now so rows that land after that scan cannot be
  // mistaken for its warm corpus merely because the driver starts later.
  const warmBarrier = awaitTileGenerationReadBarrier(poiCities);
  const warmRows = deps.readLandedRows(poiCities);
  const warmSnapshot = Promise.all([warmBarrier, warmRows]).then(
    ([, rows]) => rows,
  );
  // A superseded query may abort before invoking its driver.
  void warmSnapshot.catch(() => undefined);

  return async (onTileLanded, signal) => {
    if (signal.aborted) return;

    // ONE coalesced land shared by every per-city prefetch: a burst of tile landings across cities
    // collapses into a single read-back + re-emit per idle tick ("at most one emit per idle tick").
    let landPending = false;
    // The in-flight coalesced-land promise, so the driver can await a final
    // flush before resolving (FIX 4). Reset to null once it settles.
    let pendingLand: Promise<void> | null = null;

    // Identities (osmId ?? id — the SAME key deduplicateRecords / scorePoiRecord use) already
    // passed to onTileLanded. readLandedRows returns the FULL accumulated tile corpus for the
    // POI-city union each tick, but mergeLanded scores ONLY the rows it is handed, so re-passing
    // already-emitted rows would re-score the whole corpus every tick — O(n^2) over a multi-tile
    // prefetch ("Bounded per-emit re-scan" / AC-17). Filter each land to the rows whose identity is
    // NOT yet in `seen` so each emit's mergeLanded work is bounded to genuinely-new rows (total
    // O(n)). A row's score is deterministic for a fixed query+hint, so a row already scored+merged
    // need not be re-scored. `seen` is scoped to THIS invocation, so a fresh query/driver starts
    // empty.
    const seen = new Set<string>();

    const runCoalescedLand = async (): Promise<void> => {
      landPending = false;
      if (signal.aborted) return;
      await awaitTileGenerationReadBarrier(poiCities);
      if (signal.aborted) return;
      const landed = await deps.readLandedRows(poiCities);
      if (signal.aborted) return;
      const fresh: PoiIndexRecord[] = [];
      for (const rec of landed) {
        if (!isPoiRecordInCurrentTileGeneration(rec)) continue;
        const identity = rec.osmId ?? rec.id;
        if (seen.has(identity)) continue;
        seen.add(identity);
        fresh.push(rec);
      }
      await onTileLanded(fresh);
    };

    const coalescedLand = (): void => {
      if (landPending || signal.aborted) return;
      landPending = true;
      // Capture the idle-scheduled work as a promise the driver can await.
      pendingLand = new Promise<void>((resolve) => {
        deps.scheduleIdle(() => {
          runCoalescedLand().then(resolve, resolve);
        });
      });
    };

    // WARM-CACHE SEED: tile rows already present in poiIndex at search start were
    // already scanned+scored by the stream's INITIAL emit. readLandedRows returns
    // the FULL accumulated loadSource:'tile' corpus on every tick, so the first
    // coalesced land would otherwise treat the entire warm corpus as new and
    // re-score it — defeating the bounded path for warmed caches (AC-17). Read the
    // pre-existing rows ONCE before the stream's initial scan and seed `seen` with
    // their identities, but do NOT emit them (the initial scan handles them). The
    // serial prefetch + coalesced lands then pass only genuinely-NEW rows. Same
    // poiCities union the fan-out uses (FIX 3/4), so both corpora match.
    if (signal.aborted) return;
    const warm = await warmSnapshot;
    if (signal.aborted) return;
    for (const rec of warm) {
      if (!isPoiRecordInCurrentTileGeneration(rec)) continue;
      seen.add(rec.osmId ?? rec.id);
    }

    // Offline/cold-boot correction: if hydration had NOT yet installed for
    // every POI city before this factory call (`hydratedBeforeInitialScan`),
    // computeInitial()'s scan ran concurrently with (not after) hydration and
    // may have filtered out EVERY cached row via isPoiRecordInCurrentTileGeneration
    // (no generation state ⇒ "not current"). By this point hydration is
    // confirmed complete (`warmBarrier` awaited above), so force ONE
    // corrective re-emit of the warm corpus — mergeLanded re-validates each
    // row against the now-hydrated state and includes whatever is genuinely
    // current. Without this, a fully offline session where every relevant
    // tile is already a cache hit (so the driver below never lands anything
    // new) would leave the initial under-count as the stream's FINAL state.
    if (!hydratedBeforeInitialScan && warm.length > 0 && !signal.aborted) {
      await onTileLanded(warm);
    }

    const pacing = deps.getPacing();

    // SERIAL fan-out (single shared budget authority): each POI city's prefetch
    // is awaited before the next starts, so runViewportPrefetch reads
    // cacheByteTotal() AFTER the prior city's admissions. Running them
    // concurrently (Promise.all) would let every city observe the same initial
    // total and each admit up to the FULL m11TileCacheBudgetBytes — the shared
    // poiTileCache could transiently exceed the privacy-tier budget by ~N× and
    // thrash (admit → another city's post-insert ensureUnderBudget evicts →
    // refetch), violating the spec's SINGLE budget-authority invariant
    // ( / AC-11 / AC-11b: no pacer/evictor disagreement, no eviction churn).
    for (const cityId of poiCities) {
      if (signal.aborted) break;
      const tiling = await deps.getTiling(cityId);
      if (!tiling || signal.aborted) continue; // not tiled → no progressive re-emit
      const loader = deps.getLoader(cityId);
      if (!loader) continue; // no lazy-tile loader for this city (eager fallback)
      const plan = buildPlan(cityId, deps.getViewportBbox(), tiling);
      await deps.runPrefetch(plan, pacing, signal, coalescedLand, loader);
    }

    // FIX 4: a coalesced land scheduled by the last admitted tile may still be
    // pending. Await it (and any land it chains) so the final landed rows merge
    // before the stream's done:true emit, and no onTileLanded fires after the
    // driver resolves. Loop because a flush could schedule a follow-up land.
    while (pendingLand && !signal.aborted) {
      const inFlight = pendingLand;
      pendingLand = null;
      await inFlight;
    }
  };
}

function buildPlan(cityId: string, bbox: Bbox, tiling: CityPoiTiling): PrefetchPlan {
  const all = tilesForViewport(cityId, bbox, tiling.edgeKm, tiling.anchor);
  const centerTile = tileKeyAt(
    cityId,
    (bbox.minLat + bbox.maxLat) / 2,
    (bbox.minLon + bbox.maxLon) / 2,
    tiling.edgeKm,
    tiling.anchor,
  );
  return {
    cityId,
    edgeKm: tiling.edgeKm,
    anchor: tiling.anchor,
    orderedTileKeys: orderViewportFirst(centerTile, all),
  };
}
