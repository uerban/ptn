import { describe, it, expect, beforeEach } from "vitest";
import { db, TABLE_KIND } from "../../src/db/index.ts";
import Dexie from "dexie";

describe("db.ptbBytes", () => {
  beforeEach(async () => {
    if (db.isOpen()) await db.close();
    await Dexie.delete("ptn");
    await db.open();
  });

  it("persists PTB bytes keyed by cityId and survives a reopen", async () => {
    const bytes = new Uint8Array([0x50, 0x54, 0x42, 0x00, 1, 2, 3]);
    const now = Date.now();
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes,
      etag: '"abc123"',
      firstStoredAt: now,
      lastValidatedAt: now,
      windowDays: 90,
      horizonEndDate: "20260730",
    });
    await db.close();
    await db.open();
    const rec = await db.ptbBytes.get("vilnius");
    expect(rec).toBeDefined();
    expect(rec!.etag).toBe('"abc123"');
    expect(rec!.firstStoredAt).toBe(now);
    expect(rec!.lastValidatedAt).toBe(now);
    // Realm-safe Uint8Array check: fake-indexeddb under JSDOM structured-clones
    // into a different realm so `instanceof Uint8Array` is false even though
    // the object is semantically a Uint8Array. The brand check below matches
    // the spec's intent ("stored as Uint8Array") without coupling to a realm.
    expect(Object.prototype.toString.call(rec!.bytes)).toBe("[object Uint8Array]");
    expect(Array.from(rec!.bytes as Uint8Array)).toEqual([0x50, 0x54, 0x42, 0x00, 1, 2, 3]);
    // Window provenance (windowDays Step A.8b M5): non-indexed fields round-trip
    // through Dexie's structured clone — no version bump required.
    expect(rec!.windowDays).toBe(90);
    expect(rec!.horizonEndDate).toBe("20260730");
  });

  it("is classified as server-derived in TABLE_KIND", () => {
    expect(TABLE_KIND.ptbBytes).toBe("server-derived");
  });
});
