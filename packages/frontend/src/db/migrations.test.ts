import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";

describe("IndexedDB schema", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  it("creates a fresh DB at version 1 with every declared table", async () => {
    const { db, STORES } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(1);
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

  it("ensureDbReady opens a healthy DB without recovery", async () => {
    const { ensureDbReady } = await import("./migrationRunner.ts");
    const result = await ensureDbReady();
    expect(result.recovered).toBe(false);
  });
});
