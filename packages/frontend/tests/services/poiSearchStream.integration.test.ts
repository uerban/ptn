import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { TileAnchor, PoiEntry } from "@pt/shared";
import { runViewportPrefetch, orderViewportFirst, type PrefetchPlan } from "../../src/services/poiSearchStream.ts";
import { searchSuggestionsStream } from "../../src/services/searchSuggestions.ts";

const ANCHOR: TileAnchor = { minLat: 54.28, minLon: 18.4, refLat: 54.365 };

describe("real runViewportPrefetch drives the stream to re-emit (production seam)", () => {
  beforeEach(async () => { await Dexie.delete("ptn"); });
  afterEach(async () => { await Dexie.delete("ptn"); });

  it("a tile landing through the REAL prefetch path causes a second onResults emit", async () => {
    const { db } = await import("../../src/db/index.ts");
    await db.open();
    // Pre-seed one matching bundle row so the FIRST emit is non-empty.
    await db.poiIndex.put({
      id: "gdansk:seed", cityId: "gdansk", name: "Harbor Seed", geoBucket: "0_0", aliases: {},
      category: "landmark", lat: 54.35, lon: 18.64, source: "osm", rankBoost: 1, tier: "strict", osmId: "node/seed",
    });
    // A loader whose prefetchTiles INSERTS a matching tile row (loadSource:'tile')
    // and reports its byteSize — the real PrefetchResult shape.
    const loader = {
      prefetchTiles: vi.fn(async (keys: string[]) => {
        let insertedBytes = 0;
        for (const k of keys) {
          await db.poiIndex.put({
            id: `gdansk:${k}`, cityId: "gdansk", name: "Harbor Tile", geoBucket: "0_0", aliases: {},
            category: "landmark", lat: 54.35, lon: 18.64, source: "osm", rankBoost: 2, tier: "strict",
            osmId: "node/tile", loadSource: "tile",
          });
          await db.poiTileCache.put({ tileKey: k, compressedBytes: new ArrayBuffer(16), loadedAt: Date.now(), byteSize: 16, cityId: "gdansk", bundleSha256: "b".repeat(64), generationId: "g".repeat(64) });
          insertedBytes += 16;
        }
        return { cityDeliveryDisabled: false, insertedBytes };
      }),
    };

    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: orderViewportFirst("gdansk/24km/0_0", ["gdansk/24km/0_0"]),
    };

    const emits: import("../../src/services/searchSuggestions.ts").SearchSuggestion[][] = [];
    await searchSuggestionsStream("harbor", "gdansk", null, new AbortController().signal, "local", {
      onResults: (partial) => emits.push(partial),
      driver: async (onTileLanded, signal) => {
        await runViewportPrefetch(
          plan, { budgetBytes: 1_000_000, estTileBytes: 16 }, signal,
          async () => {
            const landed = await db.poiIndex.where("[cityId+name]")
              .between(["gdansk", Dexie.minKey], ["gdansk", Dexie.maxKey])
              .filter((r) => r.loadSource === "tile").toArray();
            await onTileLanded(landed);
          },
          loader,
        );
      },
    });

    expect(emits.length).toBeGreaterThanOrEqual(2); // first (seed) + re-emit (tile landed)
    expect(loader.prefetchTiles).toHaveBeenCalled();
    await db.close();
  });

  it("aborting the signal mid-prefetch stops further fetches (input preemption / AC-12)", async () => {
    const { db } = await import("../../src/db/index.ts");
    await db.open();
    const controller = new AbortController();
    let fetched = 0;
    const loader = {
      prefetchTiles: vi.fn(async (keys: string[]) => {
        for (const k of keys) {
          fetched++;
          controller.abort(); // a fresh keystroke would abort here
          await db.poiTileCache.put({ tileKey: k, compressedBytes: new ArrayBuffer(8), loadedAt: Date.now(), byteSize: 8, cityId: "gdansk", bundleSha256: "b".repeat(64), generationId: "g".repeat(64) });
        }
        return { cityDeliveryDisabled: false, insertedBytes: 8 };
      }),
    };
    const plan: PrefetchPlan = {
      cityId: "gdansk", edgeKm: 24, anchor: ANCHOR,
      orderedTileKeys: ["gdansk/24km/0_0", "gdansk/24km/1_0", "gdansk/24km/2_0"],
    };
    await searchSuggestionsStream("harbor", "gdansk", null, controller.signal, "local", {
      onResults: () => {},
      driver: async (onTileLanded, signal) => {
        await runViewportPrefetch(plan, { budgetBytes: 1_000_000, estTileBytes: 8 }, signal, async () => onTileLanded([]), loader);
      },
    });
    // Only the first tile was fetched before the abort short-circuited the loop.
    expect(fetched).toBe(1);
    await db.close();
  });
});
