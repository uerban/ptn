import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { TileAnchor } from "@pt/shared";
import {
  orderViewportFirst,
  runViewportPrefetch,
  type PrefetchPlan,
  type PrefetchPacing,
} from "./poiSearchStream.ts";

const ANCHOR: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };
const TILE_METADATA = {
  cityId: "gdansk",
  bundleSha256: "b".repeat(64),
  generationId: "g".repeat(64),
};

describe("orderViewportFirst (AC-16)", () => {
  it("center tile is first; ring N precedes ring N+1", () => {
    const center = "gdansk/24km/0_0";
    const tiles = [
      "gdansk/24km/2_0", "gdansk/24km/0_0", "gdansk/24km/1_1",
      "gdansk/24km/-1_0", "gdansk/24km/0_1",
    ];
    const ordered = orderViewportFirst(center, tiles);
    expect(ordered[0]).toBe("gdansk/24km/0_0");
    const ring = (k: string) => {
      const [x, y] = k.split("/")[2].split("_").map(Number);
      return Math.max(Math.abs(x), Math.abs(y));
    };
    for (let i = 1; i < ordered.length; i++) {
      expect(ring(ordered[i])).toBeGreaterThanOrEqual(ring(ordered[i - 1]));
    }
  });
});

// Helper: a fake loader whose prefetchTiles returns the PrefetchResult shape
// (cityDeliveryDisabled + insertedBytes) the running-counter pacer reads, and
// also writes the row into poiTileCache so cacheByteTotal()/getTile see it.
function fakeLoader(db: import("dexie").Dexie & Record<string, never>, perTileBytes: number) {
  let fetched = 0;
  const prefetchTiles = vi.fn(async (keys: string[]) => {
    let insertedBytes = 0;
    for (const k of keys) {
      fetched++;
      await db.table("poiTileCache").put({ tileKey: k, compressedBytes: new ArrayBuffer(perTileBytes), loadedAt: Date.now(), byteSize: perTileBytes, ...TILE_METADATA });
      insertedBytes += perTileBytes;
    }
    return { cityDeliveryDisabled: false, insertedBytes };
  });
  return { prefetchTiles, get fetched() { return fetched; } };
}

describe("runViewportPrefetch budget pacing (AC-11)", () => {
  beforeEach(async () => { await Dexie.delete("ptn"); });
  afterEach(async () => { await Dexie.delete("ptn"); });

  it("fetches only tiles that fit and skips the rest; converges under budget after eviction", async () => {
    const { db } = await import("../db/index.ts");
    await db.open();
    // Seed cache near the cap: budget 100 bytes, estTileBytes 40, one 80-byte row.
    await db.poiTileCache.put({ tileKey: "gdansk/24km/9_9", compressedBytes: new ArrayBuffer(80), loadedAt: 1, byteSize: 80, ...TILE_METADATA });

    const loader = {
      prefetchTiles: vi.fn(async (keys: string[]) => {
        let insertedBytes = 0;
        for (const k of keys) {
          await db.poiTileCache.put({ tileKey: k, compressedBytes: new ArrayBuffer(20), loadedAt: Date.now(), byteSize: 20, ...TILE_METADATA });
          insertedBytes += 20;
        }
        return { cityDeliveryDisabled: false, insertedBytes };
      }),
    };
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0", "gdansk/24km/1_0", "gdansk/24km/2_0"],
    };
    const pacing: PrefetchPacing = { budgetBytes: 100, estTileBytes: 40 };
    const landed = vi.fn();
    const controller = new AbortController();

    await runViewportPrefetch(plan, pacing, controller.signal, landed, loader);

    // running starts at 80 (the seeded row). 80 + 40 est = 120 > 100 → admission
    // blocks the FIRST candidate and every subsequent one.
    expect(loader.prefetchTiles).not.toHaveBeenCalled();
    expect(landed).not.toHaveBeenCalled();
    await db.close();
  });

  it("admits tiles while they fit then stops (running-counter model)", async () => {
    const { db } = await import("../db/index.ts");
    await db.open();
    const loader = fakeLoader(db as never, 30);
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0", "gdansk/24km/1_0", "gdansk/24km/2_0", "gdansk/24km/3_0"],
    };
    // budget 100, est 40: admit while running + 40 <= 100, then increment running
    // by the ACTUAL 30 the loader reports.
    //   running 0  → 0+40=40<=100 admit → +30 → 30
    //   running 30 → 30+40=70<=100 admit → +30 → 60
    //   running 60 → 60+40=100<=100 admit → +30 → 90
    //   running 90 → 90+40=130>100 STOP
    const pacing: PrefetchPacing = { budgetBytes: 100, estTileBytes: 40 };
    const landed = vi.fn();
    await runViewportPrefetch(plan, pacing, new AbortController().signal, landed, loader);
    expect(loader.fetched).toBe(3);
    expect(landed).toHaveBeenCalledTimes(3);
    await db.close();
  });

  it("cost model: cacheByteTotal is scanned O(1) (no per-tile re-scan) when no eviction fires", async () => {
    const { db } = await import("../db/index.ts");
    await db.open();
    const tileCacheMod = await import("./tileCache.ts");
    const scanSpy = vi.spyOn(tileCacheMod, "cacheByteTotal");
    const loader = fakeLoader(db as never, 10);
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0", "gdansk/24km/1_0", "gdansk/24km/2_0"],
    };
    // Huge budget so no admission skip and no eviction ever fires → the full-table
    // scan must run exactly ONCE (the pre-loop read), proving O(1), not O(tiles).
    await runViewportPrefetch(plan, { budgetBytes: 1_000_000, estTileBytes: 10 }, new AbortController().signal, vi.fn(), loader);
    expect(scanSpy).toHaveBeenCalledTimes(1);
    scanSpy.mockRestore();
    await db.close();
  });
});

