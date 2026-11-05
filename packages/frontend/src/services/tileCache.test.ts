import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";

vi.mock("./storagePolicy.ts", () => ({
  registerEvictor: vi.fn(),
}));

vi.mock("./errorReporter.ts", () => ({
  reportError: vi.fn(),
}));

function makeBytes(size: number, stamp = 0): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf)[0] = stamp & 0xff;
  return buf;
}

const BUNDLE_SHA256 = "a".repeat(64);
const GENERATION_ID = "c".repeat(64);

function generation(tileKey: string) {
  return {
    cityId: tileKey.includes("/") ? tileKey.split("/")[0] : "test",
    bundleSha256: BUNDLE_SHA256,
    generationId: GENERATION_ID,
  };
}

function storedKey(tileKey: string): string {
  return `${tileKey}?v=${GENERATION_ID}`;
}

async function put(
  tileCache: typeof import("./tileCache.ts"),
  tileKey: string,
  bytes: ArrayBuffer,
  loadedAt: number,
): Promise<void> {
  await tileCache.putTile(tileKey, generation(tileKey), bytes, loadedAt);
}

async function freshModules(): Promise<{
  tileCache: typeof import("./tileCache.ts");
  db: typeof import("../db/index.ts").db;
}> {
  vi.resetModules();
  const dbMod = await import("../db/index.ts");
  await dbMod.db.open();
  const tileCache = await import("./tileCache.ts");
  for (const cityId of ["gdansk", "test"]) {
    await tileCache.activateTileGeneration({
      cityId,
      generationId: GENERATION_ID,
      bundleSha256: BUNDLE_SHA256,
      schemaVersion: 1,
      edgeKm: 12,
      anchor: { minLat: 0, minLon: 0, refLat: 54 },
      tileBounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
      tilingPolicy: "k-anon-floor",
      kAnonWaived: false,
      deliveryActive: true,
      validatedAt: 1,
    });
  }
  return { tileCache, db: dbMod.db };
}

