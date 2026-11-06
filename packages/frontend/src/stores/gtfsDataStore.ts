import {restoreDeviceCity, hasLiveDeviceCity} from "../services/deviceCities.ts";
import { create } from "zustand";
import { syncGtfsData, needsSync, clearGtfsData } from "../services/gtfsSync.ts";
import { buildRaptorIndex, type RaptorIndex } from "../services/raptorIndex.ts";
import { GTFS_CLIENT_REFRESH_INTERVAL_MS } from "@pt/shared/constants";
import { osrmClient } from "../services/osrmWasm.ts";
import { ensureDbReady } from "../db/migrationRunner.ts";
import { db } from "../db/index.ts";
import { initOrSwapPtRouter } from "../services/wasmLifecycle.ts";
import { StaleWasmInitError, type PtRouterHandle } from "../services/raptorWasm.ts";

/**
 * Fire-and-forget per-city eager-init: OSRM walking-cache warm + PtRouter
 * build/swap. Called from all three `set({raptorIndex, ...})` callsites so the
 * warm-restart path covers the routing engine too. A rejection here is not
 * fatal by itself — it lands the lifecycle in `failed`, and the FIRST search
 * that needs the router surfaces it as a typed engine error (there is no
 * second on-device engine to fall back to).
 */
function startEagerInitForCity(cityId: string): void {
  osrmClient.init(cityId, { signal: initAbort?.signal }).catch((err) => {
    console.warn("OSRM eager init failed:", err);
  });
  startPtRouterBuild(cityId);
}

/**
 * Start (or join) the PtRouter build from the cached bytes. Repeat calls at
 * the same city and generation share one build (`ensureWasmReady` dedupes).
 */
function startPtRouterBuild(cityId: string): void {
  useGtfsDataStore.getState().ensureWasmReady(cityId, { preferCache: true }).catch((err) => {
    console.warn("PtRouter eager init failed; the next search surfaces it as an engine error:", err);
  });
}

/** Discriminant for the wasm-engine init lifecycle (the planning boundary reads this). */
type WasmEngineStatus = "idle" | "loading" | "ready" | "failed";

/**
 * Explicit lifecycle for the wasm PtRouter build, consumed by the on-device
 * planning boundary (`wasmPlanner.ts`): `loading` → await the in-flight build
 * (bounded); `failed` → surface the recorded error without re-awaiting a build
 * the store already gave up on. The `{cityId, initGeneration}` pair binds a
 * `ready` router to the exact city/generation it was built for, so a stale
 * build (post-reset or post-city-switch) can never be reported `ready`.
 */
interface WasmEngineState {
  status: WasmEngineStatus;
  /** City the in-flight/last build targeted. */
  cityId: string | null;
  /** `getInitGeneration()` snapshot the build was started under. */
  initGeneration: number | null;
  /** Failure message when `status === "failed"`, else `null`. */
  error: string | null;
  /** The in-flight `ensureWasmReady` promise (for `loading` dedupe), else `null`. */
  initPromise: Promise<PtRouterHandle> | null;
}

/** Fresh idle lifecycle tuple — a factory so no two slots share one object. */
function idleWasmEngine(): WasmEngineState {
  return { status: "idle", cityId: null, initGeneration: null, error: null, initPromise: null };
}

