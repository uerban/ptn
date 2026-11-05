import { beforeEach, describe, it, expect, vi, type Mock } from "vitest";
import type { TileAnchor, Bbox } from "@pt/shared";
import type { PoiIndexRecord } from "../db/index.ts";
import type { PrefetchPlan, PrefetchPacing } from "./poiSearchStream.ts";
import type { TileLoader } from "./tileLoader.ts";

const tileGeneration = vi.hoisted(() => ({
  awaitBarrier: vi.fn(async () => {}),
  isCurrent: vi.fn((_record: PoiIndexRecord) => true),
  // Defaults to "already hydrated" so every pre-existing test (none of
  // which exercise the offline-hydration-race fix) keeps today's behavior:
  // no corrective re-emit. Tests for that fix override this per-case.
  isHydrated: vi.fn((_cityId: string) => true),
}));

vi.mock("./tileCache.ts", () => ({
  awaitTileGenerationReadBarrier: tileGeneration.awaitBarrier,
  isPoiRecordInCurrentTileGeneration: tileGeneration.isCurrent,
  isTileGenerationHydrated: tileGeneration.isHydrated,
}));

import { buildSearchPrefetchDriver, type SearchPrefetchDriverDeps } from "./poiSearchDriver.ts";

const ANCHOR: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
const BBOX: Bbox = { minLat: 54.28, maxLat: 54.45, minLon: 18.4, maxLon: 18.7 };
const BUNDLE_SHA256 = "a".repeat(64);
const GENERATION_ID = "b".repeat(64);
const TILE_BOUNDS = { minX: -1, maxX: 1, minY: -1, maxY: 1 };

function tiling(edgeKm = 24) {
  return { edgeKm, anchor: ANCHOR, bundleSha256: BUNDLE_SHA256, generationId: GENERATION_ID, tileBounds: TILE_BOUNDS };
}

type MockLoader = { prefetchTiles: Mock<TileLoader["prefetchTiles"]> };

function makeLoader(): MockLoader {
  return {
    prefetchTiles: vi.fn<TileLoader["prefetchTiles"]>(async () => ({ cityDeliveryDisabled: false, insertedBytes: 16 })),
  };
}

function baseDeps(over: Partial<SearchPrefetchDriverDeps>): SearchPrefetchDriverDeps {
  return {
    poiCityIds: (id) => [id],
    getTiling: vi.fn(async () => tiling()),
    getLoader: vi.fn(() => makeLoader()),
    getViewportBbox: () => BBOX,
    readLandedRows: vi.fn(async () => []),
    scheduleIdle: (task: () => void) => { task(); return 0; },
    runPrefetch: vi.fn(async () => {}),
    getPacing: (): PrefetchPacing => ({ budgetBytes: 1_000_000, estTileBytes: 16 }),
    ...over,
  };
}

beforeEach(() => {
  tileGeneration.awaitBarrier.mockClear();
  tileGeneration.isCurrent.mockReset();
  tileGeneration.isCurrent.mockReturnValue(true);
  tileGeneration.isHydrated.mockReset();
  tileGeneration.isHydrated.mockReturnValue(true);
});

