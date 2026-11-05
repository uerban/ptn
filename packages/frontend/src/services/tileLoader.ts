import type { Bbox, PoiEntry, PoiTileBounds, TileAnchor } from "@pt/shared";
import { tilesForViewport } from "@pt/shared/poi";
import { db, type PoiIndexRecord } from "../db/index.ts";
import {
  assertPersistedTileGeneration,
  cachedTileKeysForGeneration,
  ensureUnderBudget,
  generationTileKey,
  getTile,
  isCurrentTileGeneration,
  prepareTileGeneration,
  putTile,
  StalePoiTileGenerationError,
  type PoiTileGeneration,
} from "./tileCache.ts";
import { invalidateCityPoiTiling } from "./poiManifest.ts";
import { getPolicy, hasCityBeenPrefetched, markCityPrefetched } from "../stores/privacyStore.ts";
import { entryToRecord } from "./poiLoader.ts";
import { decompressBrotli } from "./brotliDecode.ts";
import { reportError, reportTelemetry } from "./errorReporter.ts";
import { dispatchTileLoad, startDecoyTimer, type DecoyTimerController } from "./tileDefense.ts";

const DEFAULT_DEBOUNCE_MS = 500;

interface TilePayload {
  tileKey: string;
  entries: PoiEntry[];
}

interface TileFetchResult {
  stopReason: "delivery-disabled" | "generation-mismatch" | null;
  insertedBytes: number;
}

interface TileLoadFlight {
  controller: AbortController;
  participants: number;
  settled: boolean;
  bytesClaimed: boolean;
  promise: Promise<TileFetchResult>;
}

const tileLoadFlights = new Map<string, TileLoadFlight>();

export interface TileLoaderOptions {
  cityId: string;
  /** Per-city tile edge (from manifest tiling). REQUIRED — no global default. */
  edgeKm: number;
  /** Per-city tile anchor (from manifest tiling). REQUIRED. */
  anchor: TileAnchor;
  /** SHA-256 of the strict bundle generation advertised by manifest v3. */
  bundleSha256: string;
  /** SHA-256 digest of the complete local tiling contract. */
  generationId: string;
  /** Client-serving grid bounds (manifest v3 `tileBounds`). Optional —
   * absent means the tile-defense prefetch/padding/decoy pool is empty, so
   * every strategy behaves like "none" (today's plain viewport behavior);
   * only a caller that supplies it gets the enriched behavior. */
  tileBounds?: PoiTileBounds;
  /** Called once after a 409 or transaction-time generation revocation. */
  onGenerationMismatch?: () => void;
  fetchImpl?: typeof fetch;
  debounceMs?: number;
  baseUrl?: string;
}

export interface TileLoader {
  loadViewport(bbox: Bbox): Promise<void>;
  /**
 * Thin, UN-PACED, UN-EVICTING fetch primitive used by the search stream's pacer
 * (runViewportPrefetch). Fetches the named tiles (skipping already-cached ones), aborts on
 * `signal`, and treats a city-wide 409 generation mismatch or 503 delivery-inactive response
 * like 404 (no reportError). It does NOT call ensureUnderBudget — runViewportPrefetch is the
 * sole pacer/evictor on the search path (the map path's runCycle owns its own eviction).
 * RETURNS a result flags distinguish permanent delivery disablement from a recoverable
 * generation mismatch.
 */
  prefetchTiles(tileKeys: string[], signal: AbortSignal): Promise<PrefetchResult>;
  dispose(): void;
}

export interface PrefetchResult {
  /** True only for 503 POI_TILE_DELIVERY_INACTIVE. */
  cityDeliveryDisabled: boolean;
  /** True for a recoverable 409/persisted-generation mismatch. */
  generationMismatch?: boolean;
  /** Sum of ACTUAL decoded `byteSize` of rows this call inserted into the cache.
   *  The pacer (runViewportPrefetch) adds this to its running counter instead of
   *  re-scanning the whole poiTileCache table per tile (the O(tiles^2) scan the
   * cost model bans). 0 when nothing new landed (all cached / all failed). */
  insertedBytes: number;
}