interface GtfsDataState {
  raptorIndex: RaptorIndex | null;
  /** Pre-built stop ID → name lookup (built once at sync/init time). */
  stopNames: Map<string, string> | null;
  /** The city whose GTFS data the current raptorIndex was built from. */
  loadedCityId: string | null;
  /**
 * The bundle's agency tz (`RaptorIndex.cityTzIana`, ultimately from `meta.cityTzIana`) of the
 * currently-loaded index. `null` when the index came from the Dexie fallback or the bundle
 * carried no tz. Set at EVERY install site so the tz drift indicator surfaces on the warm-start
 * path (cached build), not only on a fresh fetch ([v4 BLOCKING #1]).
 */
  bundleCityTzIana: string | null;
  syncing: boolean;
  error: string | null;
  /**
   * Live `pt-wasm` PtRouter handle. `null` until the bytes
   * have been fetched and `buildPtRouter()` has resolved; nulled again
   * on `reset()` and on `setPtRouter(null)`. Lifecycle is managed by
   * `setPtRouter` / `swapPtRouter` — never mutate `ptRouter` directly
   * via `set()` from outside this store.
 *

 * * **Late-install race (callers MUST guard):** `buildPtRouter` is async; a caller that awaits
 * it across a `reset()` (or a city switch that bumps `initGeneration`) must snapshot
 * `initGeneration` before the await and either drop the orphan (call `.free()` on it) or
 * `setPtRouter` only if the generation still matches. Without this, a late-resolving build
 * clobbers the post-reset store and never gets freed.
 */
  ptRouter: PtRouterHandle | null;
  /**
 * Lifecycle of the wasm PtRouter build. Mutated ONLY by `ensureWasmReady` (loading/ready/failed
 * transitions) and `reset()` (back to idle). The dispatcher reads `status` to decide
 * await-vs-fallback and never reaches into a router whose `{cityId, initGeneration}` doesn't
 * match the live build.
 */
  wasmEngine: WasmEngineState;
  /**
   * Resolve to a wasm PtRouter that is live for `cityId` at the CURRENT init
   * generation, building one if needed. Dedupes concurrent callers onto a
   * single `initOrSwapPtRouter` build (eager-init + a racing search share the
   * same promise). Rejects with `StaleWasmInitError` if a `reset()` or city
   * switch invalidated the build before it installed — staleness leaves the
   * lifecycle `idle` (never `failed`), and the planning boundary re-throws it so
   * the obsolete search is DROPPED rather than published over the new query. A
   * genuine build rejection lands the lifecycle in `failed` and is NOT retried
   * at the same city/generation.
   */
  ensureWasmReady: (cityId: string, opts?: { preferCache?: boolean }) => Promise<PtRouterHandle>;
  init: (cityId: string, opts?: {preferDownload?: boolean}) => Promise<void>;
  refresh: (cityId: string, opts?: {requireNetwork?: boolean}) => Promise<void>;
  reset: () => Promise<void>;
  /**
   * Set the live PtRouter handle. If an older handle was installed and
   * differs from the new value (including `null`), the old handle is
   * freed synchronously. Use `swapPtRouter` instead during a hot swap
   * where in-flight `plan()` calls may still hold the old handle.
   */
  setPtRouter: (r: PtRouterHandle | null) => void;
  /**
 * Atomic swap: install `newRouter` immediately, then defer `old.free()` to the next macrotask
 * so any in-flight `plan()` call that already captured the old handle gets to finish before the
 * wasm heap is torn down (panel engineer #2).
 */
  swapPtRouter: (newRouter: PtRouterHandle) => void;
  /**
   * Returns the current monotonic init generation token. Bumped on every
   * `init()` / `refresh()` start and on `reset()`. Callers doing async
   * work that resolves into a store install (e.g.
   * `wasmLifecycle.initOrSwapPtRouter`) MUST snapshot this before the
   * await and compare after — orphan if mismatched. Reference-equality
   * on `ptRouter` is insufficient: a `reset()` followed by no init
   * leaves `ptRouter === null` both before and after, defeating any
   * snapshot-by-reference check.
   */
  getInitGeneration: () => number;
  /**
   * AbortSignal for the CURRENT init generation (F9), rotated on every
   * generation bump. Byte fetches keyed to a generation (transfers artifact,
   * OSRM graph) pass this to `fetch` so a city switch aborts them instead of
   * letting the download complete only to be discarded. `undefined` before
   * the first `init()`.
   */
  getInitAbortSignal: () => AbortSignal | undefined;
}

/**
 * Startup sequence:
 * 1. ensureDbReady() — open DB, run Dexie migrations, recover if corrupted
 * 2. needsSync() — check if GTFS data is stale or missing
 * 3. syncGtfsData() — fetch + transactionally write GTFS to IndexedDB
 * 4. buildRaptorIndex() — build in-memory RAPTOR structures from IndexedDB
 * 5. osrmClient.init() — eagerly load OSRM WASM (non-blocking)
 * 6. RT polling starts only after raptorIndex is non-null
 */

