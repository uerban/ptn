import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { BaseEndpoint } from "@pt/shared";
import { encrypt, type EncryptedRecord } from "../services/cryptoBox.ts";
import type { SavedLocationRecord } from "./index.ts";

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
  stopId: "S42",
  name: "Brama Wyżynna",
  lat: 54.348,
  lon: 18.65,
};

const geocodedEndpoint: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.4,
  lon: 18.6,
  label: "Home",
  provider: "third-party-nominatim",
  confidence: 0.95,
};

describe("savedLocations table schema", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
    key = await makeKey();
  });

  afterEach(async () => {
    const mod = await import("./index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("opens with the savedLocations table present", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(2);
    expect(db.savedLocations).toBeDefined();
    expect(await db.savedLocations.count()).toBe(0);
  });

  it("inserts and reads a plaintext-tier row (encrypted: false)", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const row: SavedLocationRecord = {
      id: "saved-stop",
      endpoint: stopEndpoint,
      alias: "Old town stop",
      savedAt: 1_700_000_000_000,
      encrypted: false,
    };
    await db.savedLocations.put(row);
    const back = await db.savedLocations.get("saved-stop");
    expect(back).toEqual(row);
    if (back && "kind" in back.endpoint) {
      expect(back.endpoint.kind).toBe("stop");
    }
  });

  it("inserts and reads an encrypted-tier row (alias still plaintext)", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const sealed: EncryptedRecord = await encrypt(geocodedEndpoint, key);
    const row: SavedLocationRecord = {
      id: "saved-home",
      endpoint: sealed,
      alias: "Home",
      savedAt: 1_700_000_500_000,
      pinColor: "#ff0066",
      encrypted: true,
    };
    await db.savedLocations.put(row);
    const back = await db.savedLocations.get("saved-home");
    expect(back).toBeDefined();
    if (!back) return;
    expect(back.encrypted).toBe(true);
    expect(back.alias).toBe("Home");
    expect(back.pinColor).toBe("#ff0066");
    // Coordinates from the geocoded payload must not appear plaintext in the
    // stored shape — the endpoint side is sealed.
    expect(JSON.stringify(back.endpoint)).not.toContain("54.4");
    const stored = back.endpoint as EncryptedRecord;
    expect(stored.v).toBe(sealed.v);
    expect(stored.iv.byteLength).toBe(12);
    expect(stored.ct.byteLength).toBeGreaterThan(0);
  });

  it("supports default ordering by savedAt DESC via the savedAt index", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.savedLocations.bulkPut([
      {
        id: "first",
        endpoint: stopEndpoint,
        alias: "First",
        savedAt: 100,
        encrypted: false,
      },
      {
        id: "third",
        endpoint: stopEndpoint,
        alias: "Third",
        savedAt: 300,
        encrypted: false,
      },
      {
        id: "second",
        endpoint: stopEndpoint,
        alias: "Second",
        savedAt: 200,
        encrypted: false,
      },
    ]);
    const newest = await db.savedLocations
      .orderBy("savedAt")
      .reverse()
      .toArray();
    expect(newest.map((r) => r.id)).toEqual(["third", "second", "first"]);
  });

  it("idempotent overwrite: re-putting the same id replaces the row", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    await db.savedLocations.put({
      id: "stable",
      endpoint: stopEndpoint,
      alias: "v1",
      savedAt: 10,
      encrypted: false,
    });
    await db.savedLocations.put({
      id: "stable",
      endpoint: stopEndpoint,
      alias: "v2",
      savedAt: 20,
      encrypted: false,
    });
    expect(await db.savedLocations.count()).toBe(1);
    const back = await db.savedLocations.get("stable");
    expect(back?.alias).toBe("v2");
    expect(back?.savedAt).toBe(20);
  });

  it("mixed encrypted + plaintext rows coexist", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const sealed = await encrypt(geocodedEndpoint, key);
    await db.savedLocations.bulkPut([
      {
        id: "p",
        endpoint: stopEndpoint,
        alias: "Public stop",
        savedAt: 10,
        encrypted: false,
      },
      {
        id: "e",
        endpoint: sealed,
        alias: "Sensitive",
        savedAt: 20,
        encrypted: true,
      },
    ]);
    const all = await db.savedLocations.orderBy("savedAt").toArray();
    expect(all.map((r) => r.id)).toEqual(["p", "e"]);
    expect((all[0]!.endpoint as BaseEndpoint).kind).toBe("stop");
    expect((all[1]!.endpoint as EncryptedRecord).iv.byteLength).toBe(12);
  });
});
