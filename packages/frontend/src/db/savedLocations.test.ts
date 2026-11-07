import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import type { BaseEndpoint } from "@pt/shared";
import { decrypt, encrypt } from "../services/cryptoBox.ts";
import type { SealedPersonalRow } from "./index.ts";

const endpoint: BaseEndpoint = {
  kind: "geocoded",
  lat: 54.40321,
  lon: 18.61234,
  label: "Długa 21 Clinic",
  provider: "third-party-nominatim",
  confidence: 0.9,
};

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

describe("savedLocations table schema", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  afterEach(async () => {
    const mod = await import("./index.ts");
    mod.db.close();
    await Dexie.delete("ptn");
  });

  it("opens with the savedLocations table keyed by id and no other index", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(3);
    expect(db.savedLocations.schema.primKey.keyPath).toBe("id");
    expect(db.savedLocations.schema.indexes).toEqual([]);
    expect(await db.savedLocations.count()).toBe(0);
  });

  it("stores an opaque id and ciphertext only", async () => {
    const { db } = await import("./index.ts");
    await db.open();
    const key = await makeKey();
    const id = crypto.randomUUID();
    const row: SealedPersonalRow = {
      id,
      sealed: await encrypt({ endpoint, at: 1_700_000_123_456 }, key),
    };
    await db.savedLocations.put(row);

    const raw = (await db.savedLocations.get(id))!;
    expect(Object.keys(raw).sort()).toEqual(["id", "sealed"]);
    const text = JSON.stringify(raw) + new TextDecoder().decode(raw.sealed.ct);
    for (const leak of ["Długa 21 Clinic", "54.40321", "18.61234", "1700000123456"]) {
      expect(text).not.toContain(leak);
    }
    expect(await decrypt(raw.sealed, key)).toEqual({ endpoint, at: 1_700_000_123_456 });
  });
});