// Generation counter to discard results from stale init/refresh calls
// after a reset() or newer init/refresh has started.
let initGeneration = 0;

/**
 * AbortController keyed to the CURRENT init generation (F9). Bumping the
 * generation aborts the previous generation's in-flight byte fetches
 * (transfers artifact, OSRM graph) instead of letting a city switch's
 * download run to completion only to be discarded by the post-await
 * generation guards. Those guards stay — the signal removes wasted
 * downloads, they remove stale installs.
 */
let initAbort: AbortController | null = null;

/** Bump the generation and rotate the abort controller with it. */
function bumpInitGeneration(): number {
  initAbort?.abort();
  initAbort = new AbortController();
  return ++initGeneration;
}

/**
 * Upper bound on a single wasm PtRouter build. The LIFECYCLE owner enforces it
 * (not just the per-search dispatch): a build that hangs — e.g. a stalled
 * `fetchPtbBytes` with no network timeout — would otherwise leave `wasmEngine`
 * stuck `loading` forever, and every later search would dedupe onto that
 * never-settling `initPromise` and wait the full timeout again. Bounding it
 * here transitions the lifecycle to `failed` ONCE, so subsequent searches fail
 * fast with the recorded error (until a generation bump retries). Mirrors the
 * planning boundary's `WASM_INIT_TIMEOUT_MS` (wasmPlanner.ts), which stays as a
 * per-search safety net.
 */
const WASM_INIT_TIMEOUT_MS = 8_000;

