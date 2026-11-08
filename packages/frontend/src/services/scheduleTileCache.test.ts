import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import type { DecodedScheduleTile } from "@pt/shared/schedule-tile";
import { encodeScheduleTile } from "@pt/shared/transit";
import type { FetchScheduleTileResult } from "./api.ts";

// The real `decompressBrotli` falls back to `brotli-dec-wasm` in jsdom (no
// DecompressionStream("br") support), and that fallback fetches the wasm
// module over the network — which undici rejects with "not implemented" in
// this env. Swap it for `node:zlib`'s `brotliDecompressSync`, which decodes
// the SAME standard brotli bytes the fixture is compressed with, so the
// encode→compress→decompress→decode round-trip stays fully real.
vi.mock("./brotliDecode.ts", () => ({
  decompressBrotli: (buf: ArrayBuffer): Promise<string> =>
    Promise.resolve(brotliDecompressSync(Buffer.from(buf)).toString("utf8")),
}));

const HASH = "deadbeef";
const OTHER = "cafef00d";
const SIZE = "6km";
const COORD = "1_2";

// Mock only `fetchScheduleTile`; keep the rest of `./api.ts` real so other
// consumers that import from it (and re-export types) keep working.
const fetchScheduleTileMock =
  vi.fn<(...args: string[]) => Promise<FetchScheduleTileResult>>();
vi.mock("./api.ts", async (importActual) => {
  const actual = await importActual<typeof import("./api.ts")>();
  return { ...actual, fetchScheduleTile: fetchScheduleTileMock };
});

const notifyWriteGrewMock = vi.fn<() => Promise<unknown>>(() => Promise.resolve([]));
vi.mock("./storagePolicy.ts", async (importActual) => {
  const actual = await importActual<typeof import("./storagePolicy.ts")>();
  return { ...actual, notifyWriteGrew: notifyWriteGrewMock };
});