describe("buildSearchPrefetchDriver — 1→N POI-city fan-out (FIX 3 / AC-19)", () => {
  it("constructs a plan + runs prefetch for EACH POI city with THAT city's edge/anchor", async () => {
    const edges: Record<string, number> = { gdansk: 24, gdynia: 20, sopot: 12 };
    const loaders: Record<string, MockLoader> = {
      gdansk: makeLoader(), gdynia: makeLoader(), sopot: makeLoader(),
    };
    const runCalls: Array<{ cityId: string; edgeKm: number; anchor: TileAnchor }> = [];
    const deps = baseDeps({
      poiCityIds: () => ["gdansk", "gdynia", "sopot"],
      getTiling: vi.fn(async (id: string) => tiling(edges[id])),
      getLoader: vi.fn((id: string) => loaders[id]),
      runPrefetch: vi.fn(async (plan: PrefetchPlan) => {
        runCalls.push({ cityId: plan.cityId, edgeKm: plan.edgeKm, anchor: plan.anchor });
      }),
    });

    const driver = buildSearchPrefetchDriver("tricity", deps);
    await driver(vi.fn(), new AbortController().signal);

    // One runViewportPrefetch per POI city, each with its OWN derived edge.
    expect(runCalls).toEqual([
      { cityId: "gdansk", edgeKm: 24, anchor: ANCHOR },
      { cityId: "gdynia", edgeKm: 20, anchor: ANCHOR },
      { cityId: "sopot", edgeKm: 12, anchor: ANCHOR },
    ]);
    // The plan's orderedTileKeys is non-empty (built from the active bbox).
    const firstPlan = vi.mocked(deps.runPrefetch).mock.calls[0][0] as PrefetchPlan;
    expect(firstPlan.orderedTileKeys.length).toBeGreaterThan(0);
  });

  it("skips a POI city whose tiling OR loader is missing (eager fallback), runs the rest", async () => {
    const runCities: string[] = [];
    const deps = baseDeps({
      poiCityIds: () => ["gdansk", "gdynia", "sopot"],
      // gdynia untiled (null), sopot has no loader.
      getTiling: vi.fn(async (id: string) => (id === "gdynia" ? null : tiling())),
      getLoader: vi.fn((id: string) => (id === "sopot" ? undefined : makeLoader())),
      runPrefetch: vi.fn(async (plan: PrefetchPlan) => { runCities.push(plan.cityId); }),
    });

    const driver = buildSearchPrefetchDriver("tricity", deps);
    await driver(vi.fn(), new AbortController().signal);

    expect(runCities).toEqual(["gdansk"]);
  });

  it("runs the per-city prefetches SERIALLY — city N+1 not started until city N resolves (single shared budget authority)", async () => {
    // Each city's runPrefetch blocks on a deferred promise. If the fan-out were
    // concurrent (Promise.all over map), ALL three would be invoked before any
    // resolves; serial means only one is in flight at a time.
    const events: string[] = [];
    const resolvers: Record<string, () => void> = {};
    const deferred = (cityId: string) =>
      new Promise<void>((resolve) => {
        resolvers[cityId] = resolve;
      });
    // Flush the microtask queue until a predicate holds (or a tick budget is
    // exhausted), so the assertions don't depend on a hand-counted tick count
    // (getTiling/getLoader add awaits between cities).
    const flushUntil = async (pred: () => boolean): Promise<void> => {
      for (let i = 0; i < 50 && !pred(); i++) await Promise.resolve();
    };

    const deps = baseDeps({
      poiCityIds: () => ["gdansk", "gdynia", "sopot"],
      runPrefetch: vi.fn(async (plan: PrefetchPlan) => {
        events.push(`start:${plan.cityId}`);
        await deferred(plan.cityId);
        events.push(`end:${plan.cityId}`);
      }),
    });

    const driver = buildSearchPrefetchDriver("tricity", deps);
    const p = driver(vi.fn(), new AbortController().signal);

    // Let the first city start.
    await flushUntil(() => events.length >= 1);
    expect(events).toEqual(["start:gdansk"]);
    // gdynia/sopot must NOT have started while gdansk is in flight.
    expect(resolvers.gdynia).toBeUndefined();
    expect(resolvers.sopot).toBeUndefined();

    // Resolve gdansk → gdynia starts, but only AFTER gdansk ended.
    resolvers.gdansk();
    await flushUntil(() => events.includes("start:gdynia"));
    expect(events).toEqual(["start:gdansk", "end:gdansk", "start:gdynia"]);
    expect(resolvers.sopot).toBeUndefined();

    // Resolve gdynia → sopot starts.
    resolvers.gdynia();
    await flushUntil(() => events.includes("start:sopot"));
    expect(events).toEqual([
      "start:gdansk", "end:gdansk", "start:gdynia", "end:gdynia", "start:sopot",
    ]);

    // Resolve sopot → driver completes.
    resolvers.sopot();
    await p;
    expect(events).toEqual([
      "start:gdansk", "end:gdansk",
      "start:gdynia", "end:gdynia",
      "start:sopot", "end:sopot",
    ]);
  });

  it("coalesced read-back queries the UNION over poiCityIds (FIX 4 consistency)", async () => {
    const landedRow: PoiIndexRecord = {
      id: "gdansk:t", cityId: "gdansk", name: "Harbor", geoBucket: "0_0", aliases: {},
      category: "landmark", lat: 54.35, lon: 18.64, source: "osm", rankBoost: 1, tier: "strict",
      osmId: "node/t", loadSource: "tile",
    };
    // Cold cache at search start (the up-front seed read sees nothing); the row
    // lands DURING prefetch so it is emitted as genuinely-new.
    let landed = false;
    const readLandedRows = vi.fn(async () => (landed ? [landedRow] : []));
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      poiCityIds: () => ["gdansk", "gdynia"],
      readLandedRows,
      // Fire the coalesced land once during prefetch.
      runPrefetch: vi.fn(async (_plan, _pacing, _signal, onLanded: () => void) => {
        landed = true;
        onLanded();
      }),
    });

    const driver = buildSearchPrefetchDriver("tricity", deps);
    await driver(onTileLanded, new AbortController().signal);

    // The read-back is over ALL POI cityIds (not just one) — both the up-front
    // seed read and the coalesced land query the union.
    expect(readLandedRows).toHaveBeenCalledWith(["gdansk", "gdynia"]);
    expect(onTileLanded).toHaveBeenCalledWith([landedRow]);
  });
});

