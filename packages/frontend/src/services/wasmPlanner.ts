import type { RaptorQuery, RaptorItinerary } from "@pt/shared";
import {
  PtEngineMisconfiguredError,
  StaleWasmInitError,
  PtWasmImportError,
  PtWasmInitError,
  PtWasmQueryError,
  PtWasmTimeError,
  PtWasmTransfersError,
  planWithWasm,
  type PtRouterHandle,
  type ResolvedServiceTime,
} from "./raptorWasm.ts";

/**
 * Everything the on-device planning boundary needs to resolve a live
 * `PtRouter` for one search. Sourced from `gtfsDataStore` by the caller so
 * the handle is re-read at each await boundary rather than captured once.
 */
export interface WasmPlanContext {
  /** City the search targets — used to build/await the right wasm router. */
  cityId: string;
  /** Store's current router handle. Advisory only: `ensureWasmReady` is
   *  authoritative whenever it is wired (see `planOnDevice`). */
  ptRouter: PtRouterHandle | null;
  /**
   * Wasm lifecycle snapshot from `gtfsDataStore`. When present, a terminal
   * `failed` at THIS city/generation short-circuits instead of re-awaiting a
   * build the store already gave up on.
   */
  wasmEngine?: {
    status: "idle" | "loading" | "ready" | "failed";
    cityId: string | null;
    initGeneration: number | null;
    error: string | null;
    initPromise: Promise<PtRouterHandle> | null;
  };
  /** Build-or-await the live wasm router for `cityId`
   *  (`gtfsDataStore.ensureWasmReady`). */
  ensureWasmReady?: (cityId: string) => Promise<PtRouterHandle>;
  /**
   * Live init-generation reader (`gtfsDataStore.getInitGeneration`).
   * Snapshotted at plan start; if it changes across the wasm await (a reset /
   * city switch / refresh bumped it), the search is obsolete and is dropped as
   * a `StaleWasmInitError` even when the failure surfaced as a generic init
   * TIMEOUT rather than the store's own staleness throw (the timeout can fire
   * before a stale build settles). Absent on pure-snapshot callers → no
   * generation guard.
   */
  getInitGeneration?: () => number;
}

/** Bounded wasm-init wait so a never-resolving build can't hang search forever. */
const WASM_INIT_TIMEOUT_MS = 8_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Errors that already carry their own engine-failure classification
 *  (`classifyEngineFailure`); anything else is wrapped as a setup failure. */
function isTypedEngineError(err: unknown): boolean {
  return err instanceof PtWasmImportError
    || err instanceof PtWasmInitError
    || err instanceof PtWasmQueryError
    || err instanceof PtWasmTimeError
    || err instanceof PtWasmTransfersError
    || err instanceof PtEngineMisconfiguredError;
}

/**
 * Run `run` against the live on-device router for the search's city and
 * generation. This is the single boundary that turns router lifecycle failures
 * into the typed errors the routing store classifies:
 *
 *  1. A terminal `failed` lifecycle for THIS city AND generation throws
 *     immediately — `ensureWasmReady` would only re-reject. The guards on
 *     `cityId` and `initGeneration` keep a stale failure from suppressing a
 *     fresh build after a city switch or a refresh.
 *  2. Otherwise ALWAYS re-resolve through `ensureWasmReady` rather than
 *     trusting the bare `ctx.ptRouter`: `init()` installs the new
 *     `raptorIndex`/`loadedCityId` BEFORE the new router is built, so during a
 *     city switch `ctx.ptRouter` can still hold the PREVIOUS city's handle (and
 *     on a refresh a previous-generation handle). `ensureWasmReady` returns the
 *     router live for THIS city at the CURRENT generation — synchronously on
 *     the ready fast path, or building/awaiting a fresh one under
 *     `WASM_INIT_TIMEOUT_MS`.
 *  3. A superseding `reset()` / city switch / refresh surfaces as
 *     `StaleWasmInitError` and is re-thrown so the caller DROPS the obsolete
 *     search instead of publishing a result for the old city/query.
 *
 * A non-empty `cityId` is required: `SearchConfig.cityId` is optional, so a
 * caller that omits it arrives as `""`. An empty city can't drive a valid build
 * — calling `ensureWasmReady("")` would fetch `/api//raptor-bundle` — so that
 * is a setup failure, not a build attempt.
 */