describe("tileCache", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.resetModules();
    const mod = await import("../db/index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  describe("getTile / putTile / cacheByteTotal", () => {
    it("putTile writes a row with compressed bytes, loadedAt, byteSize", async () => {
      const { tileCache, db } = await freshModules();
      const bytes = makeBytes(1024, 1);
      await put(tileCache, "gdansk/12km/0_0", bytes, 1_700_000_000);

      const row = await db.poiTileCache.get(storedKey("gdansk/12km/0_0"));
      expect(row).toBeDefined();
      expect(row?.tileKey).toBe(storedKey("gdansk/12km/0_0"));
      expect(row?.cityId).toBe("gdansk");
      expect(row?.bundleSha256).toBe(BUNDLE_SHA256);
      expect(row?.generationId).toBe(GENERATION_ID);
      expect(row?.byteSize).toBe(1024);
      expect(row?.compressedBytes.byteLength).toBe(1024);
      expect(row?.loadedAt).toBe(1_700_000_000);
    });

    it("getTile returns the stored row, or undefined when missing", async () => {
      const { tileCache } = await freshModules();
      expect(
        await tileCache.getTile("gdansk/12km/0_0", GENERATION_ID),
      ).toBeUndefined();

      await put(tileCache, "gdansk/12km/0_0", makeBytes(256, 2), 100);
      const hit = await tileCache.getTile(
        "gdansk/12km/0_0",
        GENERATION_ID,
      );
      expect(hit?.byteSize).toBe(256);
      expect(hit?.loadedAt).toBe(100);
    });

    it("cacheByteTotal sums byteSize across all rows", async () => {
      const { tileCache } = await freshModules();
      await put(tileCache, "a", makeBytes(100, 1), 1);
      await put(tileCache, "b", makeBytes(200, 2), 2);
      await put(tileCache, "c", makeBytes(300, 3), 3);
      expect(await tileCache.cacheByteTotal()).toBe(600);
    });
  });

  describe("ensureUnderBudget", () => {
    it("deletes oldest tiles by loadedAt until total ≤ budget", async () => {
      const { tileCache, db } = await freshModules();
      // 5 tiles × 1.5MB = 7.5MB; budget is 5MB → drop oldest 2 (3MB) → 4.5MB
      const size = 1_500_000;
      await put(tileCache, "t-oldest", makeBytes(size, 1), 100);
      await put(tileCache, "t-older", makeBytes(size, 2), 200);
      await put(tileCache, "t-mid", makeBytes(size, 3), 300);
      await put(tileCache, "t-newer", makeBytes(size, 4), 400);
      await put(tileCache, "t-newest", makeBytes(size, 5), 500);

      await tileCache.ensureUnderBudget();

      const remaining = (await db.poiTileCache.toArray())
        .map((r) => r.tileKey.split("?v=")[0])
        .sort();
      expect(remaining).toEqual(["t-mid", "t-newer", "t-newest"]);
      expect(await tileCache.cacheByteTotal()).toBeLessThanOrEqual(5_000_000);
    });

    it("is a no-op when total is already under budget", async () => {
      const { tileCache, db } = await freshModules();
      await put(tileCache, "a", makeBytes(1000, 1), 1);
      await put(tileCache, "b", makeBytes(2000, 2), 2);

      await tileCache.ensureUnderBudget();

      expect(await db.poiTileCache.count()).toBe(2);
    });

    it("serializes concurrent calls via a lock (no double-eviction)", async () => {
      const { tileCache, db } = await freshModules();
      const size = 1_500_000;
      for (let i = 0; i < 5; i++) {
        await put(tileCache, `t${i}`, makeBytes(size, i), i * 10);
      }

      // Fire two concurrent ensureUnderBudget calls. If unserialized, they
      // could both read the same pre-eviction total and delete more than
      // necessary (over-eviction). Serialization → only one eviction pass
      // runs, the second sees the post-eviction state and no-ops.
      await Promise.all([
        tileCache.ensureUnderBudget(),
        tileCache.ensureUnderBudget(),
      ]);

      const remaining = (await db.poiTileCache.toArray())
        .map((r) => r.tileKey.split("?v=")[0])
        .sort();
      // 5 × 1.5MB = 7.5MB; budget is 5MB → drop oldest 2 → 3 remain (4.5MB)
      expect(remaining).toEqual(["t2", "t3", "t4"]);
      expect(await tileCache.cacheByteTotal()).toBeLessThanOrEqual(5_000_000);
    });
  });

  describe("evictOldest", () => {
    it("deletes N oldest tiles by loadedAt", async () => {
      const { tileCache, db } = await freshModules();
      await put(tileCache, "a", makeBytes(100, 1), 500);
      await put(tileCache, "b", makeBytes(100, 2), 100);
      await put(tileCache, "c", makeBytes(100, 3), 300);
      await put(tileCache, "d", makeBytes(100, 4), 200);

      const deleted = await tileCache.evictOldest(2);
      expect(deleted.map((key) => key.split("?v=")[0]).sort()).toEqual([
        "b",
        "d",
      ]);
      const remaining = (await db.poiTileCache.toArray())
        .map((r) => r.tileKey.split("?v=")[0])
        .sort();
      expect(remaining).toEqual(["a", "c"]);
    });

    it("returns [] when count ≤ 0 and does not touch the table", async () => {
      const { tileCache, db } = await freshModules();
      await put(tileCache, "a", makeBytes(100, 1), 1);
      const deleted = await tileCache.evictOldest(0);
      expect(deleted).toEqual([]);
      expect(await db.poiTileCache.count()).toBe(1);
    });
  });

  describe("storagePolicy integration", () => {
    it("registers a 'poiTileCache' evictor with storagePolicy at module load", async () => {
      const { tileCache } = await freshModules();
      const storagePolicy = await import("./storagePolicy.ts");
      expect(storagePolicy.registerEvictor).toHaveBeenCalledWith(
        "poiTileCache",
        expect.any(Function),
      );
      expect(tileCache).toBeDefined();
    });

    it("the registered evictor clears all tile rows", async () => {
      const { tileCache, db } = await freshModules();
      await put(tileCache, "a", makeBytes(100, 1), 1);
      await put(tileCache, "b", makeBytes(100, 2), 2);
      expect(await db.poiTileCache.count()).toBe(2);

      const storagePolicy = await import("./storagePolicy.ts");
      const calls = (
        storagePolicy.registerEvictor as ReturnType<typeof vi.fn>
      ).mock.calls;
      const tileCall = calls.find((c) => c[0] === "poiTileCache");
      expect(tileCall).toBeDefined();
      const evictor = tileCall![1] as () => Promise<void>;
      await evictor();

      expect(await db.poiTileCache.count()).toBe(0);
    });
  });

  describe("activateTileGeneration — manifestGeneratedAt monotonic authority", () => {
    function record(overrides: Partial<Parameters<typeof import("./tileCache.ts")["activateTileGeneration"]>[0]> = {}) {
      return {
        cityId: "gdansk",
        generationId: GENERATION_ID,
        bundleSha256: BUNDLE_SHA256,
        schemaVersion: 1,
        edgeKm: 12,
        anchor: { minLat: 0, minLon: 0, refLat: 54 },
        tileBounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 },
        tilingPolicy: "k-anon-floor" as const,
        kAnonWaived: false,
        deliveryActive: true as const,
        validatedAt: 1,
        ...overrides,
      };
    }

    it("activates an older source on rollback and rejects delayed cross-tab activation", async () => {
      const { tileCache, db } = await freshModules();
      await tileCache.activateTileGeneration(record({ activationRevision: 2, manifestGeneratedAt: 200 }));
      const rollback = record({ activationRevision: 3, manifestGeneratedAt: 100, generationId: "d".repeat(64) });
      expect((await tileCache.activateTileGeneration(rollback)).generationId).toBe(rollback.generationId);
      const delayed = record({ activationRevision: 2, manifestGeneratedAt: 200, generationId: "f".repeat(64) });
      expect((await tileCache.activateTileGeneration(delayed)).activationRevision).toBe(3);
      expect((await db.poiTileGenerations.get("gdansk"))?.manifestGeneratedAt).toBe(100);
    });

    it("retains activation authority when a new manifest disables the city", async () => {
      const { tileCache, db } = await freshModules();
      await tileCache.deactivateTileGeneration("gdansk", undefined, 5);
      const delayed = await tileCache.activateTileGeneration(record({ activationRevision: 4 }));
      expect(delayed.deliveryActive).toBe(false);
      expect((await db.poiTileGenerations.get("gdansk"))?.activationRevision).toBe(5);
      expect(tileCache.isTileGenerationHydrated("gdansk")).toBe(false);
    });

    it("permits same-activation retry after an API resync without losing its high-water mark", async () => {
      const { tileCache } = await freshModules();
      const current = record({ activationRevision: 3 });
      await tileCache.activateTileGeneration(current);
      await tileCache.deactivateTileGeneration("gdansk", current);
      expect((await tileCache.activateTileGeneration(record({ activationRevision: 2 }))).deliveryActive).toBe(false);
      expect((await tileCache.activateTileGeneration(current)).deliveryActive).toBe(true);
    });

    it("a fresh online fetch does NOT overwrite a persisted record with a strictly newer manifestGeneratedAt", async () => {
      const { tileCache, db } = await freshModules();
      const newer = record({
        generationId: "e".repeat(64),
        manifestGeneratedAt: 200,
      });
      await tileCache.activateTileGeneration(newer);

      // A stale in-flight fetch (e.g. an edge-cached manifest) resolves
      // AFTER the newer cross-tab release already activated.
      const stale = record({
        generationId: "f".repeat(64),
        manifestGeneratedAt: 100,
      });
      const winner = await tileCache.activateTileGeneration(stale);

      expect(winner.generationId).toBe(newer.generationId);
      const persisted = await db.poiTileGenerations.get("gdansk");
      expect(persisted?.generationId).toBe(newer.generationId);
    });

    it("a newer manifestGeneratedAt DOES overwrite an older persisted record", async () => {
      const { tileCache, db } = await freshModules();
      const older = record({
        generationId: "e".repeat(64),
        manifestGeneratedAt: 100,
      });
      await tileCache.activateTileGeneration(older);

      const newer = record({
        generationId: "f".repeat(64),
        manifestGeneratedAt: 200,
      });
      const winner = await tileCache.activateTileGeneration(newer);

      expect(winner.generationId).toBe(newer.generationId);
      const persisted = await db.poiTileGenerations.get("gdansk");
      expect(persisted?.generationId).toBe(newer.generationId);
    });

    it("falls through to unconditional activation when either side omits manifestGeneratedAt", async () => {
      const { tileCache, db } = await freshModules();
      const noTimestamp = record({ generationId: "e".repeat(64) });
      await tileCache.activateTileGeneration(noTimestamp);

      const next = record({ generationId: "f".repeat(64) });
      const winner = await tileCache.activateTileGeneration(next);

      expect(winner.generationId).toBe(next.generationId);
      const persisted = await db.poiTileGenerations.get("gdansk");
      expect(persisted?.generationId).toBe(next.generationId);
    });
  });

  describe("cachedTileKeysForGeneration / isTileGenerationHydrated", () => {
    it("returns exactly the canonical (non-suffixed) keys cached for one generation", async () => {
      const { tileCache } = await freshModules();
      await put(tileCache, "gdansk/12km/0_0", makeBytes(10, 1), 1);
      await put(tileCache, "gdansk/12km/1_0", makeBytes(10, 2), 2);

      const keys = await tileCache.cachedTileKeysForGeneration(generation("gdansk/12km/0_0"));
      expect(keys).toEqual(new Set(["gdansk/12km/0_0", "gdansk/12km/1_0"]));
    });

    it("isTileGenerationHydrated is true only once state has been installed for that city", async () => {
      const { tileCache } = await freshModules();
      expect(tileCache.isTileGenerationHydrated("gdansk")).toBe(true); // installed by freshModules() setup
      expect(tileCache.isTileGenerationHydrated("never-activated")).toBe(false);
    });
  });
});
