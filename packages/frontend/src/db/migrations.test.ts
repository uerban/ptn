import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";

describe("IndexedDB schema", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  it("creates a fresh DB at version 3 with every declared table", async () => {
    const { db, STORES } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(3);
    expect(db.tables.map((t) => t.name).sort()).toEqual(Object.keys(STORES).sort());
    db.close();
  });

  it("opens a DB left at a higher version with the same schema, keeping its rows", async () => {
    const current = await import("./index.ts");
    current.db.close();
    const newer = new Dexie("ptn");
    newer.version(20).stores(current.STORES);
    await newer.open();
    await newer.table("savedLocations").put({ id: "home", savedAt: 1 });
    newer.close();

    await current.db.open();
    expect(await current.db.savedLocations.get("home")).toMatchObject({ savedAt: 1 });
    current.db.close();
  });

  it("adds missing tables to a DB created with an older, smaller schema", async () => {
    const current = await import("./index.ts");
    current.db.close();
    const older = new Dexie("ptn");
    older.version(3).stores({
      stops: "id, lastSeen",
      usageStats: "stopId, lastTapped",
    });
    await older.open();
    await older.table("usageStats").put({ stopId: "s1", lastTapped: 5 });
    older.close();

    await current.db.open();
    expect(current.db.tables.map((t) => t.name).sort()).toEqual(
      Object.keys(current.STORES).sort(),
    );
    expect(await current.db.usageStats.get("s1")).toMatchObject({ lastTapped: 5 });
    current.db.close();
  });

  it("drops the plaintext time indexes of personal tables, keeping their rows", async () => {
    const current = await import("./index.ts");
    current.db.close();
    // Version 2 schema: personal tables indexed their timestamps.
    const v2 = new Dexie("ptn");
    v2.version(20).stores({
      ...current.STORES,
      usageStats: "stopId, lastTapped",
      recentLocations: "id, usedAt",
      savedLocations: "id, savedAt",
      personalUsage: null,
    });
    await v2.open();
    await v2.table("savedLocations").put({ id: "s1", savedAt: 7, alias: "Home" });
    await v2.table("recentLocations").put({ id: "r1", usedAt: 9 });
    await v2.table("usageStats").put({ stopId: "a", lastTapped: 3, tapCount: 1 });
    v2.close();

    await current.db.open();
    expect(current.db.verno).toBe(3);
    for (const name of ["savedLocations", "recentLocations", "usageStats", "personalUsage"]) {
      expect(current.db.table(name).schema.indexes).toEqual([]);
    }
    // Rows survive for the encrypted-storage migration to convert.
    expect(await current.db.savedLocations.count()).toBe(1);
    expect(await current.db.recentLocations.count()).toBe(1);
    expect(await current.db.usageStats.count()).toBe(1);
    current.db.close();
  });

  it("ensureDbReady opens a healthy DB without recovery", async () => {
    const { ensureDbReady } = await import("./migrationRunner.ts");
    const result = await ensureDbReady();
    expect(result.recovered).toBe(false);
  });
});