interface PendingCycle {
  resolvers: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
  }>;
  bbox: Bbox;
}

async function parseTilePayload(bytes: ArrayBuffer): Promise<TilePayload> {
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as TilePayload;
  } catch {
    const json = await decompressBrotli(bytes);
    return JSON.parse(json) as TilePayload;
  }
}

/** Enumerate every tile key inside the manifest's `tileBounds` grid — the
 * bounded "whole city" pool `dispatchTileLoad`/`startDecoyTimer` select
 * prefetch/padding/decoy candidates from. Empty when `bounds` is absent. */
function cityTileKeysFromBounds(
  cityId: string,
  edgeKm: number,
  bounds: PoiTileBounds | undefined,
): string[] {
  if (!bounds) return [];
  const keys: string[] = [];
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      keys.push(`${cityId}/${edgeKm}km/${x}_${y}`);
    }
  }
  return keys;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function waitForSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function joinTileLoad(
  flightKey: string,
  signal: AbortSignal,
  start: (signal: AbortSignal) => Promise<TileFetchResult>,
  claimInsertedBytes: boolean,
): Promise<TileFetchResult> {
  if (signal.aborted) throw abortError();

  let flight = tileLoadFlights.get(flightKey);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController();
    const nextFlight = {
      controller,
      participants: 0,
      settled: false,
      bytesClaimed: false,
    } as TileLoadFlight;
    nextFlight.promise = Promise.resolve()
      .then(() => start(controller.signal))
      .finally(() => {
        nextFlight.settled = true;
        if (tileLoadFlights.get(flightKey) === nextFlight) {
          tileLoadFlights.delete(flightKey);
        }
      });
    tileLoadFlights.set(flightKey, nextFlight);
    flight = nextFlight;
  }

  flight.participants += 1;
  try {
    const result = await waitForSignal(flight.promise, signal);
    const insertedBytes =
      claimInsertedBytes &&
      result.insertedBytes > 0 &&
      !flight.bytesClaimed
        ? result.insertedBytes
        : 0;
    if (insertedBytes > 0) flight.bytesClaimed = true;
    return { ...result, insertedBytes };
  } finally {
    flight.participants -= 1;
    if (flight.participants === 0 && !flight.settled) {
      flight.controller.abort();
    }
  }
}

