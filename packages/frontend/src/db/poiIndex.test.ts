import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { PoiIndexRecord, PoiSyncMetaRecord } from "./index.ts";

function makeEntry(
  i: number,
  overrides?: Partial<PoiIndexRecord>,
): PoiIndexRecord {
  return {
    id: `poi-${i}`,
    cityId: "gdansk",
    name: `Place ${String(i).padStart(4, "0")}`,
    geoBucket: `54_${18 + (i % 5)}`,
    aliases: {},
    category: "public_building",
    lat: 54.35 + i * 0.001,
    lon: 18.64 + i * 0.001,
    source: "osm",
    rankBoost: 0.3,
    tier: "strict",
    ...overrides,
  };
}

describe("poiIndex + poiSyncMeta tables", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  afterEach(async () => {
    const mod = await import("./index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("opens with both tables present", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(2);
    expect(db.poiIndex).toBeDefined();
    expect(db.poiSyncMeta).toBeDefined();
    expect(await db.poiIndex.count()).toBe(0);
    expect(await db.poiSyncMeta.count()).toBe(0);
  });

  it("bulk-inserts 1000 entries", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const entries = Array.from({ length: 1000 }, (_, i) => makeEntry(i));
    await db.poiIndex.bulkPut(entries);
    expect(await db.poiIndex.count()).toBe(1000);
  });

  it("prefix-queries by [cityId+name] compound index", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.poiIndex.bulkPut([
      makeEntry(1, { name: "Dworzec Glowny", cityId: "gdansk" }),
      makeEntry(2, { name: "Dworzec PKP", cityId: "gdansk" }),
      makeEntry(3, { name: "Biblioteka", cityId: "gdansk" }),
      makeEntry(4, { name: "Dworzec Autobusowy", cityId: "vilnius" }),
    ]);

    const results = await db.poiIndex
      .where("[cityId+name]")
      .between(["gdansk", "Dworz"], ["gdansk", "Dworz\uffff"])
      .toArray();

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name).sort()).toEqual([
      "Dworzec Glowny",
      "Dworzec PKP",
    ]);
  });

  it("prefix-query does not leak across cities", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.poiIndex.bulkPut([
      makeEntry(1, { name: "Ratusz", cityId: "gdansk" }),
      makeEntry(2, { name: "Ratusz", cityId: "vilnius" }),
    ]);

    const gdansk = await db.poiIndex
      .where("[cityId+name]")
      .between(["gdansk", "Rat"], ["gdansk", "Rat\uffff"])
      .toArray();
    expect(gdansk).toHaveLength(1);
    expect(gdansk[0]!.cityId).toBe("gdansk");

    const vilnius = await db.poiIndex
      .where("[cityId+name]")
      .between(["vilnius", "Rat"], ["vilnius", "Rat\uffff"])
      .toArray();
    expect(vilnius).toHaveLength(1);
    expect(vilnius[0]!.cityId).toBe("vilnius");
  });

  it("spatial-bucket query by [cityId+geoBucket]", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.poiIndex.bulkPut([
      makeEntry(1, { geoBucket: "54_18", cityId: "gdansk" }),
      makeEntry(2, { geoBucket: "54_18", cityId: "gdansk" }),
      makeEntry(3, { geoBucket: "54_19", cityId: "gdansk" }),
      makeEntry(4, { geoBucket: "54_18", cityId: "vilnius" }),
    ]);

    const results = await db.poiIndex
      .where("[cityId+geoBucket]")
      .equals(["gdansk", "54_18"])
      .toArray();
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.geoBucket === "54_18")).toBe(true);
    expect(results.every((r) => r.cityId === "gdansk")).toBe(true);
  });

  it("poiSyncMeta stores and retrieves per-city metadata", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const meta: PoiSyncMetaRecord = {
      cityId: "gdansk",
      activeBundleHash: "abc123",
      entryCount: 500,
      installedAt: Date.now(),
      tier: "strict",
    };
    await db.poiSyncMeta.put(meta);

    const back = await db.poiSyncMeta.get("gdansk");
    expect(back).toEqual(meta);
  });

  it("poiSyncMeta upsert replaces on same cityId", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.poiSyncMeta.put({
      cityId: "gdansk",
      activeBundleHash: "v1",
      entryCount: 100,
      installedAt: 1000,
      tier: "strict",
    });
    await db.poiSyncMeta.put({
      cityId: "gdansk",
      activeBundleHash: "v2",
      entryCount: 200,
      installedAt: 2000,
      tier: "strict",
    });
    expect(await db.poiSyncMeta.count()).toBe(1);
    const back = await db.poiSyncMeta.get("gdansk");
    expect(back?.activeBundleHash).toBe("v2");
    expect(back?.entryCount).toBe(200);
  });

  it("clearing poiIndex for a city preserves other cities", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.poiIndex.bulkPut([
      makeEntry(1, { cityId: "gdansk" }),
      makeEntry(2, { cityId: "gdansk" }),
      makeEntry(3, { cityId: "vilnius" }),
    ]);
    expect(await db.poiIndex.count()).toBe(3);

    await db.poiIndex.where("cityId").equals("gdansk").delete();
    expect(await db.poiIndex.count()).toBe(1);
    const remaining = await db.poiIndex.toArray();
    expect(remaining[0]!.cityId).toBe("vilnius");
  });

  it("1000-entry prefix query returns correct subset", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const entries = Array.from({ length: 1000 }, (_, i) => makeEntry(i));
    entries[500] = makeEntry(500, { name: "Dworzec Centralny" });
    entries[501] = makeEntry(501, { name: "Dworzec PKP" });
    entries[502] = makeEntry(502, { name: "Dworzec Morski" });
    await db.poiIndex.bulkPut(entries);

    const results = await db.poiIndex
      .where("[cityId+name]")
      .between(["gdansk", "Dworzec"], ["gdansk", "Dworzec\uffff"])
      .toArray();
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name).sort()).toEqual([
      "Dworzec Centralny",
      "Dworzec Morski",
      "Dworzec PKP",
    ]);
  });
});
