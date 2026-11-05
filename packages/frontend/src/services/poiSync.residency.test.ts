import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import type { PoiFetchMode, TileAnchor } from "@pt/shared";
import { syncPoiForCity, type SyncPoiDeps } from "./poiSync.ts";
import * as poiLoader from "./poiLoader.ts";
import { loadPoiBundle } from "./poiLoader.ts";
import { db } from "../db/index.ts";

// Residency tests isolate discovery; real manifest verification is covered by
// poiResources.test.ts. Missing bundle responses still exercise the fetch seam.
vi.mock("./poiManifest.ts", () => ({
  discoverPoiBundleResource: async (city: string, tier: string) => ({
    url: "/poi/releases/" + "a".repeat(64) + "/" + city +
      (tier === "loose" ? ".loose.br" : ".br"),
    sizeBytes: 1, sha256: "b".repeat(64), activationRevision: 1,
  }),
}));

const ANCHOR: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
const BUNDLE_SHA256 = "a".repeat(64);
const GENERATION_ID = "b".repeat(64);
const TILE_BOUNDS = { minX: -1, maxX: 1, minY: -1, maxY: 1 };

function tiling(edgeKm = 24) {
  return { edgeKm, anchor: ANCHOR, bundleSha256: BUNDLE_SHA256, generationId: GENERATION_ID, tileBounds: TILE_BOUNDS };
}

function residencyDeps(mode: () => PoiFetchMode): SyncPoiDeps {
  return {
    // REAL chain: loadBundle → loadPoiBundle → fetchPoiBundle (the spied seam).
    loadBundle: async (cityId) => { await loadPoiBundle(cityId, { includeLooseTier: false }); },
    makeTileLoader: vi.fn(() => ({
      loadViewport: vi.fn(async () => {}),
      prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })),
      dispose: vi.fn(),
    })),
    resolveMode: vi.fn(mode),
    getTiling: vi.fn(async () => null),
    poiCityIds: (id) => [id],
    getActiveCityId: () => "gdansk",
    includeLooseTier: false,
    disposePrior: vi.fn(),
  };
}

