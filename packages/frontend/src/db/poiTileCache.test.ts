import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { PoiTileCacheRecord } from "./index.ts";

function makeTile(
  i: number,
  overrides?: Partial<PoiTileCacheRecord>,
): PoiTileCacheRecord {
  const size = 1024 * (i + 1);
  const buf = new ArrayBuffer(size);
  // Stamp a byte so two tiles don't share identity after structured clone.
  new Uint8Array(buf)[0] = i & 0xff;
  return {
    tileKey: `gdansk/12km/${i}_0`,
    compressedBytes: buf,
    loadedAt: 1_000_000 + i * 1000,
    byteSize: size,
    cityId: "gdansk",
    bundleSha256: "b".repeat(64),
    generationId: "g".repeat(64),
    ...overrides,
  };
}

describe("poiTileCache table", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  afterEach(async () => {
    const mod = await import("./index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("opens with poiTileCache present", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(8);
    expect(db.poiTileCache).toBeDefined();
    expect(await db.poiTileCache.count()).toBe(0);
  });

  it("inserts, reads, and deletes tile rows by tileKey", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const tile = makeTile(0);
    await db.poiTileCache.put(tile);

    const back = await db.poiTileCache.get(tile.tileKey);
    expect(back).toBeDefined();
    expect(back?.byteSize).toBe(tile.byteSize);
    expect(back?.loadedAt).toBe(tile.loadedAt);
    expect(back?.compressedBytes.byteLength).toBe(tile.byteSize);

    await db.poiTileCache.delete(tile.tileKey);
    expect(await db.poiTileCache.get(tile.tileKey)).toBeUndefined();
  });

  it("upsert replaces on same tileKey", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.poiTileCache.put(makeTile(0, { byteSize: 100 }));
    await db.poiTileCache.put(
      makeTile(0, { byteSize: 200, loadedAt: 2_000_000 }),
    );
    expect(await db.poiTileCache.count()).toBe(1);
    const back = await db.poiTileCache.get("gdansk/12km/0_0");
    expect(back?.byteSize).toBe(200);
    expect(back?.loadedAt).toBe(2_000_000);
  });

  it("sums byteSize across all rows", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const tiles = Array.from({ length: 5 }, (_, i) => makeTile(i));
    await db.poiTileCache.bulkPut(tiles);

    let total = 0;
    await db.poiTileCache.each((r) => {
      total += r.byteSize;
    });
    const expected = tiles.reduce((a, t) => a + t.byteSize, 0);
    expect(total).toBe(expected);
  });

  it("queries oldest-N rows by loadedAt index", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const tiles = [
      makeTile(0, { tileKey: "gdansk/12km/a", loadedAt: 500 }),
      makeTile(1, { tileKey: "gdansk/12km/b", loadedAt: 100 }),
      makeTile(2, { tileKey: "gdansk/12km/c", loadedAt: 300 }),
      makeTile(3, { tileKey: "gdansk/12km/d", loadedAt: 900 }),
      makeTile(4, { tileKey: "gdansk/12km/e", loadedAt: 200 }),
    ];
    await db.poiTileCache.bulkPut(tiles);

    const oldest3 = await db.poiTileCache
      .orderBy("loadedAt")
      .limit(3)
      .toArray();
    expect(oldest3.map((r) => r.tileKey)).toEqual([
      "gdansk/12km/b",
      "gdansk/12km/e",
      "gdansk/12km/c",
    ]);
    expect(oldest3.map((r) => r.loadedAt)).toEqual([100, 200, 300]);
  });

  it("bulk deletes by tileKey list", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const tiles = Array.from({ length: 4 }, (_, i) => makeTile(i));
    await db.poiTileCache.bulkPut(tiles);
    expect(await db.poiTileCache.count()).toBe(4);

    await db.poiTileCache.bulkDelete([
      "gdansk/12km/0_0",
      "gdansk/12km/2_0",
    ]);
    const remaining = (await db.poiTileCache.toArray()).map((r) => r.tileKey);
    expect(remaining.sort()).toEqual([
      "gdansk/12km/1_0",
      "gdansk/12km/3_0",
    ]);
  });
});