describe("buildSearchPrefetchDriver — per-land delta de-dup (bounded re-scan, AC-17 integration)", () => {
  // A POI row's identity is `osmId ?? id` (the SAME key deduplicateRecords /
  // scorePoiRecord use). The driver must pass each landed row to onTileLanded at
  // most ONCE across coalesced ticks — otherwise mergeLanded re-scores the whole
  // accumulated tile corpus every tick (O(n^2) over a multi-tile prefetch),
  // defeating the / AC-17 bounded-re-scan contract.
  const row = (id: string, osmId?: string): PoiIndexRecord => ({
    id, cityId: "gdansk", name: id, geoBucket: "0_0", aliases: {},
    category: "landmark", lat: 54.35, lon: 18.64, source: "osm", rankBoost: 1,
    tier: "strict", osmId, loadSource: "tile",
  });

  it("passes each landed row at most ONCE — tick 2 excludes rows already emitted in tick 1", async () => {
    const r1 = row("gdansk:a", "node/a");
    const r2 = row("gdansk:b", "node/b");
    const r3 = row("gdansk:c", "node/c");

    // Simulate the production read-back: it returns the FULL accumulated tile
    // corpus for the city each call (Search.tsx readLandedRows reads ALL
    // loadSource:'tile' rows). Read 0 is the up-front warm-seed read (cold cache
    // → []); land-tick 1 sees {r1,r2}; land-tick 2 sees {r1,r2,r3}.
    let tick = 0;
    const readLandedRows = vi.fn(async () => {
      const t = tick++;
      if (t === 0) return []; // seed read: cache cold at search start
      return t === 1 ? [r1, r2] : [r1, r2, r3];
    });

    const payloads: PoiIndexRecord[][] = [];
    const onTileLanded = vi.fn(async (rows: PoiIndexRecord[] = []) => { payloads.push(rows); });

    const deps = baseDeps({
      poiCityIds: () => ["gdansk"],
      readLandedRows,
      // Fire the coalesced land TWICE during prefetch (two idle ticks).
      runPrefetch: vi.fn(async (_plan, _pacing, _signal, onLanded: () => void) => {
        onLanded();
        onLanded();
      }),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    await driver(onTileLanded, new AbortController().signal);

    // Two coalesced ticks → two onTileLanded payloads.
    expect(payloads).toHaveLength(2);
    // Tick 1 emits the brand-new rows r1, r2.
    expect(payloads[0].map((r) => r.osmId ?? r.id)).toEqual(["node/a", "node/b"]);
    // Tick 2 emits ONLY the delta r3 — r1 and r2 are NOT passed again.
    expect(payloads[1].map((r) => r.osmId ?? r.id)).toEqual(["node/c"]);

    // No identity appears in more than one payload (each row seen at most once).
    const seenAcrossTicks = new Map<string, number>();
    for (const p of payloads) {
      for (const r of p) {
        const k = r.osmId ?? r.id;
        seenAcrossTicks.set(k, (seenAcrossTicks.get(k) ?? 0) + 1);
      }
    }
    for (const [, count] of seenAcrossTicks) expect(count).toBe(1);
  });

  it("warm cache: rows already in poiIndex at search start are NOT re-emitted on the first land", async () => {
    // BUG GUARD: tile rows R1,R2 are ALREADY cached in poiIndex before the search
    // starts (the stream's initial emit already scanned+scored them). readLandedRows
    // returns the FULL accumulated loadSource:'tile' corpus, so the first coalesced
    // land would see {R1,R2,R3}. With an empty `seen`, the first re-emit would
    // rescore the entire warm corpus — defeating the bounded path. The driver must
    // SEED `seen` from the rows present at search start (read up front, NOT emitted)
    // so the first land passes ONLY the genuinely-new R3.
    const r1 = row("gdansk:a", "node/a");
    const r2 = row("gdansk:b", "node/b");
    const r3 = row("gdansk:c", "node/c");

    // The corpus is warm from the start: every read-back (the up-front seeding read
    // AND every coalesced land) returns {r1,r2} until r3 lands, then {r1,r2,r3}.
    let r3Landed = false;
    const readLandedRows = vi.fn(async () =>
      r3Landed ? [r1, r2, r3] : [r1, r2],
    );

    const payloads: PoiIndexRecord[][] = [];
    const onTileLanded = vi.fn(async (rows: PoiIndexRecord[] = []) => { payloads.push(rows); });

    const deps = baseDeps({
      poiCityIds: () => ["gdansk"],
      readLandedRows,
      // A NEW tile (r3) lands once during prefetch.
      runPrefetch: vi.fn(async (_plan, _pacing, _signal, onLanded: () => void) => {
        r3Landed = true;
        onLanded();
      }),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    await driver(onTileLanded, new AbortController().signal);

    // Exactly one coalesced land fired → one payload.
    expect(payloads).toHaveLength(1);
    // It contains ONLY the new row r3 — the warm rows r1, r2 are NOT re-emitted.
    expect(payloads[0].map((r) => r.osmId ?? r.id)).toEqual(["node/c"]);
  });

  it("emits a row that lands after the initial scan instead of seeding it as seen", async () => {
    const late = row("gdansk:late", "node/late");
    let landedRows: PoiIndexRecord[] = [];
    const readLandedRows = vi.fn(async () => [...landedRows]);
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      readLandedRows,
      runPrefetch: vi.fn(async (_plan, _pacing, _signal, onLanded) => {
        onLanded();
      }),
    });

    // Production constructs the driver immediately before the stream's initial
    // scan. This row appears after that scan but before the driver is invoked.
    const driver = buildSearchPrefetchDriver("gdansk", deps);
    landedRows = [late];
    await driver(onTileLanded, new AbortController().signal);

    expect(onTileLanded).toHaveBeenCalledWith([late]);
  });

  it("does not let a stale warm row reserve the identity of its current replacement", async () => {
    const stale = {
      ...row("gdansk:old", "node/shared"),
      tileGenerationId: "stale",
    };
    const current = {
      ...row("gdansk:new", "node/shared"),
      tileGenerationId: "current",
    };
    tileGeneration.isCurrent.mockImplementation(
      (record: PoiIndexRecord) => record.tileGenerationId === "current",
    );
    let landed = false;
    const readLandedRows = vi.fn(async () => (landed ? [current] : [stale]));
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      readLandedRows,
      runPrefetch: vi.fn(async (_plan, _pacing, _signal, onLanded) => {
        landed = true;
        onLanded();
      }),
    });

    await buildSearchPrefetchDriver("gdansk", deps)(
      onTileLanded,
      new AbortController().signal,
    );

    expect(onTileLanded).toHaveBeenCalledWith([current]);
    expect(tileGeneration.awaitBarrier).toHaveBeenCalledTimes(2);
    expect(
      tileGeneration.awaitBarrier.mock.invocationCallOrder[0],
    ).toBeLessThan(readLandedRows.mock.invocationCallOrder[0]);
  });

  it("de-dups by osmId ?? id across cities and resets per driver invocation", async () => {
    // osmId absent → identity falls back to id; identity is global across the
    // union, so a row landed for gdansk in tick 1 isn't re-passed in tick 2.
    const a = row("gdansk:a"); // no osmId → id is the identity
    const b = row("gdynia:b"); // no osmId → id is the identity
    // Read 0 is the up-front warm-seed read (cold cache → []); both rows land
    // DURING prefetch (land-tick 1 → {a}; land-tick 2 → {a,b}).
    let tick = 0;
    const readLandedRows = vi.fn(async () => {
      const t = tick++;
      if (t === 0) return []; // seed read: cache cold at search start
      return t === 1 ? [a] : [a, b];
    });
    const payloads: PoiIndexRecord[][] = [];

    const makeDriver = () => {
      tick = 0;
      payloads.length = 0;
      return buildSearchPrefetchDriver("tricity", baseDeps({
        poiCityIds: () => ["gdansk", "gdynia"],
        // Only the first POI city's prefetch fires the lands (keep it simple).
        getLoader: vi.fn((id: string) => (id === "gdansk" ? makeLoader() : undefined)),
        readLandedRows,
        runPrefetch: vi.fn(async (_plan, _pacing, _signal, onLanded: () => void) => {
          onLanded();
          onLanded();
        }),
      }));
    };

    const onTileLanded = vi.fn(async (rows: PoiIndexRecord[] = []) => { payloads.push([...rows]); });

    await makeDriver()(onTileLanded, new AbortController().signal);
    expect(payloads.map((p) => p.map((r) => r.osmId ?? r.id))).toEqual([["gdansk:a"], ["gdynia:b"]]);

    // A FRESH driver invocation starts with an empty `seen` — `a` is emitted again.
    await makeDriver()(onTileLanded, new AbortController().signal);
    expect(payloads.map((p) => p.map((r) => r.osmId ?? r.id))).toEqual([["gdansk:a"], ["gdynia:b"]]);
  });
});

