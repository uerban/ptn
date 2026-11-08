import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PtRouterHandle } from "./raptorWasm.ts";
import { CITIES } from "../config/cities.ts";

// `vi.mock` is hoisted; declare mock fns via `vi.hoisted` so the
// bindings exist when the mock factories execute (matches the pattern
// in `wasmPlanner.test.ts`).
const {
  buildPtRouterMock, fetchPtbBytesMock, fetchPtbBytesPreferCacheMock, evictPtbBytesMock,
  readGtfsBundleMock, fetchTransfersArtifactBytesMock,
} = vi.hoisted(() => ({
  buildPtRouterMock: vi.fn(),
  fetchPtbBytesMock: vi.fn(),
  fetchPtbBytesPreferCacheMock: vi.fn(),
  evictPtbBytesMock: vi.fn().mockResolvedValue(undefined),
  readGtfsBundleMock: vi.fn(),
  fetchTransfersArtifactBytesMock: vi.fn(),
}));

vi.mock("./raptorWasm.ts", () => ({
  buildPtRouter: buildPtRouterMock,
  PtWasmImportError: class extends Error {},
  PtWasmInitError: class extends Error {},
}));
// `evictPtbBytes` must be stubbed here too: cityStore (transitively imported
// via gtfsDataStore) eagerly imports it at module load to wire up the
// city-switch eviction. Without this export, the cityStore module load
// throws "No 'evictPtbBytes' export defined on the mock" the first time
// any test triggers a setActiveCity call.
vi.mock("./gtfsBundleBytes.ts", () => ({
  fetchPtbBytes: fetchPtbBytesMock,
  fetchPtbBytesPreferCache: fetchPtbBytesPreferCacheMock,
  evictPtbBytes: evictPtbBytesMock,
}));
// `wasmLifecycle` no longer reads the routing bundle to source the transfers manifest — it consumes
// the manifest the PTB fetch returns. The mock is retained purely so the tests can assert
// `readGtfsBundle` is the artifact-ABSENT fallback only — it must NOT be decoded on the
// provenance-fed hot path (a regression to decoding the multi-MB bundle on every wasm init /
// iOS-resume would be a silent perf cliff; the artifact-present test below asserts it stays
// untouched). It IS read when the PTB fetch carries no manifest (upgraded/offline bridge).
// `getTransfersManifest` is stubbed to read `wire.meta.transfersArtifact`.
vi.mock("./gtfsBundle.ts", () => ({
  readGtfsBundle: readGtfsBundleMock,
  getTransfersManifest: (wire: { meta?: { transfersArtifact?: unknown } } | null | undefined) =>
    wire?.meta?.transfersArtifact,
}));
vi.mock("./transfersArtifact.ts", () => ({
  fetchTransfersArtifactBytes: fetchTransfersArtifactBytesMock,
}));

import {
  initOrSwapPtRouter, registerVisibilityChangeAlivenessGuard,
  TRANSFERS_FALLBACK_EVENT,
} from "./wasmLifecycle.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import {activateCityData, CityDataContext} from "./cityData.ts";
import {useCityStore} from "../stores/cityStore.ts";

function boundContext(id: string) {
  const cityId = useCityStore.getState().activeCity.id;
  return new CityDataContext({meta: {cityId, generatedAt: "today", cityTzIana: "UTC"},
    stops: [], routes: [], calendar: []}, {id: "current", cityId, generationId: id,
    etag: id, generatedAt: "today", lastSynced: 1}, [], {key: id, cityId,
      generation: {generationId: id, bundleSha256: id, generatedAt: "today", cityTzIana: "UTC"},
      ptb: {bytes: new Uint8Array([7]), etag: id, fromCache: false, networkValidated: true, transfersResolved: true}});
}

beforeEach(async () => {
  await useGtfsDataStore.getState().reset();
  buildPtRouterMock.mockReset();
  fetchPtbBytesMock.mockReset();
  fetchPtbBytesPreferCacheMock.mockReset();
  readGtfsBundleMock.mockReset();
  fetchTransfersArtifactBytesMock.mockReset();
  // The attach no longer reads the routing bundle — the manifest now arrives on the PTB fetch
  // result. Keep the mock returning the production "absent row" sentinel (`null`, not `undefined`)
  // so that IF anything unexpectedly calls it the value is realistic; the attach must never call it
  // (asserted in the init + resume tests below).
  readGtfsBundleMock.mockResolvedValue(null);
});

