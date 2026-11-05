import { describe, it, expect, vi } from "vitest";
import type { PoiFetchMode, TileAnchor } from "@pt/shared";
import { syncPoiForCity, type SyncPoiDeps } from "./poiSync.ts";

const ANCHOR: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
const BUNDLE_SHA256 = "a".repeat(64);
const GENERATION_ID = "b".repeat(64);
const TILE_BOUNDS = { minX: -1, maxX: 1, minY: -1, maxY: 1 };

function tiling(edgeKm = 24) {
  return { edgeKm, anchor: ANCHOR, bundleSha256: BUNDLE_SHA256, generationId: GENERATION_ID, tileBounds: TILE_BOUNDS };
}

function makeDeps(over: Partial<SyncPoiDeps>): SyncPoiDeps {
  return {
    loadBundle: vi.fn(async () => {}),
    makeTileLoader: vi.fn(() => ({
      loadViewport: vi.fn(async () => {}),
      prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })),
      dispose: vi.fn(),
    })),
    resolveMode: vi.fn((): PoiFetchMode => "eager-bundle"),
    getTiling: vi.fn(async () => tiling()),
    poiCityIds: (id: string) => (id === "tricity" ? ["gdansk", "gdynia", "sopot"] : [id]),
    getActiveCityId: () => "gdansk",
    includeLooseTier: false,
    disposePrior: vi.fn(),
    ...over,
  };
}

describe("syncPoiForCity (AC-13 dispatch half)", () => {
  it("eager → loadBundle called, makeTileLoader NOT", async () => {
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => "eager-bundle") });
    await syncPoiForCity("gdansk", deps);
    expect(deps.loadBundle).toHaveBeenCalledWith("gdansk");
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
  });

  it("lazy → makeTileLoader called, loadBundle NOT; awaits tiling first", async () => {
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => "lazy-tile") });
    await syncPoiForCity("gdansk", deps);
    expect(deps.getTiling).toHaveBeenCalledWith("gdansk");
    expect(deps.makeTileLoader).toHaveBeenCalledWith(
      {
        cityId: "gdansk",
        edgeKm: 24,
        anchor: ANCHOR,
        bundleSha256: BUNDLE_SHA256,
        tileBounds: TILE_BOUNDS,
      },
    );
    expect(deps.loadBundle).not.toHaveBeenCalled();
  });

  it("lazy with null tiling → falls back to loadBundle", async () => {
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"), getTiling: vi.fn(async () => null) });
    await syncPoiForCity("gdansk", deps);
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
    expect(deps.loadBundle).toHaveBeenCalledWith("gdansk");
  });

  it("disposes the prior tileLoader before constructing a new one (mode swap)", async () => {
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => "lazy-tile") });
    await syncPoiForCity("gdansk", deps);
    await syncPoiForCity("gdansk", deps);
    expect(deps.disposePrior).toHaveBeenCalled();
  });

  it("eager→lazy→eager disposes the prior lazy tileLoader (no leaked AbortController/timer)", async () => {
    // The eager branch used to return WITHOUT disposePrior, leaking the lazy
    // loaders constructed by the middle sync (spec AC-13). disposePrior now runs
    // at the top of EVERY syncPoiForCity, so the final eager sync disposes them.
    let mode: PoiFetchMode = "eager-bundle";
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => mode) });
    await syncPoiForCity("gdansk", deps); // eager
    mode = "lazy-tile";
    await syncPoiForCity("gdansk", deps); // lazy: constructs a tileLoader
    expect(deps.makeTileLoader).toHaveBeenCalledTimes(1);
    mode = "eager-bundle";
    await syncPoiForCity("gdansk", deps); // eager: MUST dispose the prior lazy loader
    // One disposePrior per sync (3 total) — the proof the eager swap no longer
    // skips disposal.
    expect(deps.disposePrior).toHaveBeenCalledTimes(3);
  });

  it("city-change-during-await does NOT construct against the stale city", async () => {
    let active = "gdansk";
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      getActiveCityId: () => active,
      getTiling: vi.fn(async () => {
        active = "vilnius";
        return tiling();
      }),
    });
    await syncPoiForCity("gdansk", deps);
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
  });
});

