import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { buildPtRouter, type PtRouterHandle } from "./raptorWasm.ts";
import { fetchPtbBytes, fetchPtbBytesPreferCache } from "./gtfsBundleBytes.ts";
import { fetchTransfersArtifactBytes } from "./transfersArtifact.ts";
import { readGtfsBundle, getTransfersManifest } from "./gtfsBundle.ts";
import type { TransfersArtifactManifest } from "../db/index.ts";
import {useCityDataStore} from "./cityData.ts";

/**
 * Window CustomEvent emitted when an attach was attempted (manifest
 * present) but failed (fetch, hash, or Rust-side decode). Consumers in
 * tests subscribe to assert the signal fires; a future on-device
 * telemetry layer can attach the same hook without piping through
 * console.warn. Manifest-absent is NOT a signal-worthy case — that's the
 * "this city has no transfers" branch and matches haversine-by-design.
 */
export const TRANSFERS_FALLBACK_EVENT = "ptn:wasm:transfers-fallback";

/**
 * Best-effort attach of the pedestrian-transfers artifact so wasm
 * footpath relaxation matches the TS engine (`raptorIndex.loadFootTransfers`).
 *
 * Hot path: the manifest is supplied by the caller from the
 * `FetchPtbBytesResult` — sourced from the `/api/<city>/raptor-bundle`
 * provenance headers and carried alongside the PTB bytes the build already
 * fetched, so the attach does NOT re-read or decode the multi-MB routing
 * bundle (the gunzip+JSON parse that previously ran on every wasm init and
 * every iOS-resume rebuild — the perf win this design protects).
 *
 * Cached-bundle fallback (artifact ABSENT only): an offline cache hit or a
 * response without an authoritative transfer marker returns no manifest from
 * the PTB row. Use the cached bundle's manifest in that indeterminate state
 * so precomputed transfers remain available. A provenance-capable response
 * with no artifact is authoritative and stays on the haversine path.
 *
 * Failures degrade to haversine (same as the TS path on a missing manifest)
 * and emit `TRANSFERS_FALLBACK_EVENT` for triage; an absent manifest (after
 * the fallback) is the "this city has no transfers" branch and is NOT
 * signal-worthy.
 */