// Shared fixture: the transfers manifest the PTB fetch result carries (surfaced it on
// `FetchPtbBytesResult.transfersArtifact`, read from the `/api/<city>/raptor-bundle` provenance
// headers). Used by both initOrSwapPtRouter and reinstantiateFromCache attach tests.
const TRANSFERS_ARTIFACT = { url: "/api/vilnius/transfers/fetch", hash: "abc", sizeBytes: 42 };

describe("initOrSwapPtRouter", () => {
  it("discards a separately fetched engine if a catalog became active during construction", async () => {
    const context = boundContext("arrived");
    fetchPtbBytesMock.mockResolvedValueOnce({bytes: new Uint8Array([1]), etag: '"other"',
      fromCache: false, transfersResolved: true});
    const router = {plan: () => [], free: vi.fn(), isAlive: () => true};
    let finish!: (value: typeof router) => void;
    buildPtRouterMock.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
    const build = initOrSwapPtRouter(context.token.cityId);
    await vi.waitFor(() => expect(buildPtRouterMock).toHaveBeenCalledOnce());
    activateCityData(context);
    finish(router);
    await build;
    expect(router.free).toHaveBeenCalledOnce();
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
  });

  it("builds from the installed catalog's exact raw bytes without fetching another generation", async () => {
    const context = boundContext("a");
    activateCityData(context);
    const router = {plan: () => [], free: vi.fn(), isAlive: () => true};
    buildPtRouterMock.mockResolvedValueOnce(router);
    await initOrSwapPtRouter(context.token.cityId);
    expect(buildPtRouterMock).toHaveBeenCalledWith(context.artifact!.ptb.bytes, context.token.cityId);
    expect(fetchPtbBytesMock).not.toHaveBeenCalled();
    expect(fetchPtbBytesPreferCacheMock).not.toHaveBeenCalled();
    expect(readGtfsBundleMock).not.toHaveBeenCalled();
  });

  it("frees a router built from a context replaced during the build", async () => {
    const context = boundContext("a");
    activateCityData(context);
    const router = {plan: () => [], free: vi.fn(), isAlive: () => true};
    let finish!: (value: typeof router) => void;
    buildPtRouterMock.mockReturnValueOnce(new Promise(resolve => {finish = resolve;}));
    const build = initOrSwapPtRouter(context.token.cityId);
    activateCityData(boundContext("b"));
    finish(router);
    await build;
    expect(router.free).toHaveBeenCalledOnce();
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
  });

  it("fetches via network-first, builds router, swaps onto store", async () => {
    const bytes = new Uint8Array([1]);
    fetchPtbBytesMock.mockResolvedValueOnce({ bytes, etag: '"v1"', fromCache: false });
    const router = { plan: () => [], free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);

    await initOrSwapPtRouter("vilnius");

    expect(fetchPtbBytesMock).toHaveBeenCalledWith("vilnius");
    expect(useGtfsDataStore.getState().ptRouter).toBe(router);
  });

  it("orphans the build (frees, does not install) when reset() runs mid-build (panel code-review CRITICAL)", async () => {
    // Repro of the race the late-install guard MUST catch: user fires
    // `reset()` (e.g. "clear data") while initOrSwapPtRouter is mid-await.
    // The generation guard must notice a reset while the build is in flight,
    // including when the router slot is null before and after the reset.
    let resolveBuild: (router: PtRouterHandle) => void;
    const orphan = {
      plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true,
    } satisfies PtRouterHandle;
    fetchPtbBytesMock.mockResolvedValueOnce({ bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false });
    buildPtRouterMock.mockReturnValueOnce(new Promise<PtRouterHandle>((resolve) => { resolveBuild = resolve; }));

    const buildPromise = initOrSwapPtRouter("vilnius");

    // While the build is in flight, the user resets the store.
    await useGtfsDataStore.getState().reset();
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();

    // Build resolves AFTER reset.
    resolveBuild!(orphan);
    await buildPromise;

    // Orphan must NOT be installed (the user wiped data); it MUST be freed.
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
    expect(orphan.free).toHaveBeenCalledTimes(1);
  });

  it("aborts swap on construction failure — existing router untouched", async () => {
    const existing = {
      plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true,
    } satisfies PtRouterHandle;
    useGtfsDataStore.getState().setPtRouter(existing);
    fetchPtbBytesMock.mockResolvedValueOnce({ bytes: new Uint8Array(0), etag: "", fromCache: false });
    buildPtRouterMock.mockRejectedValueOnce(new Error("bad bytes"));

    await expect(initOrSwapPtRouter("vilnius")).rejects.toThrow("bad bytes");
    expect(useGtfsDataStore.getState().ptRouter).toBe(existing);
    expect(existing.free).not.toHaveBeenCalled();
  });

  it("attaches transfers when the PTB fetch result carries a transfersArtifact manifest", async () => {
    // Plan-gap fix: without this wiring, production wasm runs footpath OFF
    // while the TS engine consumes the same artifact via raptorIndex.
    fetchPtbBytesMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false,
      transfersArtifact: TRANSFERS_ARTIFACT,
    });
    const transfersBytes = new Uint8Array([0x50, 0x54, 0x46, 0x54, 0x01, 0x00]);
    fetchTransfersArtifactBytesMock.mockResolvedValueOnce(transfersBytes);
    const router = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);

    await initOrSwapPtRouter("vilnius");

    expect(fetchTransfersArtifactBytesMock).toHaveBeenCalledWith("/api/vilnius/transfers/fetch", "abc", { signal: expect.toSatisfy((s: unknown) => s === undefined || s instanceof AbortSignal) });
    expect(router.setTransfers).toHaveBeenCalledWith(transfersBytes);
    // No bundle decode on the wasm-init path — manifest came off the fetch.
    expect(readGtfsBundleMock).not.toHaveBeenCalled();
    expect(useGtfsDataStore.getState().ptRouter).toBe(router);
  });

  it("falls back to the cached gtfsBundle manifest when the PTB result has no transfersArtifact (offline bridge)", async () => {
    // An offline client that cannot revalidate returns no manifest off the
    // fetch and the state is INDETERMINATE (`transfersResolved: false`). The
    // cached `gtfsBundle` manifest must still attach transfers rather than
    // silently dropping to haversine.
    fetchPtbBytesMock.mockResolvedValueOnce({ bytes: new Uint8Array([1]), etag: '"v1"', fromCache: true, transfersResolved: false });
    readGtfsBundleMock.mockResolvedValueOnce({ meta: { transfersArtifact: TRANSFERS_ARTIFACT } });
    const transfersBytes = new Uint8Array([0x50, 0x54, 0x46, 0x54, 0x01, 0x00]);
    fetchTransfersArtifactBytesMock.mockResolvedValueOnce(transfersBytes);
    const router = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);

    await initOrSwapPtRouter("vilnius");

    expect(readGtfsBundleMock).toHaveBeenCalledWith("vilnius");
    expect(fetchTransfersArtifactBytesMock).toHaveBeenCalledWith("/api/vilnius/transfers/fetch", "abc", { signal: expect.toSatisfy((s: unknown) => s === undefined || s instanceof AbortSignal) });
    expect(router.setTransfers).toHaveBeenCalledWith(transfersBytes);
    expect(useGtfsDataStore.getState().ptRouter).toBe(router);
  });

  it("does NOT resurrect a stale cached manifest when the server authoritatively resolved no transfers", async () => {
    // A provenance-capable response that omits transfer headers clears the
    // artifact AND marks it resolved (`transfersResolved: true`). Even if a
    // stale gtfsBundle row still holds a manifest, attach must NOT read or
    // fetch it — haversine is correct for a generation that advertised no
    // transfers; attaching that manifest would use stale data.
    fetchPtbBytesMock.mockResolvedValueOnce({ bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false, transfersResolved: true });
    readGtfsBundleMock.mockResolvedValueOnce({ meta: { transfersArtifact: TRANSFERS_ARTIFACT } });
    const router = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);

    await initOrSwapPtRouter("vilnius");

    expect(readGtfsBundleMock).not.toHaveBeenCalled();
    expect(fetchTransfersArtifactBytesMock).not.toHaveBeenCalled();
    expect(router.setTransfers).not.toHaveBeenCalled();
    expect(useGtfsDataStore.getState().ptRouter).toBe(router);
  });

  it("skips attach when the PTB fetch result has no transfersArtifact (haversine fallback)", async () => {
    // Manifest-absent is the haversine-by-design branch, not a failure: no
    // artifact fetch, no setTransfers, and crucially no fallback event.
    fetchPtbBytesMock.mockResolvedValueOnce({ bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false });
    const router = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);
    const fallbackEvents: CustomEvent[] = [];
    const listener = (e: Event): void => { fallbackEvents.push(e as CustomEvent); };
    window.addEventListener(TRANSFERS_FALLBACK_EVENT, listener);

    await initOrSwapPtRouter("vilnius");

    expect(fetchTransfersArtifactBytesMock).not.toHaveBeenCalled();
    expect(router.setTransfers).not.toHaveBeenCalled();
    expect(fallbackEvents).toHaveLength(0);
    expect(useGtfsDataStore.getState().ptRouter).toBe(router);
    window.removeEventListener(TRANSFERS_FALLBACK_EVENT, listener);
  });

  it("degrades to haversine + emits fallback event on transfers fetch error", async () => {
    fetchPtbBytesMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false,
      transfersArtifact: TRANSFERS_ARTIFACT,
    });
    fetchTransfersArtifactBytesMock.mockRejectedValueOnce(new Error("HTTP 503 for /api/vilnius/transfers/fetch"));
    const router = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);
    const fallbackEvents: CustomEvent[] = [];
    const listener = (e: Event): void => { fallbackEvents.push(e as CustomEvent); };
    window.addEventListener(TRANSFERS_FALLBACK_EVENT, listener);

    await expect(initOrSwapPtRouter("vilnius")).resolves.toBe(router);

    expect(router.setTransfers).not.toHaveBeenCalled();
    expect(useGtfsDataStore.getState().ptRouter).toBe(router);
    expect(router.free).not.toHaveBeenCalled();
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0].detail).toMatchObject({ cityId: "vilnius" });
    expect(fallbackEvents[0].detail.error).toContain("HTTP 503");
    window.removeEventListener(TRANSFERS_FALLBACK_EVENT, listener);
  });

  it("degrades + emits fallback event on Rust-side setTransfers throw (distinct from fetch error)", async () => {
    // Fetch + hash succeed; Rust setTransfers throws (e.g. PTFT magic bad
    // in returned bytes, or wrong-version artifact). Same fallback as fetch
    // error but a different code path worth pinning separately.
    fetchPtbBytesMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false,
      transfersArtifact: TRANSFERS_ARTIFACT,
    });
    fetchTransfersArtifactBytesMock.mockResolvedValueOnce(new Uint8Array([0, 0, 0, 0]));
    const router = {
      plan: () => [],
      setTransfers: vi.fn(() => { throw new Error("PtRouter.setTransfers() failed: bad PTFT magic"); }),
      resolveTime: vi.fn(),
      free: vi.fn(),
      isAlive: () => true,
    };
    buildPtRouterMock.mockResolvedValueOnce(router);
    const fallbackEvents: CustomEvent[] = [];
    const listener = (e: Event): void => { fallbackEvents.push(e as CustomEvent); };
    window.addEventListener(TRANSFERS_FALLBACK_EVENT, listener);

    await expect(initOrSwapPtRouter("vilnius")).resolves.toBe(router);

    expect(router.setTransfers).toHaveBeenCalledTimes(1);
    expect(useGtfsDataStore.getState().ptRouter).toBe(router);
    expect(fallbackEvents).toHaveLength(1);
    expect(fallbackEvents[0].detail.error).toContain("bad PTFT magic");
    window.removeEventListener(TRANSFERS_FALLBACK_EVENT, listener);
  });

  it("skips setTransfers when generation changes mid-fetch (cheap-bail on reset race)", async () => {
    // Reset() lands during the transfers fetch. Without the in-attach
    // generation re-check, we'd setTransfers on a router the caller is
    // about to free, the wrapper post-free guard would throw, and the
    // catch would emit a spurious fallback event. With the re-check the
    // attach skips setTransfers, attach returns cleanly, and the outer
    // generation check at the install site frees the orphan.
    fetchPtbBytesMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false,
      transfersArtifact: TRANSFERS_ARTIFACT,
    });
    let resolveFetch: (b: Uint8Array) => void;
    fetchTransfersArtifactBytesMock.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));
    const router = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);

    const init = initOrSwapPtRouter("vilnius");
    // Reset BEFORE the transfers fetch resolves.
    await useGtfsDataStore.getState().reset();
    resolveFetch!(new Uint8Array([0x50, 0x54, 0x46, 0x54, 0x01, 0x00]));
    await init;

    expect(router.setTransfers).not.toHaveBeenCalled();
    expect(router.free).toHaveBeenCalledTimes(1); // freed as orphan by outer check
    expect(useGtfsDataStore.getState().ptRouter).toBeNull();
  });

  it("guards against malformed manifest (empty url or hash)", async () => {
    fetchPtbBytesMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: false,
      transfersArtifact: { url: "", hash: "abc", sizeBytes: 42 },
    });
    const router = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    buildPtRouterMock.mockResolvedValueOnce(router);

    await initOrSwapPtRouter("vilnius");

    expect(fetchTransfersArtifactBytesMock).not.toHaveBeenCalled();
    expect(router.setTransfers).not.toHaveBeenCalled();
  });
});