describe("buildSearchPrefetchDriver — flush ordering (FIX 4)", () => {
  it("does NOT resolve until a pending coalesced land has flushed (final onTileLanded before resolve)", async () => {
    const order: string[] = [];
    // Defer the idle callback so the coalesced land is still PENDING when
    // runViewportPrefetch resolves — exactly the post-final stray-emit race.
    let idleTask: (() => void) | null = null;
    const onTileLanded = vi.fn(async () => { order.push("onTileLanded"); });
    const deps = baseDeps({
      readLandedRows: vi.fn(async () => []),
      scheduleIdle: (task: () => void) => { idleTask = task; return 0; },
      runPrefetch: vi.fn(async (_plan, _pacing, _signal, onLanded: () => void) => {
        onLanded(); // schedules a coalesced land that does NOT run synchronously
        order.push("prefetchResolved");
      }),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    const p = driver(onTileLanded, new AbortController().signal);

    // Let the up-front seed read + the prefetch resolve, then release the deferred
    // idle task on a later tick. Flush microtasks until the coalesced land has
    // scheduled its idle work (the seed read adds an async hop before prefetch).
    for (let i = 0; i < 50 && idleTask === null; i++) await Promise.resolve();
    expect(idleTask).not.toBeNull();
    idleTask!();

    await p;
    order.push("driverResolved");

    // The coalesced land's onTileLanded MUST complete before the driver resolves,
    // and no onTileLanded fires AFTER the driver resolves.
    expect(order).toEqual(["prefetchResolved", "onTileLanded", "driverResolved"]);
    expect(onTileLanded).toHaveBeenCalledTimes(1);
  });
});

describe("buildSearchPrefetchDriver — abort (FIX 4)", () => {
  it("an already-aborted signal does no prefetch and no flush", async () => {
    const controller = new AbortController();
    controller.abort();
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      runPrefetch: vi.fn(async () => {}),
      readLandedRows: vi.fn(async () => []),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    await driver(onTileLanded, controller.signal);

    expect(deps.runPrefetch).not.toHaveBeenCalled();
    expect(deps.readLandedRows).toHaveBeenCalledTimes(1);
    expect(onTileLanded).not.toHaveBeenCalled();
  });

  it("abort mid-flight stops the final flush (no onTileLanded after abort)", async () => {
    const controller = new AbortController();
    const idle: { task: (() => void) | null } = { task: null };
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      scheduleIdle: (task: () => void) => { idle.task = task; return 0; },
      runPrefetch: vi.fn(async (_plan, _pacing, signal: AbortSignal, onLanded: () => void) => {
        onLanded();          // schedule a coalesced land
        controller.abort();  // a fresh keystroke aborts before flush
        void signal;
      }),
      readLandedRows: vi.fn(async () => []),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    const p = driver(onTileLanded, controller.signal);
    // Flush microtasks until the mid-flight abort has scheduled its idle land
    // (the up-front seed read adds an async hop before prefetch runs).
    for (let i = 0; i < 50 && idle.task === null; i++) await Promise.resolve();
    // Even if the deferred idle task runs, the abort must short-circuit the land.
    idle.task?.();
    await p;

    expect(onTileLanded).not.toHaveBeenCalled();
    // readLandedRows is called exactly ONCE — the up-front warm-seed read (which
    // ran before the mid-flight abort). The aborted coalesced land short-circuits
    // BEFORE its own read-back, so no second readLandedRows call fires.
    expect(deps.readLandedRows).toHaveBeenCalledTimes(1);
  });
});

describe("buildSearchPrefetchDriver — offline hydration-race corrective re-emit", () => {
  function warmRow(id: string): PoiIndexRecord {
    return {
      id, cityId: "gdansk", name: id, geoBucket: "b", aliases: {},
      category: "landmark", lat: 54.3, lon: 18.6, source: "osm",
      rankBoost: 0, tier: "strict", loadSource: "tile",
    };
  }

  it("re-emits the warm corpus once when hydration was NOT yet installed at construction time, even though nothing new lands", async () => {
    tileGeneration.isHydrated.mockReturnValue(false); // race: not hydrated yet
    const warm = [warmRow("w1"), warmRow("w2")];
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      readLandedRows: vi.fn(async () => warm),
      // No tile ever lands (fully offline / all cache hits) — runPrefetch
      // never calls its own onTileLanded.
      runPrefetch: vi.fn(async () => {}),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    await driver(onTileLanded, new AbortController().signal);

    expect(onTileLanded).toHaveBeenCalledTimes(1);
    expect(onTileLanded).toHaveBeenCalledWith(warm);
  });

  it("does NOT re-emit when hydration was already installed at construction time (common case, no extra emit)", async () => {
    tileGeneration.isHydrated.mockReturnValue(true);
    const warm = [warmRow("w1")];
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      readLandedRows: vi.fn(async () => warm),
      runPrefetch: vi.fn(async () => {}),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    await driver(onTileLanded, new AbortController().signal);

    expect(onTileLanded).not.toHaveBeenCalled();
  });

  it("skips the corrective re-emit when the warm corpus is empty (nothing to correct)", async () => {
    tileGeneration.isHydrated.mockReturnValue(false);
    const onTileLanded = vi.fn();
    const deps = baseDeps({
      readLandedRows: vi.fn(async () => []),
      runPrefetch: vi.fn(async () => {}),
    });

    const driver = buildSearchPrefetchDriver("gdansk", deps);
    await driver(onTileLanded, new AbortController().signal);

    expect(onTileLanded).not.toHaveBeenCalled();
  });
});