async function withOnDeviceRouter<T>(
  ctx: WasmPlanContext,
  run: (router: PtRouterHandle) => T | Promise<T>,
): Promise<T> {
  // Snapshot the init generation BEFORE the wasm await so the catch can tell a
  // generation bump (reset/city-switch/refresh) from a genuine failure — even
  // when the await surfaced a generic timeout rather than the store's
  // StaleWasmInitError.
  const genAtStart = ctx.getInitGeneration?.();
  try {
    let router = ctx.ptRouter;
    if (
      !router &&
      ctx.wasmEngine?.status === "failed" &&
      ctx.wasmEngine.cityId === ctx.cityId &&
      (genAtStart === undefined || ctx.wasmEngine.initGeneration === genAtStart)
    ) {
      throw new PtEngineMisconfiguredError(
        ctx.wasmEngine.error ?? "wasm engine failed to initialize",
      );
    }
    if (ctx.ensureWasmReady && ctx.cityId) {
      router = await withTimeout(ctx.ensureWasmReady(ctx.cityId), WASM_INIT_TIMEOUT_MS, "wasm init timed out");
    }
    if (!router) {
      throw new PtEngineMisconfiguredError(
        ctx.cityId
          ? "wasm engine unavailable"
          : "no city selected — cannot build the on-device routing engine",
      );
    }
    return await run(router);
  } catch (err) {
    // A stale init result means a reset()/city-switch/refresh invalidated this
    // build mid-flight: the whole search is obsolete (a superseding search is
    // already in flight for the new generation). Re-throw so the caller drops
    // it rather than surfacing an engine error for a query nobody is waiting on.
    if (err instanceof StaleWasmInitError) throw err;
    // Same obsolescence, but surfaced as a GENERIC error (e.g. the init timeout
    // firing before a stale build settled): if the generation moved while we
    // awaited, the search is stale too.
    if (genAtStart !== undefined && ctx.getInitGeneration?.() !== genAtStart) {
      throw new StaleWasmInitError();
    }
    if (isTypedEngineError(err)) throw err;
    // Untyped setup failure (init timeout, ensureWasmReady rejection). Wrap so
    // the store's engine-error path recognises it instead of rendering it as a
    // generic search error.
    throw new PtEngineMisconfiguredError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Resolve one absolute departure instant to its service date and GTFS `Time`
 * through the bundle's own service-day origins (`PtRouter.resolveTime`). Every
 * on-device search starts here: the engine plans in that frame, so a DST date
 * is handled by the bundle rather than by a device or feed wall clock. A v1
 * bundle has no origins and rejects as a typed engine error.
 */
export async function resolveDepartureOnDevice(
  departureUnix: number,
  ctx: WasmPlanContext,
): Promise<ResolvedServiceTime> {
  return withOnDeviceRouter(ctx, (router) => router.resolveTime(departureUnix));
}

/**
 * Plan one search on the on-device engine for service day `date`. `pt-wasm` /
 * `pt-core` is the only on-device engine: a setup or query failure throws a
 * TYPED engine error for the routing store to surface, and no partial or
 * substitute itineraries are returned. `query.departureSecs` is GTFS `Time` in
 * `date`'s frame, as produced by `resolveDepartureOnDevice`.
 */
export async function planOnDevice(
  query: RaptorQuery,
  ctx: WasmPlanContext,
  date: string,
): Promise<RaptorItinerary[]> {
  return withOnDeviceRouter(ctx, (router) => planWithWasm(router, query, date));
}