describe("registerVisibilityChangeAlivenessGuard", () => {
  it("re-instantiates from prefer-cache when isAlive returns false (panel DB F2)", async () => {
    const stale = {
      plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: vi.fn(() => false),
    } satisfies PtRouterHandle;
    useGtfsDataStore.getState().setPtRouter(stale);

    const fresh = { plan: () => [], free: vi.fn(), isAlive: () => true };
    fetchPtbBytesPreferCacheMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: true,
    });
    buildPtRouterMock.mockResolvedValueOnce(fresh);

    const teardown = registerVisibilityChangeAlivenessGuard();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchPtbBytesPreferCacheMock).toHaveBeenCalled();
    expect(fetchPtbBytesMock).not.toHaveBeenCalled();
    expect(useGtfsDataStore.getState().ptRouter).toBe(fresh);
    teardown();
  });

  it("no-op when there's no PtRouter (panel qa MEDIUM)", () => {
    const teardown = registerVisibilityChangeAlivenessGuard();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetchPtbBytesPreferCacheMock).not.toHaveBeenCalled();
    teardown();
  });

  it("handles isAlive() throwing without killing the listener (panel qa HIGH)", async () => {
    const broken = {
      plan: async () => [],
      setTransfers: vi.fn(), resolveTime: vi.fn(),
      free: vi.fn(),
      isAlive: vi.fn(() => { throw new Error("wasm explode"); }),
    } satisfies PtRouterHandle;
    useGtfsDataStore.getState().setPtRouter(broken);

    const teardown = registerVisibilityChangeAlivenessGuard();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(() => document.dispatchEvent(new Event("visibilitychange"))).not.toThrow();

    // Second resume should still fire the handler.
    fetchPtbBytesPreferCacheMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: true,
    });
    buildPtRouterMock.mockResolvedValueOnce({ plan: () => [], free: vi.fn(), isAlive: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchPtbBytesPreferCacheMock).toHaveBeenCalled();
    teardown();
  });

  it("attaches transfers on visibility resume", async () => {
    // Mirror of the initOrSwapPtRouter attach test for the iOS-resume path.
    // Without coverage here, a refactor that drops attach from
    // `reinstantiateFromCache` would silently regress wasm footpath on
    // every resume.
    const stale = {
      plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => false,
    } satisfies PtRouterHandle;
    useGtfsDataStore.getState().setPtRouter(stale);
    const fresh = { plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => true };
    fetchPtbBytesPreferCacheMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: true,
      transfersArtifact: TRANSFERS_ARTIFACT,
    });
    buildPtRouterMock.mockResolvedValueOnce(fresh);
    const transfersBytes = new Uint8Array([0x50, 0x54, 0x46, 0x54, 0x01, 0x00]);
    fetchTransfersArtifactBytesMock.mockResolvedValueOnce(transfersBytes);

    const teardown = registerVisibilityChangeAlivenessGuard();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fresh.setTransfers).toHaveBeenCalledWith(transfersBytes);
    // The priority perf win of this cutover: resume must NOT gunzip+parse
    // the multi-MB routing bundle to source the manifest — it reads it off
    // the prefer-cache PTB fetch result instead.
    expect(readGtfsBundleMock).not.toHaveBeenCalled();
    expect(useGtfsDataStore.getState().ptRouter).toBe(fresh);
    teardown();
  });

  it("uses the CURRENT city from the city store (not closure-captured)", async () => {
    const { useCityStore } = await import("../stores/cityStore.ts");
    useCityStore.getState().setActiveCity(CITIES.find((city) => city.id === "vilnius")!);
    const stale = {
      plan: async () => [], setTransfers: vi.fn(), resolveTime: vi.fn(), free: vi.fn(), isAlive: () => false,
    } satisfies PtRouterHandle;
    useGtfsDataStore.getState().setPtRouter(stale);

    const teardown = registerVisibilityChangeAlivenessGuard();

    // City switches AFTER guard registration.
    useCityStore.getState().setActiveCity(CITIES.find((city) => city.id === "krakow")!);

    fetchPtbBytesPreferCacheMock.mockResolvedValueOnce({
      bytes: new Uint8Array([1]), etag: '"v1"', fromCache: true,
    });
    buildPtRouterMock.mockResolvedValueOnce({ plan: () => [], free: vi.fn(), isAlive: () => true });

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchPtbBytesPreferCacheMock).toHaveBeenCalledWith("krakow");
    teardown();
  });
});