describe("overlapping sync lifecycle", () => {
  it("does not install a lazy loader after a newer server-side sync", async () => {
    let mode: PoiFetchMode = "lazy-tile";
    let resolveTiling!: (value: ReturnType<typeof tiling>) => void;
    const pendingTiling = new Promise<ReturnType<typeof tiling>>((resolve) => {
      resolveTiling = resolve;
    });
    const onServerSide = vi.fn();
    const deps = makeDeps({
      resolveMode: vi.fn(() => mode),
      getTiling: vi.fn(async () => pendingTiling),
      onServerSide,
    });

    const staleSync = syncPoiForCity("gdansk", deps);
    await vi.waitFor(() => expect(deps.getTiling).toHaveBeenCalledTimes(1));
    mode = "server-side";
    await syncPoiForCity("gdansk", deps);
    resolveTiling(tiling());
    await staleSync;

    expect(onServerSide).toHaveBeenCalledWith("gdansk");
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
    expect(deps.loadBundle).not.toHaveBeenCalled();
  });

  it("stops eager fan-out when a newer city sync supersedes it", async () => {
    let activeCityId = "tricity";
    let releaseFirstBundle!: () => void;
    const firstBundle = new Promise<void>((resolve) => {
      releaseFirstBundle = resolve;
    });
    const loaded: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((cityId: string): PoiFetchMode =>
        cityId === "tricity" ? "eager-bundle" : "server-side"),
      getActiveCityId: () => activeCityId,
      loadBundle: vi.fn(async (cityId: string) => {
        loaded.push(cityId);
        if (cityId === "gdansk") await firstBundle;
      }),
    });

    const staleSync = syncPoiForCity("tricity", deps);
    await vi.waitFor(() => expect(loaded).toEqual(["gdansk"]));
    activeCityId = "vilnius";
    await syncPoiForCity("vilnius", deps);
    releaseFirstBundle();
    await staleSync;

    expect(loaded).toEqual(["gdansk"]);
  });
});

describe("loose-tier delivery in lazy-tile mode (loose is never tiled)", () => {
  it("lazy + includeLooseTier:true → loadBundle IS called per POI cityId AND tile loaders are built", async () => {
    // The backend tiles the STRICT tier only; the loose tier stays whole-bundle.
    // So a lazy-tile user who opted into the loose tier must still get the loose
    // whole-bundle for each POI cityId, alongside the strict per-tile loaders.
    const loaded: string[] = [];
    const made: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: true,
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["gdansk", "gdynia"],
      getTiling: vi.fn(async () => tiling()),
      loadBundle: vi.fn(async (id: string) => { loaded.push(id); }),
      makeTileLoader: vi.fn((opts: { cityId: string }) => {
        made.push(opts.cityId);
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await syncPoiForCity("tricity", deps);
    expect(made).toEqual(["gdansk", "gdynia"]);   // strict per-tile loaders
    expect(loaded).toEqual(["gdansk", "gdynia"]); // loose whole-bundle per POI city
  });

  it("lazy + includeLooseTier:false → loadBundle NOT called for a tiled city (current behavior)", async () => {
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: false,
      getTiling: vi.fn(async () => tiling()),
    });
    await syncPoiForCity("gdansk", deps);
    expect(deps.makeTileLoader).toHaveBeenCalled();
    expect(deps.loadBundle).not.toHaveBeenCalled();
  });

  it("lazy + includeLooseTier:true + null tiling → loadBundle called ONCE per city (no double-load)", async () => {
    // An untiled member already falls back to the whole bundle (which includes
    // loose when the user opted in via the real loadBundle wiring). The loose
    // delivery must NOT additionally double-call loadBundle for that city.
    const loaded: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: true,
      getTiling: vi.fn(async () => null),
      loadBundle: vi.fn(async (id: string) => { loaded.push(id); }),
    });
    await syncPoiForCity("gdansk", deps);
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
    expect(loaded).toEqual(["gdansk"]); // exactly once
  });
});

