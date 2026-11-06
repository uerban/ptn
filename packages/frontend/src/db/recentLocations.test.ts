import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { BaseEndpoint } from "@pt/shared";
import { encrypt, type EncryptedRecord } from "../services/cryptoBox.ts";
import type { RecentLocationRecord } from "./index.ts";

let key: CryptoKey;

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const stopEndpoint: BaseEndpoint = {
  kind: "stop",
  stopId: "S1",
  name: "Central",
  lat: 54.35,
  lon: 18.65,
};

const geocodedEndpoint: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.4,
  lon: 18.6,
  label: "Długa 21",
  provider: "third-party-nominatim",
  confidence: 0.9,
};

describe("recentLocations table schema", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
    key = await makeKey();
  });

  afterEach(async () => {
    const mod = await import("./index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("opens with the recentLocations table present", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(2);
    expect(db.recentLocations).toBeDefined();
    expect(await db.recentLocations.count()).toBe(0);
  });

  it("inserts and reads a plaintext-tier row (endpoint is BaseEndpoint)", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const row: RecentLocationRecord = {
      id: "r-plain",
      endpoint: stopEndpoint,
      usedAt: 1_000,
      usedAsOrigin: true,
    };
    await db.recentLocations.put(row);
    const back = await db.recentLocations.get("r-plain");
    expect(back).toEqual(row);
    if (back) {
      expect(back.endpoint).toEqual(stopEndpoint);
      if ("kind" in back.endpoint) {
        expect(back.endpoint.kind).toBe("stop");
      }
    }
  });

  it("inserts and reads an encrypted-tier row (endpoint is EncryptedRecord)", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const sealed: EncryptedRecord = await encrypt(geocodedEndpoint, key);
    const row: RecentLocationRecord = {
      id: "r-enc",
      endpoint: sealed,
      usedAt: 2_000,
      usedAsOrigin: false,
    };
    await db.recentLocations.put(row);
    const back = await db.recentLocations.get("r-enc");
    expect(back).toBeDefined();
    if (!back) return;
    expect(back.id).toBe("r-enc");
    expect(back.usedAt).toBe(2_000);
    expect(back.usedAsOrigin).toBe(false);
    // Plaintext label must not appear in the stored shape.
    expect(JSON.stringify(back)).not.toContain("Długa");
    // The stored endpoint must match the EncryptedRecord shape.
    const stored = back.endpoint as EncryptedRecord;
    expect(stored.v).toBe(sealed.v);
    expect(stored.iv.byteLength).toBe(12);
    expect(stored.ct.byteLength).toBeGreaterThan(0);
  });

  it("supports LRU eviction via the usedAt index (orderBy + first)", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.recentLocations.bulkPut([
      { id: "a", endpoint: stopEndpoint, usedAt: 300, usedAsOrigin: false },
      { id: "b", endpoint: stopEndpoint, usedAt: 100, usedAsOrigin: false },
      { id: "c", endpoint: stopEndpoint, usedAt: 200, usedAsOrigin: false },
    ]);
    const oldest = await db.recentLocations.orderBy("usedAt").first();
    expect(oldest?.id).toBe("b");
    await db.recentLocations.delete(oldest!.id);
    expect(await db.recentLocations.get("b")).toBeUndefined();
    expect(await db.recentLocations.count()).toBe(2);
  });

  it("supports TTL sweeps via an index-ranged deletion of old rows", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.recentLocations.bulkPut([
      { id: "old-1", endpoint: stopEndpoint, usedAt: 50, usedAsOrigin: false },
      { id: "old-2", endpoint: stopEndpoint, usedAt: 75, usedAsOrigin: false },
      { id: "fresh", endpoint: stopEndpoint, usedAt: 500, usedAsOrigin: true },
    ]);
    const cutoff = 100;
    const removed = await db.recentLocations
      .where("usedAt")
      .below(cutoff)
      .delete();
    expect(removed).toBe(2);
    const remaining = await db.recentLocations.toArray();
    expect(remaining.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("mixed plaintext + encrypted rows coexist and round-trip", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const sealed = await encrypt(geocodedEndpoint, key);
    await db.recentLocations.bulkPut([
      { id: "p", endpoint: stopEndpoint, usedAt: 10, usedAsOrigin: true },
      { id: "e", endpoint: sealed, usedAt: 20, usedAsOrigin: false },
    ]);
    const all = await db.recentLocations.orderBy("usedAt").toArray();
    expect(all.map((r) => r.id)).toEqual(["p", "e"]);
    expect((all[0]!.endpoint as BaseEndpoint).kind).toBe("stop");
    expect((all[1]!.endpoint as EncryptedRecord).iv.byteLength).toBe(12);
  });
});