/** Reject `promise` after `ms` so a hung build can't pin the lifecycle. */
function withInitTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("wasm init timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Build a stop ID → name map from IndexedDB (called once at sync/init). */
async function buildStopNames(): Promise<Map<string, string>> {
  const allStops = await db.gtfsStops.toArray();
  const map = new Map<string, string>();
  for (const s of allStops) {
    map.set(s.id, s.name);
  }
  return map;
}

export const useGtfsDataStore = create<GtfsDataState>()((set, get) => ({
  raptorIndex: null,
  stopNames: null,
  loadedCityId: null,
  bundleCityTzIana: null,
  syncing: false,
  error: null,
  ptRouter: null,
  wasmEngine: idleWasmEngine(),

  getInitGeneration: () => initGeneration,
  getInitAbortSignal: () => initAbort?.signal,

  ensureWasmReady(cityId: string, opts: { preferCache?: boolean } = {}): Promise<PtRouterHandle> {
    // Snapshot the generation BEFORE anything: every staleness decision below
    // compares against this token so a reset()/city-switch mid-build is
    // detected even when ptRouter was null both before and after.
    const gen = get().getInitGeneration();
    const we = get().wasmEngine;

    // Ready fast-path: a live router already built for THIS city at THIS
    // generation. `loadedCityId === cityId` guards against a router that was
    // right when built but whose index has since moved to another city.
    const currentRouter = get().ptRouter;
    if (
      we.status === "ready" &&
      currentRouter &&
      we.cityId === cityId &&
      we.initGeneration === gen &&
      get().loadedCityId === cityId
    ) {
      return Promise.resolve(currentRouter);
    }

    // Loading dedupe: an in-flight build for the same city/generation — hand
    // back the SAME promise so eager-init and a concurrent search share one
    // initOrSwapPtRouter call.
    if (
      we.status === "loading" &&
      we.initPromise &&
      we.cityId === cityId &&
      we.initGeneration === gen
    ) {
      return we.initPromise;
    }

    // No-retry on a terminal failure at the same city/generation. A changed
    // city or a bumped generation falls through to a fresh start below.
    if (we.status === "failed" && we.cityId === cityId && we.initGeneration === gen) {
      return Promise.reject(new Error(we.error ?? "wasm engine failed to initialize"));
    }

    const initPromise = (async (): Promise<PtRouterHandle> => {
      let router: PtRouterHandle;
      try {
        router = await withInitTimeout(initOrSwapPtRouter(cityId, opts), WASM_INIT_TIMEOUT_MS);
      } catch (err) {
        // A reset/city-switch mid-build is staleness, not a failure: don't
        // record `failed` (it must not clobber the post-reset idle state) and
        // surface a StaleWasmInitError so the planning boundary DROPS the
        // obsolete search instead of reporting an engine error for a query
        // nobody is waiting on. Without this, a build that REJECTS (vs.
        // resolves) after a generation bump would rethrow the raw build error,
        // which `planOnDevice` can't recognise as stale — the post-resolve
        // guard below already throws
        // StaleWasmInitError, so this keeps the reject path consistent.
        if (get().getInitGeneration() !== gen) {
          throw new StaleWasmInitError();
        }
        // Genuine build failure at the current generation. The transition lives
        // INSIDE this catch (not a blanket outer `.catch`) so the stale-idle
        // path below can't be flipped to `failed`.
        set({
          wasmEngine: {
            status: "failed",
            cityId,
            initGeneration: gen,
            error: err instanceof Error ? err.message : String(err),
            initPromise: null,
          },
        });
        throw err;
      }

      // Staleness guard: a reset()/city switch landed during the build, or
      // initOrSwapPtRouter orphaned (freed) the router instead of installing
      // it. Never report `ready` unless `router` is the live, current-
      // generation, current-city handle. A null `loadedCityId` means no
      // index yet, not another city: a warm start builds the engine alongside
      // its index, and reset() and a city switch both bump the generation.
      const loaded = get().loadedCityId;
      if (
        get().getInitGeneration() !== gen ||
        (loaded !== null && loaded !== cityId) ||
        get().ptRouter !== router
      ) {
        // Still the current generation but the build didn't install? Reset the
        // lifecycle to idle for this generation (the reset()/new-generation
        // paths already set idle for the other cases). Staleness is NOT a
        // failure.
        if (get().getInitGeneration() === gen) {
          set({ wasmEngine: idleWasmEngine() });
        }
        throw new StaleWasmInitError();
      }

      set({
        wasmEngine: {
          status: "ready",
          cityId,
          initGeneration: gen,
          error: null,
          initPromise: null,
        },
      });
      return router;
    })();

    // Publish `loading` SYNCHRONOUSLY before returning so a concurrent caller
    // (eager-init vs. a racing search) dedupes onto `initPromise` above.
    set({
      wasmEngine: { status: "loading", cityId, initGeneration: gen, error: null, initPromise },
    });
    return initPromise;
  },

  setPtRouter: (r) => {
    const old = get().ptRouter;
    set({ ptRouter: r });
    // Explicit null also frees the prior handle (panel qa MEDIUM).
    if (old && old !== r) {
      old.free();
    }
  },

  swapPtRouter: (newRouter) => {
    const old = get().ptRouter;
    set({ ptRouter: newRouter });
    if (old && old !== newRouter) {
      // Defer the free() to the next macrotask so any in-flight
      // synchronous `plan()` call that already captured `old` runs to
      // completion before the wasm heap is torn down (panel engineer
      // #2 — synchronous free mid-plan corrupted results / SIGSEGVed
      // the wasm linear memory). On the in-process path the wasm side of
      // `plan()` is synchronous within a single call, so the macrotask
      // boundary is enough. A worker-hosted router's own `free()` waits
      // for its in-flight calls before terminating the worker.
      setTimeout(() => old.free(), 0);
    }
  },

  async init(cityId: string, opts: {preferDownload?: boolean} = {}) {
    if (get().syncing) return;
    const gen = bumpInitGeneration();
    const signal = initAbort?.signal;
    performance.mark("ptn:gtfs-init-start");
    // Mark syncing immediately to prevent stale-index searches while
    // the async needsSync check is in flight.
    set({ syncing: true });
    try {
      // Ensure DB migrations are complete before any reads
      const { recovered } = await ensureDbReady();
      if (recovered) {
        console.warn("DB was recovered — forcing full re-sync");
      }
      if (gen !== initGeneration) return;

      if ((opts.preferDownload || navigator.onLine === false) && (await restoreDeviceCity(cityId, signal) || await hasLiveDeviceCity(cityId))) {
        const index = await buildRaptorIndex({signal});
        const stopNames = await buildStopNames();
        if (gen !== initGeneration) return;
        set({raptorIndex: index, stopNames, loadedCityId: cityId, bundleCityTzIana: index.cityTzIana ?? null, syncing: false, error: null});
        startPtRouterBuild(cityId);
        return;
      }
      const needs = recovered || await needsSync(cityId, GTFS_CLIENT_REFRESH_INTERVAL_MS);
      if (gen !== initGeneration) return;
      if (needs) {
        // Inline the refresh work instead of calling refresh() to avoid
        // a syncing false->true gap between set() calls.
        set({ error: null });
        await syncGtfsData(cityId);
        if (gen !== initGeneration) return;
        const index = await buildRaptorIndex({ signal });
        if (gen !== initGeneration) return;
        const stopNames = await buildStopNames();
        if (gen !== initGeneration) return;
        set({ raptorIndex: index, stopNames, loadedCityId: cityId, bundleCityTzIana: index.cityTzIana ?? null, syncing: false });
        startEagerInitForCity(cityId);
      } else if (!get().raptorIndex) {
        // Warm start: the cached data is current, so build the engine now,
        // alongside the JS index. The build reads its own cached bytes
        // (`db.ptbBytes`, written by the same sync as the index's wire) and
        // never uses the index, so waiting for the index and stop names only
        // delayed it (H78: 0.8 s on a 2017 phone).
        startPtRouterBuild(cityId);
        const index = await buildRaptorIndex({ signal });
        if (gen !== initGeneration) return;
        const stopNames = await buildStopNames();
        if (gen !== initGeneration) return;
        set({ raptorIndex: index, stopNames, loadedCityId: cityId, bundleCityTzIana: index.cityTzIana ?? null, syncing: false });
        startEagerInitForCity(cityId);
      } else {
        set({ syncing: false });
      }
      performance.mark("ptn:gtfs-init-end");
      performance.measure("ptn:gtfs-init", "ptn:gtfs-init-start", "ptn:gtfs-init-end");
    } catch (err) {
      if (gen !== initGeneration) return;
      // A failed online fetch may still use an explicitly downloaded package.
      if (await restoreDeviceCity(cityId, signal).catch(() => false) || await hasLiveDeviceCity(cityId).catch(() => false)) {
        try {
          const index = await buildRaptorIndex({signal});
          const stopNames = await buildStopNames();
          if (gen !== initGeneration) return;
          set({raptorIndex: index, stopNames, loadedCityId: cityId, bundleCityTzIana: index.cityTzIana ?? null, syncing: false, error: null});
          startPtRouterBuild(cityId);
          return;
        } catch { /* Surface the original connection/data failure below. */ }
      }
      set({ error: String(err), syncing: false });
    }
  },

  async refresh(cityId: string, opts: {requireNetwork?: boolean} = {}) {
    const gen = bumpInitGeneration();
    const signal = initAbort?.signal;
    set({ syncing: true, error: null });
    try {
      await syncGtfsData(cityId, opts);
      if (gen !== initGeneration) return;
      const index = await buildRaptorIndex({ signal });
      if (gen !== initGeneration) return;
      const stopNames = await buildStopNames();
      if (gen !== initGeneration) return;
      set({ raptorIndex: index, stopNames, loadedCityId: cityId, syncing: false, bundleCityTzIana: index.cityTzIana ?? null });
      startEagerInitForCity(cityId);
    } catch (err) {
      if (gen !== initGeneration) return;
      set({ error: String(err), syncing: false });
    }
  },

  async reset() {
    bumpInitGeneration();
    // Free the live PtRouter BEFORE nulling so the wasm heap is
    // released promptly (panel qa HIGH — reset() is the only callsite
    // that frees synchronously; swapPtRouter defers for the in-flight
    // plan() race).
    const oldRouter = get().ptRouter;
    if (oldRouter) oldRouter.free();
    await clearGtfsData();
    set({
      raptorIndex: null,
      stopNames: null,
      loadedCityId: null,
      bundleCityTzIana: null,
      syncing: false,
      error: null,
      ptRouter: null,
      wasmEngine: idleWasmEngine(),
    });
  },
}));