describe("runViewportPrefetch abort + 503 break (AC-21/AC-12 preempt)", () => {
  beforeEach(async () => { await Dexie.delete("ptn"); });
  afterEach(async () => { await Dexie.delete("ptn"); });

  it("stops fetching after the signal aborts (deterministic, no real-timer race)", async () => {
    const { db } = await import("../db/index.ts");
    await db.open();
    let fetched = 0;
    const controller = new AbortController();
    const loader = {
      prefetchTiles: vi.fn(async (keys: string[]) => {
        let insertedBytes = 0;
        for (const k of keys) {
          fetched++;
          controller.abort(); // abort during the first call — deterministic, not timed
          await db.poiTileCache.put({ tileKey: k, compressedBytes: new ArrayBuffer(10), loadedAt: Date.now(), byteSize: 10, ...TILE_METADATA });
          insertedBytes += 10;
        }
        return { cityDeliveryDisabled: false, insertedBytes };
      }),
    };
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0", "gdansk/24km/1_0", "gdansk/24km/2_0"],
    };
    await runViewportPrefetch(plan, { budgetBytes: 1_000_000, estTileBytes: 10 }, controller.signal, vi.fn(), loader);
    // The post-call signal.aborted check returns before the 2nd tile is requested.
    expect(fetched).toBe(1);
    await db.close();
  });

  it("AC-21: a 503 (cityDeliveryDisabled) breaks the loop — no further prefetchTiles calls", async () => {
    const { db } = await import("../db/index.ts");
    await db.open();
    const loader = {
      prefetchTiles: vi.fn(async () => ({ cityDeliveryDisabled: true, insertedBytes: 0 })),
    };
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0", "gdansk/24km/1_0", "gdansk/24km/2_0"],
    };
    const landed = vi.fn();
    await runViewportPrefetch(plan, { budgetBytes: 1_000_000, estTileBytes: 10 }, new AbortController().signal, landed, loader);
    // The first call returns cityDeliveryDisabled → loop breaks; tiles 2 and 3
    // are NOT requested, and onTileLanded never fires (nothing inserted).
    expect(loader.prefetchTiles).toHaveBeenCalledTimes(1);
    expect(landed).not.toHaveBeenCalled();
    await db.close();
  });
});

describe("shared budget authority — no evictor/pacer disagreement (AC-11b)", () => {
  beforeEach(async () => { await Dexie.delete("ptn"); });
  afterEach(async () => { await Dexie.delete("ptn"); });

  it("a prefetch then a re-prefetch of the same tile causes no re-fetch (no churn)", async () => {
    const { db } = await import("../db/index.ts");
    const tileCache = await import("./tileCache.ts");
    await db.open();
    tileCache.__resetTileGenerationStateForTests();
    const generation = {
      cityId: "gdansk",
      bundleSha256: "a".repeat(64),
      generationId: "c".repeat(64),
    };
    await tileCache.activateTileGeneration({
      ...generation,
      schemaVersion: 1,
      edgeKm: 24,
      anchor: ANCHOR,
      tileBounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
      tilingPolicy: "k-anon-floor",
      kAnonWaived: false,
      deliveryActive: true,
      validatedAt: 1,
    });
    let fetched = 0;
    const loader = {
      prefetchTiles: vi.fn(async (keys: string[]) => {
        for (const key of keys) {
          fetched += 1;
          await tileCache.putTile(
            key,
            generation,
            new ArrayBuffer(20),
            Date.now(),
          );
        }
        return { cityDeliveryDisabled: false, insertedBytes: keys.length * 20 };
      }),
      get fetched() {
        return fetched;
      },
    };
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0"],
    };
    const pacing: PrefetchPacing = { budgetBytes: 1_000_000, estTileBytes: 40 };
    await runViewportPrefetch(plan, pacing, new AbortController().signal, vi.fn(), loader);
    await runViewportPrefetch(plan, pacing, new AbortController().signal, vi.fn(), loader);
    expect(loader.fetched).toBe(1); // second run sees the cached tile (getTile), no re-fetch
    await db.close();
    tileCache.__resetTileGenerationStateForTests();
  });

  it("admission interacts with a REAL tier budget + the real PREFETCH_EST_TILE_BYTES (not just synthetic 100-byte budgets)", async () => {
    const { db } = await import("../db/index.ts");
    const { PREFETCH_EST_TILE_BYTES } = await import("@pt/shared");
    await db.open();
    // paranoid tier budget = 5 MB (privacy.ts). Seed to within HALF an est of the cap so admission
    // MUST skip the first candidate even at the est — this catches a future est value
    // that silently breaks the tier interaction (with est 64 KB and the smallest tier 5 MB, a
    // synthetic 100-byte test never would).
    const PARANOID_BUDGET = 5_000_000;
    await db.poiTileCache.put({
      tileKey: "gdansk/24km/9_9",
      compressedBytes: new ArrayBuffer(8),
      loadedAt: 1,
      byteSize: PARANOID_BUDGET - Math.floor(PREFETCH_EST_TILE_BYTES / 2),
      ...TILE_METADATA,
    });
    const loader = fakeLoader(db as never, 1000);
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0"],
    };
    await runViewportPrefetch(
      plan,
      { budgetBytes: PARANOID_BUDGET, estTileBytes: PREFETCH_EST_TILE_BYTES },
      new AbortController().signal,
      vi.fn(),
      loader,
    );
    // seeded ≈ budget - est/2; seeded + est > budget → admission blocks.
    expect(loader.fetched).toBe(0);
    await db.close();
  });
});