async function attachTransfersIfAvailable(
  router: PtRouterHandle,
  cityId: string,
  gen: number,
  artifact: TransfersArtifactManifest | undefined,
  transfersResolved: boolean,
): Promise<void> {
  // Performance-timeline partition: the cold-start spec
  // (`e2e/core/wasm-engine-coldstart.spec.ts`) measures total wasm bootstrap
  // and partitions it via the `ptn:wasm:{import,instantiate,ptnew}:*` marks
  // emitted in `raptorWasm.ts`. The attach now sits between ptnew and
  // firstplan, so emit a fifth pair so the budget can attribute time to it
  // rather than letting it inflate `total - sum(parts)` opaquely.
  performance.mark("ptn:wasm:attach:start");
  try {
    let manifest: TransfersArtifactManifest | undefined = artifact;
    if (!manifest?.url || !manifest?.hash) {
      // No manifest off the fetch. If a provenance-capable server
      // authoritatively resolved this generation as having no transfers
      // (`transfersResolved`), respect that → haversine. Bridge from the
      // cached bundle only while the state is indeterminate.
      if (transfersResolved) return;
      manifest = getTransfersManifest(await readGtfsBundle(cityId));
    }
    if (!manifest?.url || !manifest?.hash) return;
    // F9: abort the byte fetch if a reset()/city switch bumps the generation
    // mid-download (the post-await gen guard below still handles installs).
    const signal = useGtfsDataStore.getState().getInitAbortSignal();
    const bytes = await fetchTransfersArtifactBytes(manifest.url, manifest.hash, { signal });
    // Re-check before reaching into the freshly-built (possibly soon-to-
    // be-freed) router. Without this, a reset() mid-fetch pays the
    // setTransfers cost on a router the caller is about to free anyway;
    // the post-free guard on the wrapper would throw, which would land
    // in the catch below and emit a spurious fallback event. (Covers the
    // readGtfsBundle + artifact-fetch awaits above.)
    if (useGtfsDataStore.getState().getInitGeneration() !== gen) return;
    await router.setTransfers(bytes);
  } catch (err) {
    console.warn(`[wasmLifecycle] transfers attach failed for city=${cityId}; wasm runs haversine fallback:`, err);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(TRANSFERS_FALLBACK_EVENT, {
        detail: { cityId, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  } finally {
    performance.mark("ptn:wasm:attach:end");
  }
}

/**
 * Install (or hot-swap) the live PtRouter onto the store from freshly
 * fetched PTB bytes. Uses NETWORK-FIRST bytes (panel: matches the
 * existing bundle-refresh contract — operators expect a refresh to see
 * fresh PTB). Idempotent against repeated calls: subsequent invocations
 * always swap atomically via `swapPtRouter` (deferred-free of the prior
 * handle so in-flight `plan()` calls survive the rebuild — see
 * `gtfsDataStore.ts:94` JSDoc).
 *
 * Late-install race guard: `buildPtRouter` is async; if a `reset()` (or
 * any path that bumps the store's generation by mutating ptRouter) lands
 * between the `await` and the install, we drop the orphan via `free()`
 * rather than clobber the post-reset null. The check uses the store's
 * `ptRouter` reference itself as the generation token — when a `reset()`
 * or another init runs to completion, the visible router slot resets to
 * either `null` or a different handle; either way we know our build is
 * orphaned. Mirrors the JSDoc breadcrumb on `gtfsDataStore.ts:25`.
 */
export async function initOrSwapPtRouter(
  cityId: string,
  opts: { preferCache?: boolean } = {},
): Promise<PtRouterHandle> {
  // Snapshot the monotonic generation token (not just ptRouter reference)
  // so reset() mid-build is detected even when ptRouter was null both
  // before AND after (null !== null is false; reference-equality misses
  // this case — caught by panel code-review CRITICAL).
  const gen = useGtfsDataStore.getState().getInitGeneration();
  const context = useCityDataStore.getState().active;
  const bound = context?.token.cityId === cityId ? context.artifact?.ptb : undefined;
  // `preferCache` is for the eager init the store fires right after it
  // installs an index: those bytes are the ones the index was built from, so
  // revalidating them here would be a second multi-megabyte round-trip for
  // the same generation, and an engine built from newer bytes than the index
  // would disagree with it. A search-triggered init keeps the network-first
  // default: it may be the first thing that needs the catalog.
  const { bytes, transfersArtifact, transfersResolved } = bound ?? (opts.preferCache
    ? await fetchPtbBytesPreferCache(cityId)
    : await fetchPtbBytes(cityId));
  const router = await buildPtRouter(bytes, cityId);
  // Attach footpath transfers before the install/free decision so an
  // orphaned-by-reset router gets freed together with its transfers
  // bytes — never an installed router with a pending attach. The attach
  // itself re-checks `gen` before reaching into the router so the
  // setTransfers call is skipped cheaply on a mid-flight reset.
  await attachTransfersIfAvailable(router, cityId, gen, transfersArtifact, transfersResolved);
  const store = useGtfsDataStore.getState();
  if (store.getInitGeneration() !== gen || useCityDataStore.getState().active !== context) {
    router.free();
    return router;
  }
  if (store.ptRouter) store.swapPtRouter(router);
  else store.setPtRouter(router);
  return router;
}

/**
 * Recovery variant for visibility-resume: prefer the IDB-cached bytes
 * (panel DB F2 — re-fetching network on every resume defeats the cache).
 * Same late-install guard as `initOrSwapPtRouter`.
 */
async function reinstantiateFromCache(cityId: string): Promise<PtRouterHandle> {
  const gen = useGtfsDataStore.getState().getInitGeneration();
  const context = useCityDataStore.getState().active;
  const bound = context?.token.cityId === cityId ? context.artifact?.ptb : undefined;
  const { bytes, transfersArtifact, transfersResolved } = bound ?? await fetchPtbBytesPreferCache(cityId);
  const router = await buildPtRouter(bytes, cityId);
  await attachTransfersIfAvailable(router, cityId, gen, transfersArtifact, transfersResolved);
  const store = useGtfsDataStore.getState();
  if (store.getInitGeneration() !== gen || useCityDataStore.getState().active !== context) {
    router.free();
    return router;
  }
  if (store.ptRouter) store.swapPtRouter(router);
  else store.setPtRouter(router);
  return router;
}

let inFlightReinstantiate: Promise<unknown> | null = null;

/**
 * Subscribe to document.visibilitychange. On resume, if the current
 * PtRouter reports isAlive() === false (iOS Safari heap loss, or a router
 * worker that died), trigger re-instantiation from IDB-cached bytes. Reads
 * cityId from the city store at handler time (NOT closure-captured at
 * registration) so a city switch between register and resume routes to the
 * right cache (panel engineer #4).
 *
 * Wraps isAlive() in try/catch (panel qa HIGH — a Rust-side panic that
 * surfaces as a JS throw would otherwise kill the listener for the tab).
 * Debounces concurrent resume events via `inFlightReinstantiate` so
 * rapid foreground/background flips don't trigger overlapping builds
 * that free each other's handles.
 *

 * * Returns a teardown function the caller invokes on unmount.
 */
export function registerVisibilityChangeAlivenessGuard(): () => void {
  if (typeof document === "undefined") return () => { /* noop in SSR */ };
  const handler = (): void => {
    if (document.visibilityState !== "visible") return;
    const router = useGtfsDataStore.getState().ptRouter;
    if (!router) return;

    // Read city ID first so all triage log lines carry it.
    const cityId = useCityStore.getState().activeCity.id;
    let alive: boolean;
    try {
      alive = router.isAlive();
    } catch (err) {
      // isAlive() should never throw per the pt-wasm contract; if it
      // does, treat as not-alive and recover.
      console.warn(`[wasmLifecycle] isAlive() threw for city=${cityId} — treating as dead:`, err);
      alive = false;
    }
    if (alive) return;

    if (inFlightReinstantiate) return; // debounce
    inFlightReinstantiate = reinstantiateFromCache(cityId)
      .catch((err) => { console.warn(`[wasmLifecycle] re-instantiate failed for city=${cityId}:`, err); })
      .finally(() => { inFlightReinstantiate = null; });
  };
  document.addEventListener("visibilitychange", handler);
  return () => { document.removeEventListener("visibilitychange", handler); };
}
