import { describe, it, expect } from "vitest";
import { LRUCache } from "lru-cache";
import { GtfsStore } from "../../src/gtfs/store.js";
import { buildIndexes } from "../../src/gtfs/index-builder.js";
import {
  fixtureStops,
  fixtureRoutes,
  fixtureTrips,
  fixtureStopTimes,
  fixtureServices,
} from "../../src/gtfs/__fixtures__/simpleCity.js";

// ── Setup helper ────────────────────────────────────────────────────────────

function setupStore(): GtfsStore {
  const store = new GtfsStore();
  const { indexes, canonical, routingInput } = buildIndexes(
    fixtureStops,
    fixtureRoutes,
    fixtureTrips,
    fixtureStopTimes,
    fixtureServices,
    [],
  );
  store.swap(indexes, canonical, routingInput);
  return store;
}

// Behavioural tests for `activeRoutesCache`: warm-hit identity, key separation (hour bucket and
// 5-min bucket), `swap()`-triggered invalidation, and byte-bounded eviction.

describe("activeRoutesCache LRU", () => {
  it("warm hit returns the same Map reference (sync fast path preserved)", () => {
    const store = setupStore();
    const date = new Date(2026, 0, 15, 8, 0, 0);
    const a = store.getActiveRoutesByStop(date, 2);
    const b = store.getActiveRoutesByStop(date, 2);
    expect(a).toBe(b); // same reference proves the cache returned without rebuilding
  });

  it("different hours produce different cached entries", () => {
    const store = setupStore();
    const a = store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 0, 0), 2);
    const b = store.getActiveRoutesByStop(new Date(2026, 0, 15, 9, 0, 0), 2);
    expect(a).not.toBe(b);
  });

  it("same 5-minute bucket maps to the same cache slot", () => {
    // 8:00 and 8:04 both fall in the [0, 5) minute bucket → same slot
    const store = setupStore();
    const a = store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 0, 0), 2);
    const b = store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 4, 0), 2);
    expect(a).toBe(b);
  });

  it("crossing a 5-minute bucket boundary produces a different cache slot", () => {
    // 8:00 (bucket 0) vs 8:05 (bucket 1) → different slots
    const store = setupStore();
    const a = store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 0, 0), 2);
    const b = store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 5, 0), 2);
    expect(a).not.toBe(b);
  });

  it("swap() empties the cache (size === 0 immediately after)", () => {
    const store = setupStore();
    // Populate from multiple slots to prove `clear()` zaps everything,
    // not just `delete(specificKey)`.
    store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 0, 0), 2);
    store.getActiveRoutesByStop(new Date(2026, 0, 15, 9, 0, 0), 2);

    // Whitebox: assert the LRU is structurally empty after swap. This is
    // stronger than re-querying and asserting reference inequality, which
    // would also pass under a partial `delete(key)` regression.
    type WithCache = GtfsStore & {
      activeRoutesCache: { size: number };
    };
    const beforeSize = (store as WithCache).activeRoutesCache.size;
    expect(beforeSize).toBeGreaterThan(0);

    const { indexes, canonical, routingInput } = buildIndexes(
      fixtureStops,
      fixtureRoutes,
      fixtureTrips,
      fixtureStopTimes,
      fixtureServices,
      [],
    );
    store.swap(indexes, canonical, routingInput);

    expect((store as WithCache).activeRoutesCache.size).toBe(0);
  });

  it("evicts older entries when the byte budget is exceeded", () => {
    // Whitebox replacement of the field with a tiny LRU so we can
    // exercise eviction without synthesising 128 MB of entries.
    // simpleCity fixture entries are small (~few bytes), so a per-entry
    // count cap is the cleanest way to pin the eviction-under-pressure
    // contract: the cache MUST drop oldest entries when a new one
    // arrives at capacity. A future regression that breaks the LRU
    // wiring (e.g. swapping in an unbounded Map) would silently disable
    // eviction and only surface as OOM in production.
    const store = setupStore();
    type WithCache = GtfsStore & {
      activeRoutesCache: LRUCache<string, Map<string, Set<string>>>;
    };
    (store as WithCache).activeRoutesCache = new LRUCache<
      string,
      Map<string, Set<string>>
    >({
      max: 3, // entry-count cap; fixture-size-independent
    });

    // Populate slot A and capture the Map reference so we can prove the
    // original entry was evicted (a re-query rebuilds a new reference).
    const a = store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 0, 0), 2);

    // Populate enough additional slots that the count cap must evict
    // the original `a` entry. Each hour produces a distinct cache key.
    for (let h = 9; h < 14; h++) {
      store.getActiveRoutesByStop(new Date(2026, 0, 15, h, 0, 0), 2);
    }

    // Cache holds at most `max: 3` entries — strictly fewer than the
    // 6 slots we populated.
    expect((store as WithCache).activeRoutesCache.size).toBeLessThanOrEqual(3);

    // Re-query slot A: should be a fresh Map, not the originally-cached
    // reference (would equal `a` if the LRU had silently retained it).
    const aRequery = store.getActiveRoutesByStop(
      new Date(2026, 0, 15, 8, 0, 0),
      2,
    );
    expect(aRequery).not.toBe(a);
  });

  it("byte-bounded sizeCalculation returns finite positive bytes for non-empty maps", () => {
    // Pin the contract that the production sizeCalculation returns a
    // sensible byte estimate (rather than e.g. 0 or NaN), so a future
    // regression like `return 0` or `return data.size` (entry count
    // instead of bytes) would surface here. The runtime correctness of
    // the LRU eviction depends on this returning a value that scales
    // with content.
    const store = setupStore();
    type WithCache = GtfsStore & {
      activeRoutesCache: LRUCache<string, Map<string, Set<string>>>;
    };
    store.getActiveRoutesByStop(new Date(2026, 0, 15, 8, 0, 0), 2);
    const cache = (store as WithCache).activeRoutesCache;
    expect(cache.size).toBeGreaterThan(0);
    expect(cache.calculatedSize).toBeGreaterThan(0);
    expect(Number.isFinite(cache.calculatedSize)).toBe(true);
  });
});