export function createTileLoader(opts: TileLoaderOptions): TileLoader {
  const { cityId, edgeKm, anchor, bundleSha256, generationId } = opts;
  if (!/^[0-9a-f]{64}$/.test(bundleSha256)) {
    throw new Error("bundleSha256 must be a lowercase 64-character SHA-256");
  }
  if (!/^[0-9a-f]{64}$/.test(generationId)) {
    throw new Error("generationId must be a lowercase 64-character SHA-256");
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const baseUrl = opts.baseUrl ?? "";
  const generation: PoiTileGeneration = {
    cityId,
    bundleSha256,
    generationId,
  };

  let pending: PendingCycle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const generationReady = prepareTileGeneration(generation);
  const controller = new AbortController();
  let disposed = false;
  let cityDeliveryDisabled = false;
  let generationMismatch = false;
  let generationMismatchWork: Promise<void> | null = null;

  // Tile-defense (spec M11): the bounded "whole city" pool prefetch/padding/
  // decoy strategies select from, and the shared decoy-timer handle. The
  // "already bulk-prefetched this city" flag lives in privacyStore, NOT a
  // local variable — it is the SINGLE budget authority shared by both the
  // map path (runCycle) and the search path (prefetchTiles) below, and
  // survives a loader recreation (e.g. a generation-mismatch retry).
  const cityTileKeys = cityTileKeysFromBounds(cityId, edgeKm, opts.tileBounds);
  let decoyTimer: DecoyTimerController | null = null;

  function reconcileDecoyTimer(shouldBeActive: boolean): void {
    if (disposed) return;
    if (shouldBeActive && !decoyTimer) {
      decoyTimer = startDecoyTimer({
        cityTileKeys,
        onFire: (tileKey) =>
          loadTile(tileKey, controller.signal, false).then(
            () => undefined,
            () => undefined,
          ),
      });
    } else if (!shouldBeActive && decoyTimer) {
      decoyTimer.stop();
      decoyTimer = null;
    }
  }

  /** Enrich `realTileKeys` per the active privacy policy's tile-defense
   * strategy: prefetch the whole city pool once, pad with decoys, and/or
   * keep a background decoy timer running. Shared by both the map path
   * (viewport tiles) and the search path (pacer-selected tiles) so a
   * Standard/Hardened/Strict/Paranoid tier applies identically regardless
   * of which path is driving the fetch. */
  async function planTileLoad(realTileKeys: readonly string[]): Promise<string[]> {
    const cachedKeys = await cachedTileKeysForGeneration(generation);
    const plan = dispatchTileLoad(realTileKeys, getPolicy(), {
      cityTileKeys,
      cachedKeys,
      prefetched: hasCityBeenPrefetched(cityId),
    });
    if (plan.markPrefetched) markCityPrefetched(cityId);
    reconcileDecoyTimer(plan.decoyTimerActive);
    return plan.tileKeys;
  }

  function prefetchResult(insertedBytes = 0): PrefetchResult {
    return { cityDeliveryDisabled, generationMismatch, insertedBytes };
  }

  function emptyFetch(
    stopReason: TileFetchResult["stopReason"] = null,
  ): TileFetchResult {
    return { stopReason, insertedBytes: 0 };
  }

  /** Read `error.code` from a JSON error body WITHOUT ever throwing.
   *
   *  Not every 503 on this path is a server-authored JSON error: nginx returns
   *  a bare HTML page when a rate-limit zone is full (see nginx.conf — ordinary
   *  throttling is 429, but zone exhaustion is 503), and any edge/LB in front
   *  of the stack can do the same. An unguarded `res.json()` on those rejects
   *  with a SyntaxError that escapes `fetchTile` into `runCycle`'s catch, which
   *  calls `reportError` — turning one saturation event into an error-report
   *  per tile at the default privacy tier. Returning null instead means
   *  "unknown 503", which callers must treat as transient. */
  async function readErrorCode(res: Response): Promise<string | null> {
    try {
      const body: unknown = await res.json();
      const code = (body as { error?: { code?: unknown } })?.error?.code;
      return typeof code === "string" ? code : null;
    } catch {
      return null;
    }
  }

  async function handleGenerationMismatch(): Promise<void> {
    generationMismatch = true;
    if (generationMismatchWork) return generationMismatchWork;
    generationMismatchWork = invalidateCityPoiTiling(cityId, generation).then(() => {
      opts.onGenerationMismatch?.();
    });
    return generationMismatchWork;
  }

  async function ensureGenerationReady(signal: AbortSignal): Promise<boolean> {
    try {
      await waitForSignal(generationReady, signal);
    } catch (error) {
      if (isAbortError(error)) return false;
      if (error instanceof StalePoiTileGenerationError) {
        await handleGenerationMismatch();
        return false;
      }
      throw error;
    }
    return !signal.aborted && isCurrentTileGeneration(generation);
  }

  /**
 * Returns the cache byteSize of the row it inserted (0 if 404/503/aborted — nothing landed), so
 * the search-path pacer can maintain a running counter instead of re-scanning the whole cache
 * table per tile.
 */
  async function fetchTile(
    tileKey: string,
    url: string,
    signal: AbortSignal,
  ): Promise<TileFetchResult> {
    if (signal.aborted || !isCurrentTileGeneration(generation)) {
      return emptyFetch();
    }
    const cached = await getTile(tileKey, generationId);
    if (cached || signal.aborted || !isCurrentTileGeneration(generation)) {
      return emptyFetch();
    }

    const res = await fetchImpl(url, {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) {
      if (res.status === 404) {
        return emptyFetch();
      }
      if (res.status === 409) {
        await handleGenerationMismatch();
        return emptyFetch("generation-mismatch");
      }
      if (res.status === 503) {
        // Branch on the error code, not the status. Only
        // POI_TILE_DELIVERY_INACTIVE is a durable per-city condition worth
        // latching `cityDeliveryDisabled` for — which is what this field's own
        // doc comment already promises.
        //
        // pt-serve also emits a TRANSIENT 503 POI_TILE_BUILD_BUSY when a cold
        // key is already building or the build pool is full; that is
        // deliberate load shedding, and Node never emits it at all because it
        // coalesces same-key builds instead. Latching on it disabled POI for
        // the whole session after a single cold-start collision. Unknown or
        // unparseable 503s (nginx zone-full HTML, an edge/LB error) are
        // likewise transient and must not latch.
        const code = await readErrorCode(res);
        return code === "POI_TILE_DELIVERY_INACTIVE"
          ? emptyFetch("delivery-disabled")
          : emptyFetch();
      }
      throw new Error(`tile fetch ${tileKey}: ${res.status}`);
    }
    const bytes = await res.arrayBuffer();
    if (signal.aborted || !isCurrentTileGeneration(generation)) {
      return emptyFetch();
    }
    const payload = await parseTilePayload(bytes);
    if (payload.tileKey !== tileKey) {
      throw new Error(
        `tile payload key mismatch: requested ${tileKey}, received ${payload.tileKey}`,
      );
    }
    if (signal.aborted || !isCurrentTileGeneration(generation)) {
      return emptyFetch();
    }

    const records: PoiIndexRecord[] = payload.entries.map((entry) => ({
      ...entryToRecord(entry, cityId),
      loadSource: "tile" as const,
      bundleSha256,
      tileGenerationId: generationId,
    }));

    const byteSize = bytes.byteLength;
    let inserted = false;
    let activeTransaction: { abort: () => void } | null = null;
    const abortTransaction = (): void => {
      activeTransaction?.abort();
    };
    signal.addEventListener("abort", abortTransaction, { once: true });
    try {
      try {
        await db.transaction(
          "rw",
          [db.poiTileGenerations, db.poiIndex, db.poiTileCache],
          async (transaction) => {
            activeTransaction = transaction;
            if (signal.aborted || !isCurrentTileGeneration(generation)) {
              throw abortError();
            }
            await assertPersistedTileGeneration(generation);
            if (records.length > 0) {
              await db.poiIndex.bulkPut(records);
            }
            if (signal.aborted || !isCurrentTileGeneration(generation)) {
              throw abortError();
            }
            await putTile(tileKey, generation, bytes, Date.now());
            if (signal.aborted || !isCurrentTileGeneration(generation)) {
              throw abortError();
            }
            inserted = true;
          },
        );
      } catch (error) {
        if (error instanceof StalePoiTileGenerationError) {
          await handleGenerationMismatch();
          return emptyFetch("generation-mismatch");
        }
        throw error;
      }
    } finally {
      signal.removeEventListener("abort", abortTransaction);
    }
    return {
      stopReason: null,
      insertedBytes: inserted ? byteSize : 0,
    };
  }

  async function loadTile(
    tileKey: string,
    signal: AbortSignal,
    claimInsertedBytes: boolean,
  ): Promise<number> {
    const url = `${baseUrl}/api/gtfs/poi-tile/${tileKey}?v=${bundleSha256}`;
    const result = await joinTileLoad(
      `${baseUrl}:${generationTileKey(tileKey, generationId)}`,
      signal,
      (flightSignal) => fetchTile(tileKey, url, flightSignal),
      claimInsertedBytes,
    );
    if (result.stopReason === "delivery-disabled") {
      cityDeliveryDisabled = true;
    } else if (result.stopReason === "generation-mismatch") {
      generationMismatch = true;
    }
    return result.insertedBytes;
  }

  async function runCycle(bbox: Bbox, signal: AbortSignal): Promise<void> {
    if (!(await ensureGenerationReady(signal))) return;
    // MAP path: this path IS its own pacer/evictor (nothing else paces it), so
    // it keeps the post-loop ensureUnderBudget. Genuine fetch failures here use
    // reportError (existing behavior — these are user-facing map loads).
    const viewportTileKeys = tilesForViewport(cityId, bbox, edgeKm, anchor);
    const tileKeys = await planTileLoad(viewportTileKeys);
    if (signal.aborted || !isCurrentTileGeneration(generation)) return;
    for (const tileKey of tileKeys) {
      if (
        signal.aborted ||
        cityDeliveryDisabled ||
        generationMismatch ||
        !isCurrentTileGeneration(generation)
      ) {
        return;
      }
      try {
        await loadTile(tileKey, signal, false);
      } catch (err) {
        if (signal.aborted) return;
        if (isAbortError(err)) return;
        reportError(err instanceof Error ? err : new Error(String(err)), {
          context: { source: "tileLoader.fetch", cityId, tileKey },
        });
      }
    }
    if (
      !signal.aborted &&
      !disposed &&
      !cityDeliveryDisabled &&
      !generationMismatch &&
      isCurrentTileGeneration(generation)
    ) {
      try {
        await ensureUnderBudget(getPolicy().m11TileCacheBudgetBytes);
      } catch (err) {
        reportError(err instanceof Error ? err : new Error(String(err)), {
          context: { source: "tileLoader.evict", cityId },
        });
      }
    }
  }

  /**
 * SEARCH path primitive. Thin and un-pacing: fetches the named tiles, skips cached ones, and
 * soft-stops on 409/503 without reportError. Does NOT call ensureUnderBudget —
 * runViewportPrefetch is the sole pacer/evictor on this path. Client-side prefetch errors
 * (offline/network reject, corrupt-bytes decode failure) emit a TELEMETRY BREADCRUMB, not a
 * reportError — an offline user mid-prefetch must not generate error-report noise. Returns
 * cityDeliveryDisabled so the pacer breaks its loop after a 503 (AC-21).
 */
  async function prefetchTiles(tileKeys: string[], signal: AbortSignal): Promise<PrefetchResult> {
    const combinedSignal = AbortSignal.any([controller.signal, signal]);
    if (
      disposed ||
      combinedSignal.aborted ||
      !(await ensureGenerationReady(combinedSignal))
    ) {
      return prefetchResult();
    }
    const plannedTileKeys = await planTileLoad(tileKeys);
    if (combinedSignal.aborted || disposed) return prefetchResult();
    let insertedBytes = 0;
    for (const tileKey of plannedTileKeys) {
      if (
        combinedSignal.aborted ||
        disposed ||
        cityDeliveryDisabled ||
        generationMismatch ||
        !isCurrentTileGeneration(generation)
      ) {
        break;
      }
      try {
        insertedBytes += await loadTile(tileKey, combinedSignal, true);
      } catch (err) {
        if (combinedSignal.aborted || disposed) break;
        if (isAbortError(err)) break;
        // Soft skip + breadcrumb (NOT reportError): offline/network-reject and
        // corrupt-bytes decode failures on the background prefetch path are
        // non-fatal — the corpus stays whatever already landed.
        reportTelemetry("poiTile.prefetchSkip", {
          cityId, tileKey, reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return prefetchResult(insertedBytes);
  }

  function flushPending(): void {
    if (!pending) return;
    const cycle = pending;
    pending = null;
    timer = null;
    const signal = controller.signal;
    runCycle(cycle.bbox, signal).then(
      () => cycle.resolvers.forEach((r) => r.resolve()),
      (err) => cycle.resolvers.forEach((r) => r.reject(err)),
    );
  }

  function loadViewport(bbox: Bbox): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!pending) {
      pending = { resolvers: [], bbox };
    } else {
      pending.bbox = bbox;
    }
    const p = new Promise<void>((resolve, reject) => {
      pending!.resolvers.push({ resolve, reject });
    });
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flushPending, debounceMs);
    return p;
  }

  function dispose(): void {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (decoyTimer) {
      decoyTimer.stop();
      decoyTimer = null;
    }
    if (pending) {
      const cycle = pending;
      pending = null;
      cycle.resolvers.forEach((r) => r.resolve());
    }
    controller.abort();
  }

  return { loadViewport, prefetchTiles, dispose };
}
