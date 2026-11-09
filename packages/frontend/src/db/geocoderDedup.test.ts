import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { GeocoderProviderId } from "@pt/shared";
import type { GeocoderDedupRecord } from "./index.ts";

function makeEntry(
  i: number,
  overrides?: Partial<GeocoderDedupRecord>,
): GeocoderDedupRecord {
  const iv = new ArrayBuffer(12);
  new Uint8Array(iv).set([i & 0xff]);
  const ct = new ArrayBuffer(32);
  new Uint8Array(ct).set([i & 0xff, (i >> 8) & 0xff]);
  return {
    queryHash: `hash-${String(i).padStart(4, "0")}`,
    ct,
    iv,
    createdAt: 1_000 + i * 100,
    providerId: "third-party-nominatim",
    gridMeters: 500,
    ...overrides,
  };
}

describe("geocoderDedup table", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  afterEach(async () => {
    const mod = await import("./index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("opens with the geocoderDedup table present", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(8);
    expect(db.geocoderDedup).toBeDefined();
    expect(await db.geocoderDedup.count()).toBe(0);
  });

  it("inserts 10 entries and reads them back by queryHash", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(i));
    await db.geocoderDedup.bulkPut(entries);
    expect(await db.geocoderDedup.count()).toBe(10);

    for (const entry of entries) {
      const back = await db.geocoderDedup.get(entry.queryHash);
      expect(back).toBeDefined();
      if (!back) continue;
      expect(back.queryHash).toBe(entry.queryHash);
      expect(back.createdAt).toBe(entry.createdAt);
      expect(back.providerId).toBe(entry.providerId);
      expect(back.gridMeters).toBe(entry.gridMeters);
      expect(back.iv.byteLength).toBe(12);
      expect(back.ct.byteLength).toBe(32);
    }
  });

  it("lists entries for TTL sweep via [providerId+createdAt] index", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.geocoderDedup.bulkPut([
      makeEntry(1, {
        providerId: "third-party-nominatim",
        createdAt: 100,
      }),
      makeEntry(2, {
        providerId: "third-party-nominatim",
        createdAt: 200,
      }),
      makeEntry(3, {
        providerId: "third-party-nominatim",
        createdAt: 500,
      }),
      makeEntry(4, {
        providerId: "third-party-mapbox",
        createdAt: 150,
      }),
    ]);

    const nominatimBefore300 = await db.geocoderDedup
      .where("[providerId+createdAt]")
      .between(
        ["third-party-nominatim", -Infinity],
        ["third-party-nominatim", 300],
      )
      .toArray();

    expect(nominatimBefore300).toHaveLength(2);
    expect(nominatimBefore300.map((r) => r.queryHash).sort()).toEqual([
      "hash-0001",
      "hash-0002",
    ]);
  });

  it("deletes expired rows via index-ranged delete without decrypting", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.geocoderDedup.bulkPut([
      makeEntry(1, {
        providerId: "third-party-nominatim",
        createdAt: 100,
      }),
      makeEntry(2, {
        providerId: "third-party-nominatim",
        createdAt: 200,
      }),
      makeEntry(3, {
        providerId: "third-party-nominatim",
        createdAt: 900,
      }),
    ]);
    const cutoff = 500;
    const removed = await db.geocoderDedup
      .where("[providerId+createdAt]")
      .between(
        ["third-party-nominatim", -Infinity],
        ["third-party-nominatim", cutoff],
      )
      .delete();
    expect(removed).toBe(2);
    const remaining = await db.geocoderDedup.toArray();
    expect(remaining.map((r) => r.queryHash)).toEqual(["hash-0003"]);
  });

  it("separates rows by providerId so mapbox sweep leaves nominatim untouched", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const providers: GeocoderProviderId[] = [
      "third-party-mapbox",
      "third-party-nominatim",
      "third-party-photon",
    ];
    const rows = providers.map((p, i) =>
      makeEntry(i, { providerId: p, createdAt: 100 }),
    );
    await db.geocoderDedup.bulkPut(rows);

    const removed = await db.geocoderDedup
      .where("[providerId+createdAt]")
      .between(
        ["third-party-mapbox", -Infinity],
        ["third-party-mapbox", Infinity],
      )
      .delete();
    expect(removed).toBe(1);
    const remaining = await db.geocoderDedup.toArray();
    expect(remaining.map((r) => r.providerId).sort()).toEqual([
      "third-party-nominatim",
      "third-party-photon",
    ]);
  });
});