describe("residency invariant (AC-5b / AC-6 / AC-15)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    poiLoader.__resetPoiLoadStatusForTests();
    await db.poiIndex.clear();
    await db.savedLocations.clear();
    await db.recentLocations.clear();
    fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([false, true])("AC-5b: server-side suppresses all corpus requests (extended=%s)", async (extended) => {
    const fetchPoiBundleSpy = vi.spyOn(poiLoader, "fetchPoiBundle");
    const deps = residencyDeps(() => "server-side");
    deps.includeLooseTier = extended;
    deps.loadBundle = async (cityId) => { await loadPoiBundle(cityId, { includeLooseTier: extended }); };
    await syncPoiForCity("gdansk", deps);
    expect(fetchPoiBundleSpy).toHaveBeenCalledTimes(0);
    const poiUrls = fetchSpy.mock.calls.filter(
      ([u]) => typeof u === "string" && /\/poi\/.*\.br$/.test(u),
    );
    expect(poiUrls).toHaveLength(0);
  });

  // Falsifiability guard for the spy clause above. `vi.spyOn(poiLoader,
  // "fetchPoiBundle")` only intercepts the call `loadPoiBundle` makes if that
  // call goes THROUGH the module namespace (poiLoader.ts routes it via
  // `self.fetchPoiBundle`). A bare closure-local call would make the spy
  // silently record 0 regardless of behaviour — a guard that does not guard.
  // This test exercises the SAME loadBundle → loadPoiBundle → fetchPoiBundle
  // chain in EAGER mode (where it definitely runs) and asserts the spy fires;
  // if a refactor reverts to a closure-local call, THIS test goes red, proving
  // the AC-5b 0-call assertion is real and not vacuous.
  it("AC-5b guard: the fetchPoiBundle spy actually intercepts the internal call (eager → >0)", async () => {
    const fetchPoiBundleSpy = vi.spyOn(poiLoader, "fetchPoiBundle");
    await syncPoiForCity("gdansk", residencyDeps(() => "eager-bundle"));
    expect(fetchPoiBundleSpy.mock.calls.length).toBeGreaterThan(0);
    // And the global fetch DID see a /poi/*.br URL on this path — the second
    // AC-5b clause is independently falsifiable too (eager observes the URL
    // that server-side must NOT).
    const poiUrls = fetchSpy.mock.calls.filter(
      ([u]) => typeof u === "string" && /\/poi\/.*\.br$/.test(u),
    );
    expect(poiUrls.length).toBeGreaterThan(0);
  });

  it("AC-6: saved/recent tables survive eager → server-side → eager byte-identical", async () => {
    await db.savedLocations.put({
      id: "s1", label: "Home", lat: 54.35, lon: 18.6, savedAt: 1,
    } as never);
    await db.recentLocations.put({
      id: "r1", lat: 54.36, lon: 18.61, usedAt: 2,
    } as never);
    const before = {
      saved: await db.savedLocations.toArray(),
      recent: await db.recentLocations.toArray(),
    };
    let mode: PoiFetchMode = "eager-bundle";
    const deps = residencyDeps(() => mode);
    await syncPoiForCity("gdansk", deps); // eager (404s, no rows written)
    mode = "server-side";
    await syncPoiForCity("gdansk", deps); // server-side
    mode = "eager-bundle";
    await syncPoiForCity("gdansk", deps); // back to eager
    expect(await db.savedLocations.toArray()).toEqual(before.saved);
    expect(await db.recentLocations.toArray()).toEqual(before.recent);
  });

  it("AC-15: a pre-existing poiIndex row-count is UNCHANGED after a server-side sync (no implicit purge)", async () => {
    await db.poiIndex.put({
      id: "gdansk:p1", cityId: "gdansk", name: "Cafe", lat: 54.35, lon: 18.6, geoBucket: "5435_1860",
    } as never);
    const countBefore = await db.poiIndex.count();
    await syncPoiForCity("gdansk", residencyDeps(() => "server-side"));
    expect(await db.poiIndex.count()).toBe(countBefore);
  });

  it("AC-6 recovery: server-side → eager reconstructs the corpus fetch (loadBundle called once)", async () => {
    // The named user round-trip: opting BACK to a local mode must REBUILD the
    // fetch path, not silently no-op (Should-fix 11). Use a SPY loadBundle so we
    // assert it fired exactly once on the flip-back.
    const loadBundle = vi.fn(async () => {});
    let mode: PoiFetchMode = "server-side";
    const deps: SyncPoiDeps = { ...residencyDeps(() => mode), loadBundle };
    await syncPoiForCity("gdansk", deps);          // server-side: no loadBundle
    expect(loadBundle).not.toHaveBeenCalled();
    mode = "eager-bundle";
    await syncPoiForCity("gdansk", deps);          // back to eager: rebuild
    expect(loadBundle).toHaveBeenCalledTimes(1);
  });

  it("AC-6 recovery: server-side → lazy reconstructs the tile loader (makeTileLoader called once)", async () => {
    const makeTileLoader = vi.fn(() => ({
      loadViewport: vi.fn(async () => {}),
      prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })),
      dispose: vi.fn(),
    }));
    let mode: PoiFetchMode = "server-side";
    const deps: SyncPoiDeps = {
      ...residencyDeps(() => mode),
      makeTileLoader,
      getTiling: vi.fn(async () => tiling()),
    };
    await syncPoiForCity("gdansk", deps);          // server-side: no loader
    expect(makeTileLoader).not.toHaveBeenCalled();
    mode = "lazy-tile";
    await syncPoiForCity("gdansk", deps);          // back to lazy: rebuild loader
    expect(makeTileLoader).toHaveBeenCalledTimes(1);
  });

  it("a newer server-side sync aborts an eager fetch before corpus install", async () => {
    await db.poiSyncMeta.clear();
    let mode: PoiFetchMode = "eager-bundle";
    let resolveFetch!: (response: Response) => void;
    let fetchSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const deps = residencyDeps(() => mode);

    const eagerSync = syncPoiForCity("gdansk", deps);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    mode = "server-side";
    await syncPoiForCity("gdansk", deps);
    resolveFetch(new Response(null, { status: 404 }));
    await eagerSync;

    expect(fetchSignal?.aborted).toBe(true);
    expect(await db.poiIndex.count()).toBe(0);
    expect(await db.poiSyncMeta.count()).toBe(0);
    expect(poiLoader.getPoiLoadErrors().size).toBe(0);
  });
});