describe("1→N POI-city fan-out (AC-19)", () => {
  it("constructs one tileLoader per POI cityId from THAT city's own tiling", async () => {
    const edges: Record<string, number> = { gdansk: 24, gdynia: 20, sopot: 12 };
    const made: Array<{ cityId: string; edgeKm: number }> = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      getActiveCityId: () => "tricity",
      getTiling: vi.fn(async (id: string) => tiling(edges[id])),
      makeTileLoader: vi.fn((opts: { cityId: string; edgeKm: number }) => {
        made.push({ cityId: opts.cityId, edgeKm: opts.edgeKm });
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await syncPoiForCity("tricity", deps);
    expect(made).toEqual([
      { cityId: "gdansk", edgeKm: 24 },
      { cityId: "gdynia", edgeKm: 20 },
      { cityId: "sopot", edgeKm: 12 },
    ]);
  });

  it("mixed fan-out: a tiled member uses tileLoader, an UNtiled member falls back to loadBundle (no POI dropped)", async () => {
    // gdansk is tiled (manifest has poiTile); sopot is NOT (getTiling → null).
    // The untiled member MUST still load its whole bundle so its POIs stay in the
    // search union — nothing is dropped.
    const made: string[] = [];
    const loaded: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["gdansk", "sopot"],
      getTiling: vi.fn(async (id: string) => (id === "gdansk" ? tiling() : null)),
      loadBundle: vi.fn(async (id: string) => { loaded.push(id); }),
      makeTileLoader: vi.fn((opts: { cityId: string }) => {
        made.push(opts.cityId);
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await syncPoiForCity("tricity", deps);
    expect(made).toEqual(["gdansk"]);   // only the tiled member gets a tileLoader
    expect(loaded).toEqual(["sopot"]);  // the untiled member loads its whole bundle
  });
});

describe("server-side branch (AC-5a / AC-7 / AC-8 / AC-10 — no corpus fetch)", () => {
  it("AC-5a: server-side → loadBundle NOT called, makeTileLoader NOT called", async () => {
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => "server-side") });
    await syncPoiForCity("gdansk", deps);
    expect(deps.loadBundle).not.toHaveBeenCalled();
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
  });

  it("AC-10: server-side still disposes prior loaders (top-of-function)", async () => {
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => "server-side") });
    await syncPoiForCity("gdansk", deps);
    expect(deps.disposePrior).toHaveBeenCalledTimes(1);
  });

  it("AC-7: onServerSide breadcrumb fires WITHOUT triggering any purge", async () => {
    const onServerSide = vi.fn();
    const purgeCorpus = vi.fn(async () => {});
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "server-side"),
      onServerSide,
      // purgeCorpus deliberately ABSENT here to prove default no-purge
    });
    await syncPoiForCity("gdansk", deps);
    expect(onServerSide).toHaveBeenCalledWith("gdansk");
    expect(purgeCorpus).not.toHaveBeenCalled();
  });

  it("AC-8: purgeCorpus is opt-in — fires only when wired", async () => {
    const purgeCorpus = vi.fn(async () => {});
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "server-side"),
      purgeCorpus,
    });
    await syncPoiForCity("gdansk", deps);
    expect(purgeCorpus).toHaveBeenCalledTimes(1);
  });

  it("AC-8 default: no purgeCorpus dep → no purge call surface invoked", async () => {
    // No purgeCorpus on deps; the branch must not throw and must not invoke a purge.
    const deps = makeDeps({ resolveMode: vi.fn((): PoiFetchMode => "server-side") });
    await expect(syncPoiForCity("gdansk", deps)).resolves.toBeUndefined();
  });
});