function toArrayBuffer(b: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

/** Minimal valid `DecodedScheduleTile` (single trip touching STOP-A), built
 *  inline so the test stays within the frontend rootDir (no cross-package
 *  fixture import). Shape mirrors `mkSingleTripTile` from shared. */
function mkTile(bundleHash = HASH): DecodedScheduleTile {
  return {
    bundleHash,
    cityId: "test",
    tileSize: 6000,
    stringTable: ["T1", "Downtown"],
    routes: [
      { id: "R1", shortName: "42", longName: "42", mode: "BUS" },
    ],
    calendar: [
      {
        serviceId: "S1",
        days: [true, true, true, true, true, false, false],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      },
    ],
    trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
    stops: {
      "STOP-A": {
        tripIxs: new Uint32Array([0]),
        departureSecs: new Uint32Array([3600]),
      },
    },
  };
}

/** A real brotli-compressed, codec-encoded tile so the decode round-trip is
 *  exercised end-to-end (not a hand-rolled blob). */
function makeTileBytes(bundleHash = HASH): ArrayBuffer {
  return toArrayBuffer(brotliCompressSync(Buffer.from(encodeScheduleTile(mkTile(bundleHash)))));
}

async function freshModule(): Promise<{
  mod: typeof import("./scheduleTileCache.ts");
  db: typeof import("../db/index.ts").db;
}> {
  vi.resetModules();
  const dbMod = await import("../db/index.ts");
  await dbMod.db.open();
  const mod = await import("./scheduleTileCache.ts");
  return { mod, db: dbMod.db };
}

describe("scheduleTileCache", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
    fetchScheduleTileMock.mockReset();
    vi.clearAllMocks();
    notifyWriteGrewMock.mockReset();
    notifyWriteGrewMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.resetModules();
    const dbMod = await import("../db/index.ts");
    dbMod.db.close();
    await Dexie.delete("ptn");
  });

  describe("getDecodedTile", () => {
    it("MISS → fetches, caches the COMPRESSED bytes, decodes and returns the tile", async () => {
      const { mod, db } = await freshModule();
      const tileBytes = makeTileBytes();
      fetchScheduleTileMock.mockResolvedValue({
        status: 200,
        bytes: tileBytes,
        bundleHash: HASH,
      });

      const result = await mod.getDecodedTile(HASH, SIZE, COORD);

      expect(fetchScheduleTileMock).toHaveBeenCalledTimes(1);
      expect(fetchScheduleTileMock).toHaveBeenCalledWith(HASH, SIZE, COORD);
      expect("tile" in result).toBe(true);
      if (!("tile" in result)) throw new Error("expected a tile");
      // Decoded round-trip: a known field survives encode→compress→decompress→decode.
      expect(result.tile.bundleHash).toBe(HASH);
      expect(Object.keys(result.tile.stops)).toContain("STOP-A");

      const key = `${HASH}/${SIZE}/${COORD}`;
      const row = await db.scheduleTileCache.get(key);
      expect(row).toBeDefined();
      expect(row?.key).toBe(key);
      expect(row?.byteSize).toBe(tileBytes.byteLength);
      expect(row?.compressedBytes.byteLength).toBe(tileBytes.byteLength);
    });

    it("HIT → does not call fetchScheduleTile a second time", async () => {
      const { mod } = await freshModule();
      fetchScheduleTileMock.mockResolvedValue({
        status: 200,
        bytes: makeTileBytes(),
        bundleHash: HASH,
      });

      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(fetchScheduleTileMock).toHaveBeenCalledTimes(1);

      const second = await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(fetchScheduleTileMock).toHaveBeenCalledTimes(1);
      expect("tile" in second).toBe(true);
      if (!("tile" in second)) throw new Error("expected a tile");
      expect(second.tile.bundleHash).toBe(HASH);
    });

    it("non-200 → returns the raw FetchScheduleTileResult and writes no row", async () => {
      const { mod, db } = await freshModule();
      fetchScheduleTileMock.mockResolvedValue({ status: 409, bundleHash: HASH });

      const result = await mod.getDecodedTile(HASH, SIZE, COORD);

      expect("fetchResult" in result).toBe(true);
      if (!("fetchResult" in result)) throw new Error("expected a fetchResult");
      expect(result.fetchResult.status).toBe(409);
      expect(result.fetchResult.bundleHash).toBe(HASH);

      const row = await db.scheduleTileCache.get(`${HASH}/${SIZE}/${COORD}`);
      expect(row).toBeUndefined();
    });

    it("invalid coord → returns { fetchResult: { status: 0 } }, never fetches or writes", async () => {
      const { mod, db } = await freshModule();

      const result = await mod.getDecodedTile(HASH, SIZE, "bad coord!");

      expect("fetchResult" in result).toBe(true);
      if (!("fetchResult" in result)) throw new Error("expected a fetchResult");
      expect(result.fetchResult.status).toBe(0);
      expect(fetchScheduleTileMock).not.toHaveBeenCalled();
      expect(await db.scheduleTileCache.count()).toBe(0);
    });

    it("poison-pill cached row (C1) → deletes the bad row, refetches once, re-caches a good row", async () => {
      const { mod, db } = await freshModule();
      const key = `${HASH}/${SIZE}/${COORD}`;
      // Seed a row whose compressedBytes are NOT valid brotli — decode throws.
      const garbage = toArrayBuffer(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
      await db.scheduleTileCache.put({
        key,
        compressedBytes: garbage,
        loadedAt: 1,
        byteSize: garbage.byteLength,
      });
      const goodBytes = makeTileBytes();
      fetchScheduleTileMock.mockResolvedValue({
        status: 200,
        bytes: goodBytes,
        bundleHash: HASH,
      });

      const result = await mod.getDecodedTile(HASH, SIZE, COORD);

      // Refetched exactly once after self-healing the corrupt row.
      expect(fetchScheduleTileMock).toHaveBeenCalledTimes(1);
      expect("tile" in result).toBe(true);
      if (!("tile" in result)) throw new Error("expected a tile");
      expect(result.tile.bundleHash).toBe(HASH);

      // A good row was re-cached over the bad one.
      const row = await db.scheduleTileCache.get(key);
      expect(row).toBeDefined();
      expect(row?.byteSize).toBe(goodBytes.byteLength);
      expect(row?.compressedBytes.byteLength).toBe(goodBytes.byteLength);
    });

    it("fresh 200 with undecodable bytes (C1) → returns { status: 0 } and writes NO row", async () => {
      const { mod, db } = await freshModule();
      const garbage = toArrayBuffer(Buffer.from([9, 9, 9, 9]));
      fetchScheduleTileMock.mockResolvedValue({
        status: 200,
        bytes: garbage,
        bundleHash: HASH,
      });

      const result = await mod.getDecodedTile(HASH, SIZE, COORD);

      expect("fetchResult" in result).toBe(true);
      if (!("fetchResult" in result)) throw new Error("expected a fetchResult");
      expect(result.fetchResult.status).toBe(0);
      expect(fetchScheduleTileMock).toHaveBeenCalledTimes(1);
      // Nothing cached — the corrupt tile must not poison the cache.
      expect(await db.scheduleTileCache.count()).toBe(0);
    });

    it("LRU bump on hit (C2) → bumps loadedAt to ~now, no refetch", async () => {
      const { mod, db } = await freshModule();
      const key = `${HASH}/${SIZE}/${COORD}`;
      const seeded = 1000; // an OLD loadedAt
      await db.scheduleTileCache.put({
        key,
        compressedBytes: makeTileBytes(),
        loadedAt: seeded,
        byteSize: makeTileBytes().byteLength,
      });
      const before = Date.now();

      const result = await mod.getDecodedTile(HASH, SIZE, COORD);

      expect("tile" in result).toBe(true);
      expect(fetchScheduleTileMock).not.toHaveBeenCalled();
      const row = await db.scheduleTileCache.get(key);
      expect(row?.loadedAt).toBeGreaterThan(seeded);
      expect(row?.loadedAt).toBeGreaterThanOrEqual(before);
    });

    it("LRU bump drives eviction (C2): a hit on the older row evicts the now-older other row", async () => {
      const { mod, db } = await freshModule();
      const bytesA = makeTileBytes();
      const bytesB = makeTileBytes();
      const keyA = `${HASH}/${SIZE}/1_1`;
      const keyB = `${HASH}/${SIZE}/1_2`;
      // A inserted older, B newer.
      await db.scheduleTileCache.put({ key: keyA, compressedBytes: bytesA, loadedAt: 100, byteSize: bytesA.byteLength });
      await db.scheduleTileCache.put({ key: keyB, compressedBytes: bytesB, loadedAt: 200, byteSize: bytesB.byteLength });

      // HIT A → its loadedAt is bumped above B's, making B the coldest.
      await mod.getDecodedTile(HASH, SIZE, "1_1");

      // Budget below the sum of both → evict the coldest, which is now B.
      await mod.ensureUnderBudget(bytesA.byteLength);

      const remaining = (await db.scheduleTileCache.toArray()).map((r) => r.key);
      expect(remaining).toEqual([keyA]);
    });
  });

  it("shares one fetch/decode across concurrent foreground and prewarm readers", async () => {
    const {mod, db} = await freshModule();
    const decoder = await import("./brotliDecode.ts");
    const decode = vi.spyOn(decoder, "decompressBrotli");
    let finish!: (result: FetchScheduleTileResult) => void;
    fetchScheduleTileMock.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const firstStart = vi.fn();
    const secondStart = vi.fn();
    const first = mod.getDecodedTile(HASH, SIZE, COORD, {prewarm: true, onTileDownloadStart: firstStart});
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledOnce());
    const second = mod.getDecodedTile(HASH, SIZE, COORD, {onTileDownloadStart: secondStart});
    expect(secondStart).toHaveBeenCalledOnce();
    const bytes = makeTileBytes();
    finish({status: 200, bytes, bundleHash: HASH});
    const [a, b] = await Promise.all([first, second]);
    expect(fetchScheduleTileMock).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect("tile" in a && "tile" in b && a.tile === b.tile).toBe(true);
    expect("tile" in a && a.bytesDownloaded).toBe(bytes.byteLength);
    expect("tile" in b && b.bytesDownloaded).toBe(0);
    expect((await db.scheduleTileCache.get(`${HASH}/${SIZE}/${COORD}`))!.loadedAt).toBeGreaterThan(0);
    decode.mockRestore();
  });

  it("releases a failed shared request so the next read can retry", async () => {
    const {mod} = await freshModule();
    fetchScheduleTileMock.mockRejectedValueOnce(new Error("network"));
    const result = await Promise.allSettled([
      mod.getDecodedTile(HASH, SIZE, COORD), mod.getDecodedTile(HASH, SIZE, COORD),
    ]);
    expect(result.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(fetchScheduleTileMock).toHaveBeenCalledOnce();
    fetchScheduleTileMock.mockResolvedValue({status: 200, bytes: makeTileBytes(), bundleHash: HASH});
    expect("tile" in await mod.getDecodedTile(HASH, SIZE, COORD)).toBe(true);
    expect(fetchScheduleTileMock).toHaveBeenCalledTimes(2);
  });

  it("shares cached decompression without reporting a network download", async () => {
    const {mod, db} = await freshModule();
    const decoder = await import("./brotliDecode.ts");
    const decode = vi.spyOn(decoder, "decompressBrotli");
    const bytes = makeTileBytes();
    await db.scheduleTileCache.put({key: `${HASH}/${SIZE}/${COORD}`, compressedBytes: bytes, loadedAt: 0, byteSize: bytes.byteLength});
    const starts = vi.fn();
    const results = await Promise.all(Array.from({length: 8}, () => mod.getDecodedTile(HASH, SIZE, COORD, {onTileDownloadStart: starts})));
    expect(decode).toHaveBeenCalledOnce();
    expect(starts).not.toHaveBeenCalled();
    expect(fetchScheduleTileMock).not.toHaveBeenCalled();
    expect(results.every(r => "tile" in r && r.bytesDownloaded === 0)).toBe(true);
    decode.mockRestore();
  });

  describe("pruneToBundleHash", () => {
    it("deletes only rows whose key prefix is not `${bundleHash}/`", async () => {
      const { mod, db } = await freshModule();
      await db.scheduleTileCache.bulkPut([
        { key: `${HASH}/${SIZE}/1_1`, compressedBytes: new ArrayBuffer(8), loadedAt: 1, byteSize: 8 },
        { key: `${HASH}/${SIZE}/1_2`, compressedBytes: new ArrayBuffer(8), loadedAt: 2, byteSize: 8 },
        { key: `${OTHER}/${SIZE}/1_1`, compressedBytes: new ArrayBuffer(8), loadedAt: 3, byteSize: 8 },
        { key: `${OTHER}/${SIZE}/9_9`, compressedBytes: new ArrayBuffer(8), loadedAt: 4, byteSize: 8 },
      ]);

      await mod.pruneToBundleHash(HASH);

      const remaining = (await db.scheduleTileCache.toArray()).map((r) => r.key).sort();
      expect(remaining).toEqual([`${HASH}/${SIZE}/1_1`, `${HASH}/${SIZE}/1_2`]);
    });
  });

  it("bundle rollover only removes the superseded bundle and preserves other cities", async () => {
    const { mod, db } = await freshModule();
    await db.scheduleTileCache.bulkPut(["old-city-a", "new-city-a", "city-b"].map(hash => ({
      key: `${hash}/${SIZE}/1_1`, compressedBytes: new ArrayBuffer(8), loadedAt: 1, byteSize: 8,
    })));
    await mod.pruneToBundleHash("new-city-a", "old-city-a");
    expect((await db.scheduleTileCache.toArray()).map(row => row.key).sort()).toEqual([
      `city-b/${SIZE}/1_1`, `new-city-a/${SIZE}/1_1`,
    ]);
  });

  describe("ensureUnderBudget", () => {
    it("evicts oldest-by-loadedAt rows until total byteSize is under budget", async () => {
      const { mod, db } = await freshModule();
      await db.scheduleTileCache.bulkPut([
        { key: "k/old1", compressedBytes: new ArrayBuffer(100), loadedAt: 10, byteSize: 100 },
        { key: "k/old2", compressedBytes: new ArrayBuffer(100), loadedAt: 20, byteSize: 100 },
        { key: "k/new", compressedBytes: new ArrayBuffer(100), loadedAt: 30, byteSize: 100 },
      ]);

      // Budget 150 < 300 total → drop oldest until ≤ 150 (drops old1, then old2).
      await mod.ensureUnderBudget(150);

      const remaining = (await db.scheduleTileCache.toArray()).map((r) => r.key);
      expect(remaining).toEqual(["k/new"]);
    });

    it("is a no-op when already under budget", async () => {
      const { mod, db } = await freshModule();
      await db.scheduleTileCache.bulkPut([
        { key: "k/a", compressedBytes: new ArrayBuffer(50), loadedAt: 1, byteSize: 50 },
        { key: "k/b", compressedBytes: new ArrayBuffer(50), loadedAt: 2, byteSize: 50 },
      ]);

      await mod.ensureUnderBudget(1000);

      expect(await db.scheduleTileCache.count()).toBe(2);
    });

    it("full-table scan runs ONCE per session (F6): later calls use the running total", async () => {
      const { mod, db } = await freshModule();
      await db.scheduleTileCache.bulkPut([
        { key: "k/a", compressedBytes: new ArrayBuffer(50), loadedAt: 1, byteSize: 50 },
        { key: "k/b", compressedBytes: new ArrayBuffer(50), loadedAt: 2, byteSize: 50 },
      ]);
      const eachSpy = vi.spyOn(db.scheduleTileCache, "each");

      await mod.ensureUnderBudget(1000); // cold call — seeds the total
      expect(eachSpy).toHaveBeenCalledTimes(1);

      await mod.ensureUnderBudget(1000); // warm call — pure in-memory compare
      await mod.ensureUnderBudget(1000);
      expect(eachSpy).toHaveBeenCalledTimes(1);
      eachSpy.mockRestore();
    });

    it("running total tracks writes made through getDecodedTile (F6)", async () => {
      const { mod, db } = await freshModule();
      // Seed the total while empty, then write two tiles through the real path.
      await mod.ensureUnderBudget(1_000_000);
      const bytesA = makeTileBytes();
      const bytesB = makeTileBytes();
      fetchScheduleTileMock
        .mockResolvedValueOnce({ status: 200, bytes: bytesA })
        .mockResolvedValueOnce({ status: 200, bytes: bytesB });
      await mod.getDecodedTile(HASH, "6000", "1_1");
      await mod.getDecodedTile(HASH, "6000", "1_2");
      expect(await db.scheduleTileCache.count()).toBe(2);

      const eachSpy = vi.spyOn(db.scheduleTileCache, "each");
      // Budget below one tile: the RUNNING total (not a re-scan) must trigger
      // eviction of the older row.
      await mod.ensureUnderBudget(bytesB.byteLength);
      expect(eachSpy).not.toHaveBeenCalled();
      eachSpy.mockRestore();
      const remaining = (await db.scheduleTileCache.toArray()).map((r) => r.key);
      expect(remaining).toEqual([`${HASH}/6000/1_2`]);
    });

    it("noteTileCacheCleared zeroes the running total after a wipe (F6)", async () => {
      const { mod, db } = await freshModule();
      await db.scheduleTileCache.bulkPut([
        { key: "k/a", compressedBytes: new ArrayBuffer(500), loadedAt: 1, byteSize: 500 },
      ]);
      await mod.ensureUnderBudget(1000); // seeds total = 500

      await db.scheduleTileCache.clear();
      mod.noteTileCacheCleared();

      // Under the stale total (500 > 100) this would try to evict from an
      // empty table; with the zeroed total it's a clean no-op.
      const eachSpy = vi.spyOn(db.scheduleTileCache, "each");
      const orderBySpy = vi.spyOn(db.scheduleTileCache, "orderBy");
      await mod.ensureUnderBudget(100);
      expect(eachSpy).not.toHaveBeenCalled();
      expect(orderBySpy).not.toHaveBeenCalled();
      eachSpy.mockRestore();
      orderBySpy.mockRestore();
    });
  });

  describe("cross-bucket eviction watchdog (notifyWriteGrew)", () => {
    it("fires once on a fresh write (miss → 200 → put)", async () => {
      const { mod } = await freshModule();
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes(), bundleHash: HASH });
      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1);
    });

    it("fires on the poison-pill self-heal refetch (delete → fetch → put)", async () => {
      const { mod, db } = await freshModule();
      const key = `${HASH}/${SIZE}/${COORD}`;
      const garbage = toArrayBuffer(Buffer.from([1, 2, 3, 4]));
      await db.scheduleTileCache.put({ key, compressedBytes: garbage, loadedAt: 1, byteSize: garbage.byteLength });
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes(), bundleHash: HASH });
      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire on an IndexedDB hit (pre-seeded decodable row)", async () => {
      const { mod, db } = await freshModule();
      const key = `${HASH}/${SIZE}/${COORD}`;
      await db.scheduleTileCache.put({ key, compressedBytes: makeTileBytes(), loadedAt: 1, byteSize: makeTileBytes().byteLength });
      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).not.toHaveBeenCalled();
    });

    it("does NOT fire on a memo hit (second call, same key)", async () => {
      const { mod } = await freshModule();
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes(), bundleHash: HASH });
      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1);
      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire on a non-200 fetch", async () => {
      const { mod } = await freshModule();
      fetchScheduleTileMock.mockResolvedValue({ status: 409, bundleHash: HASH });
      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).not.toHaveBeenCalled();
    });

    it("does NOT fire on an undecodable fresh 200", async () => {
      const { mod } = await freshModule();
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: toArrayBuffer(Buffer.from([9, 9, 9, 9])), bundleHash: HASH });
      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).not.toHaveBeenCalled();
    });

    it("does NOT await the watchdog — a pending notifyWriteGrew never blocks the tile return", async () => {
      const { mod } = await freshModule();
      notifyWriteGrewMock.mockReturnValue(new Promise<never>(() => {}));
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes(), bundleHash: HASH });
      const result = await mod.getDecodedTile(HASH, SIZE, COORD);
      expect("tile" in result).toBe(true);
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent writes (leading) and fires exactly one trailing re-run after settle", async () => {
      const { mod } = await freshModule();
      let release: () => void = () => {};
      notifyWriteGrewMock.mockImplementation(
        () => new Promise<unknown>((res) => { release = () => res([]); }),
      );
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes(), bundleHash: HASH });

      // Two concurrent writes: the first fires the watchdog (leading); the second lands
      // while it is in flight and is coalesced (pending), not dropped.
      await Promise.all([
        mod.getDecodedTile(HASH, SIZE, "1_1"),
        mod.getDecodedTile(HASH, SIZE, "1_2"),
      ]);
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1); // leading only

      // Settle the in-flight watchdog → the coalesced write triggers ONE trailing re-run
      // (no new write needed) so mid-flight growth is never missed.
      release();
      await new Promise((r) => setTimeout(r, 0));
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(2);

      // Settle the trailing run → nothing pending → no further runs (no infinite drain).
      release();
      await new Promise((r) => setTimeout(r, 0));
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(2);
    });

    it("a single write fires the watchdog exactly once (no spurious trailing re-run)", async () => {
      const { mod } = await freshModule();
      let release: () => void = () => {};
      notifyWriteGrewMock.mockImplementation(
        () => new Promise<unknown>((res) => { release = () => res([]); }),
      );
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes(), bundleHash: HASH });

      await mod.getDecodedTile(HASH, SIZE, COORD);
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1);

      release();
      await new Promise((r) => setTimeout(r, 0));
      // Nothing was coalesced, so settling must NOT trigger a trailing re-run.
      expect(notifyWriteGrewMock).toHaveBeenCalledTimes(1);
    });

    it("returns the in-memory tile even when the watchdog evicts the just-written row", async () => {
      const { mod, db } = await freshModule();
      notifyWriteGrewMock.mockImplementation(async () => {
        await db.scheduleTileCache.clear();
        return [];
      });
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes(), bundleHash: HASH });
      const result = await mod.getDecodedTile(HASH, SIZE, COORD);
      expect("tile" in result).toBe(true);
      if (!("tile" in result)) throw new Error("expected a tile");
      expect(result.tile.bundleHash).toBe(HASH);
      await new Promise((r) => setTimeout(r, 0));
      expect(await db.scheduleTileCache.count()).toBe(0);
    });
  });

  describe("in-memory decoded-tile memo (J9)", () => {
    it("two getDecodedTile calls for the same key decompress only ONCE (memo hit skips brotli+parse)", async () => {
      // Use freshModule to get an isolated module instance with a clean memo.
      vi.resetModules();
      // Re-register the brotliDecode mock with a spy so we can count calls.
      const decompressSpy = vi.fn<(buf: ArrayBuffer) => Promise<string>>(
        (buf: ArrayBuffer): Promise<string> =>
          Promise.resolve(brotliDecompressSync(Buffer.from(buf)).toString("utf8")),
      );
      vi.doMock("./brotliDecode.ts", () => ({ decompressBrotli: decompressSpy }));
      vi.doMock("./api.ts", async (importActual) => {
        const actual = await importActual<typeof import("./api.ts")>();
        return { ...actual, fetchScheduleTile: fetchScheduleTileMock };
      });

      await Dexie.delete("ptn");
      const dbMod = await import("../db/index.ts");
      await dbMod.db.open();
      const mod = await import("./scheduleTileCache.ts");

      const tileBytes = makeTileBytes();
      fetchScheduleTileMock.mockResolvedValue({
        status: 200,
        bytes: tileBytes,
        bundleHash: HASH,
      });

      // First call: MISS → fetch → decompress (1 call) → memo-populate
      const first = await mod.getDecodedTile(HASH, SIZE, COORD);
      expect("tile" in first).toBe(true);
      expect(decompressSpy).toHaveBeenCalledTimes(1);

      // Second call: memo HIT → skip brotli; decompress still called only once total
      const second = await mod.getDecodedTile(HASH, SIZE, COORD);
      expect("tile" in second).toBe(true);
      if (!("tile" in second)) throw new Error("expected tile");
      expect(second.tile.bundleHash).toBe(HASH);
      // No additional decompressBrotli call — memo served the result.
      expect(decompressSpy).toHaveBeenCalledTimes(1);

      // fetchScheduleTile also called only once (the IDB cache + memo prevented refetching)
      expect(fetchScheduleTileMock).toHaveBeenCalledTimes(1);

      dbMod.db.close();
      await Dexie.delete("ptn");
      vi.resetModules();
    });

    it("different keys use independent memo slots (cross-key isolation)", async () => {
      vi.resetModules();
      const decompressSpy = vi.fn<(buf: ArrayBuffer) => Promise<string>>(
        (buf: ArrayBuffer): Promise<string> =>
          Promise.resolve(brotliDecompressSync(Buffer.from(buf)).toString("utf8")),
      );
      vi.doMock("./brotliDecode.ts", () => ({ decompressBrotli: decompressSpy }));
      vi.doMock("./api.ts", async (importActual) => {
        const actual = await importActual<typeof import("./api.ts")>();
        return { ...actual, fetchScheduleTile: fetchScheduleTileMock };
      });

      await Dexie.delete("ptn");
      const dbMod = await import("../db/index.ts");
      await dbMod.db.open();
      const mod = await import("./scheduleTileCache.ts");

      const tileBytes = makeTileBytes();
      fetchScheduleTileMock.mockResolvedValue({
        status: 200,
        bytes: tileBytes,
        bundleHash: HASH,
      });

      // Fetch two different coords — each is a memo miss → 2 decompress calls total.
      await mod.getDecodedTile(HASH, SIZE, "1_1");
      await mod.getDecodedTile(HASH, SIZE, "1_2");
      expect(decompressSpy).toHaveBeenCalledTimes(2);

      // Second round for same two coords — both memo hits → no new calls.
      await mod.getDecodedTile(HASH, SIZE, "1_1");
      await mod.getDecodedTile(HASH, SIZE, "1_2");
      expect(decompressSpy).toHaveBeenCalledTimes(2);

      dbMod.db.close();
      await Dexie.delete("ptn");
      vi.resetModules();
    });
  });

  describe("onTileDownloadStart / prewarm / bytesDownloaded", () => {
    it("fires onTileDownloadStart exactly once on a cache-miss network fetch", async () => {
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes() });
      const { mod } = await freshModule();
      const onDl = vi.fn();
      await mod.getDecodedTile(HASH, SIZE, "9_9", { onTileDownloadStart: onDl });
      expect(onDl).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire onTileDownloadStart on a memo hit, and returns bytesDownloaded:0", async () => {
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes() });
      const { mod } = await freshModule();
      const first = await mod.getDecodedTile(HASH, SIZE, "8_8");
      expect("tile" in first && first.bytesDownloaded! > 0).toBe(true);
      const onDl = vi.fn();
      const hit = await mod.getDecodedTile(HASH, SIZE, "8_8", { onTileDownloadStart: onDl });
      expect(onDl).not.toHaveBeenCalled();
      expect("tile" in hit && hit.bytesDownloaded).toBe(0);
    });

    it("prewarm:true does not promote loadedAt (stays evictable)", async () => {
      fetchScheduleTileMock.mockResolvedValue({ status: 200, bytes: makeTileBytes() });
      const { mod, db } = await freshModule();
      await mod.getDecodedTile(HASH, SIZE, "7_7", { prewarm: true });
      const row = await db.scheduleTileCache.get(`${HASH}/${SIZE}/7_7`);
      expect(row?.loadedAt).toBe(0);
    });
  });
});