describe("AC-5d / AC-10 — queued work drained on swap to server-side", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a disposed lazy loader's queued loadViewport does not fire /poi/*.br after a server-side swap", async () => {
    // Typed as a variadic mock (mirrors the top-of-file `let fetchSpy:
    // ReturnType<typeof vi.fn>`) so `.mock.calls` is `any[]` and the `[u]`
    // destructure below type-checks — an inline `vi.fn(async () => ...)` infers
    // a zero-arg signature whose `.mock.calls` is `[][]` (TS2493 at the filter).
    const fetchSpy: ReturnType<typeof vi.fn> = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);

    // A real-ish lazy loader with a queued (timer-scheduled) loadViewport that
    // dispose() must cancel. The dispose spy proves disposal; the timer advance
    // proves the queued callback drained (did not fetch).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loadViewport = vi.fn(async () => { await fetch("/poi/gdansk.br"); });
    const loader = {
      loadViewport,
      prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })),
      dispose: vi.fn(() => { if (timer) clearTimeout(timer); }),
    };

    let mode: PoiFetchMode = "lazy-tile";
    const deps: SyncPoiDeps = {
      loadBundle: vi.fn(async () => {}),
      makeTileLoader: vi.fn(() => {
        timer = setTimeout(() => { void loader.loadViewport(); }, 1000);
        return loader;
      }),
      resolveMode: vi.fn(() => mode),
      getTiling: vi.fn(async () => tiling()),
      poiCityIds: (id) => [id],
      getActiveCityId: () => "gdansk",
      includeLooseTier: false,
      disposePrior: vi.fn(() => loader.dispose()),
    };

    await syncPoiForCity("gdansk", deps); // lazy: constructs loader + queues timer
    mode = "server-side";
    await syncPoiForCity("gdansk", deps); // server-side: disposes (cancels timer)
    vi.advanceTimersByTime(5000);

    expect(loader.dispose).toHaveBeenCalled();
    expect(loadViewport).not.toHaveBeenCalled();
    const poiUrls = fetchSpy.mock.calls.filter(
      ([u]) => typeof u === "string" && /\/poi\/.*\.br$/.test(u),
    );
    expect(poiUrls).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("first production lazy-tile city: eager↔lazy swap", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    poiLoader.__resetPoiLoadStatusForTests();
    await db.poiIndex.clear();
    await db.savedLocations.clear();
    await db.recentLocations.clear();
    fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("AC-L1: eager→lazy→eager disposes the prior lazy loader each sync; user tables untouched", async () => {
    await db.savedLocations.put({ id: "s1", label: "Home", lat: 54.35, lon: 18.6, savedAt: 1 } as never);
    await db.recentLocations.put({ id: "r1", lat: 54.36, lon: 18.61, usedAt: 2 } as never);
    const before = {
      saved: await db.savedLocations.toArray(),
      recent: await db.recentLocations.toArray(),
    };
    const disposePrior = vi.fn();
    const makeTileLoader = vi.fn(() => ({
      loadViewport: vi.fn(async () => {}),
      prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })),
      dispose: vi.fn(),
    }));
    let mode: PoiFetchMode = "eager-bundle";
    const deps: SyncPoiDeps = {
      ...residencyDeps(() => mode),
      disposePrior,
      makeTileLoader,
      getTiling: vi.fn(async () => tiling()),
    };
    await syncPoiForCity("gdansk", deps); // eager
    mode = "lazy-tile";
    await syncPoiForCity("gdansk", deps); // lazy: constructs a loader
    mode = "eager-bundle";
    await syncPoiForCity("gdansk", deps); // eager again: MUST dispose the prior lazy loader
    expect(disposePrior).toHaveBeenCalledTimes(3); // once at the top of every sync
    expect(makeTileLoader).toHaveBeenCalledTimes(1); // only the lazy sync built one
    // Residency invariant: user tables byte-identical across the swap.
    expect(await db.savedLocations.toArray()).toEqual(before.saved);
    expect(await db.recentLocations.toArray()).toEqual(before.recent);
  });
});

describe("vilnius eager↔lazy swap", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    poiLoader.__resetPoiLoadStatusForTests();
    await db.poiIndex.clear();
    await db.savedLocations.clear();
    await db.recentLocations.clear();
    fetchSpy = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("AC-L1: vilnius eager↔lazy swap disposes prior loaders once per sync, user tables intact", async () => {
    // Seed user data via the harness's existing Dexie seam (reuse, do not invent).
    await db.savedLocations.put({ id: "s1", label: "Home", lat: 54.687, lon: 25.28, savedAt: 1 } as never);
    await db.recentLocations.put({ id: "r1", lat: 54.69, lon: 25.27, usedAt: 2 } as never);
    const before = {
      saved: await db.savedLocations.toArray(),
      recent: await db.recentLocations.toArray(),
    };

    let mode: PoiFetchMode = "lazy-tile";
    const deps: SyncPoiDeps = {
      ...residencyDeps(() => mode),
      includeLooseTier: false,
      getActiveCityId: () => "vilnius",
      poiCityIds: () => ["vilnius"],
      getTiling: vi.fn(async () => tiling(12)),
    };
    await syncPoiForCity("vilnius", deps); // lazy
    mode = "eager-bundle";
    await syncPoiForCity("vilnius", deps); // eager — must dispose prior lazy loader
    mode = "lazy-tile";
    await syncPoiForCity("vilnius", deps); // lazy again

    // disposePrior runs once at the TOP of every sync (3 syncs → 3 calls).
    expect(deps.disposePrior).toHaveBeenCalledTimes(3);
    // User tables untouched across the swaps (residency invariant).
    expect(await db.savedLocations.toArray()).toEqual(before.saved);
    expect(await db.recentLocations.toArray()).toEqual(before.recent);
  });
});