describe("gdansk activation fan-out", () => {
  it("AC-9: tricity lazy fan-out → gdansk gets a tileLoader, loadBundle NOT called (loose off)", async () => {
    const made: Array<{ cityId: string; edgeKm: number; anchor: TileAnchor }> = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: false,
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["gdansk", "gdynia", "sopot"],
      getTiling: vi.fn(async (id: string) => (id === "sopot" ? null : tiling())),
      makeTileLoader: vi.fn((opts: { cityId: string; edgeKm: number; anchor: TileAnchor }) => {
        made.push({ cityId: opts.cityId, edgeKm: opts.edgeKm, anchor: opts.anchor });
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await syncPoiForCity("tricity", deps);
    // gdansk built with the pinned edge+anchor; loadBundle NOT called for gdansk.
    expect(made).toContainEqual({ cityId: "gdansk", edgeKm: 24, anchor: ANCHOR });
    expect(deps.loadBundle).not.toHaveBeenCalledWith("gdansk");
  });

  it("AC-9 companion: loose ON → gdansk fires BOTH makeTileLoader AND loadBundle (loose never tiled)", async () => {
    const made: string[] = [];
    const loaded: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: true,
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["gdansk"],
      getTiling: vi.fn(async () => tiling()),
      loadBundle: vi.fn(async (id: string) => { loaded.push(id); }),
      makeTileLoader: vi.fn((opts: { cityId: string }) => {
        made.push(opts.cityId);
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await syncPoiForCity("tricity", deps);
    expect(made).toEqual(["gdansk"]);   // strict per-tile loader
    expect(loaded).toEqual(["gdansk"]); // loose whole-bundle (intended, NOT a fall-back)
  });

  it("AC-10a: gdynia (non-null tiling, delivery-inactive backend) gets a tileLoader at sync time, no error escapes", async () => {
    const made: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: false,
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["gdynia"],
      getTiling: vi.fn(async () => tiling(20)), // emission NOT delivery-gated
      makeTileLoader: vi.fn((opts: { cityId: string }) => {
        made.push(opts.cityId);
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await expect(syncPoiForCity("tricity", deps)).resolves.toBeUndefined();
    expect(made).toEqual(["gdynia"]); // a loader IS constructed; the 503 surfaces later
  });

  it("AC-11: sopot (null tiling, sub-k-total) falls back to loadBundle, no tileLoader", async () => {
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: false,
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["sopot"],
      getTiling: vi.fn(async () => null),
    });
    await syncPoiForCity("tricity", deps);
    expect(deps.loadBundle).toHaveBeenCalledWith("sopot");
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
  });
});

describe("full activation fan-out", () => {
  it("AC-F1: vilnius fans to [vilnius], single tileLoader edge 12, loadBundle NOT called (loose off)", async () => {
    const made: Array<{ cityId: string; edgeKm: number }> = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: false,
      getActiveCityId: () => "vilnius",
      poiCityIds: () => ["vilnius"],
      getTiling: vi.fn(async () => tiling(12)),
      makeTileLoader: vi.fn((opts: { cityId: string; edgeKm: number }) => {
        made.push({ cityId: opts.cityId, edgeKm: opts.edgeKm });
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await syncPoiForCity("vilnius", deps);
    expect(made).toEqual([{ cityId: "vilnius", edgeKm: 12 }]);
    expect(deps.loadBundle).not.toHaveBeenCalled();
  });

  it("AC-F1 companion: vilnius loose ON → BOTH makeTileLoader AND loadBundle fire", async () => {
    const made: string[] = [];
    const loaded: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: true,
      getActiveCityId: () => "vilnius",
      poiCityIds: () => ["vilnius"],
      getTiling: vi.fn(async () => tiling(12)),
      loadBundle: vi.fn(async (id: string) => { loaded.push(id); }),
      makeTileLoader: vi.fn((opts: { cityId: string }) => {
        made.push(opts.cityId);
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await syncPoiForCity("vilnius", deps);
    expect(made).toEqual(["vilnius"]);
    expect(loaded).toEqual(["vilnius"]);
  });

  it("AC-F2a: tricity fans to gdansk+gdynia ACTIVE loaders, NOT sopot (null tiling), no error escapes", async () => {
    const made: string[] = [];
    const loaded: string[] = [];
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: false,
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["gdansk", "gdynia", "sopot"],
      getTiling: vi.fn(async (id: string) =>
        id === "sopot" ? null : tiling(id === "gdansk" ? 24 : 20)),
      loadBundle: vi.fn(async (id: string) => { loaded.push(id); }),
      makeTileLoader: vi.fn((opts: { cityId: string }) => {
        made.push(opts.cityId);
        return { loadViewport: vi.fn(async () => {}), prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: false, insertedBytes: 0 })), dispose: vi.fn() };
      }),
    });
    await expect(syncPoiForCity("tricity", deps)).resolves.toBeUndefined();
    // `made` is order-pinned because `syncPoiForCity` dispatches its fan-out in an
    // AWAIT-SEQUENTIAL loop over poiCityIds() — gdansk's loader is constructed and
    // awaited before gdynia's. The spec (AC-F2a) only requires SET-membership
    // (gdansk AND gdynia present, sopot absent), so this `toEqual` over-specifies on
    // purpose to also lock dispatch order; if the loop is ever parallelized to
    // Promise.all the ordering guarantee is lost — switch this to
    // `expect.arrayContaining(["gdansk","gdynia"])` + `expect(made).not.toContain("sopot")`
    // + `expect(made.length).toBe(2)` at that point.
    expect(made).toEqual(["gdansk", "gdynia"]); // both ACTIVE tile cities get loaders (sequential-await order)
    expect(loaded).toEqual(["sopot"]);          // sopot (null tiling) → whole-bundle
  });

  it("AC-F3: sopot null tiling (case A) falls back to loadBundle, no tileLoader", async () => {
    const deps = makeDeps({
      resolveMode: vi.fn((): PoiFetchMode => "lazy-tile"),
      includeLooseTier: false,
      getActiveCityId: () => "tricity",
      poiCityIds: () => ["sopot"],
      getTiling: vi.fn(async () => null),
    });
    await syncPoiForCity("tricity", deps);
    expect(deps.loadBundle).toHaveBeenCalledWith("sopot");
    expect(deps.makeTileLoader).not.toHaveBeenCalled();
  });
});
