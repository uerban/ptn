import { describe, it, expect, beforeEach } from "vitest";
import { db, STORES, TABLE_KIND } from "../../src/db/index.ts";
import { migrationCoordinator } from "../../src/db/migrationCoordinator.ts";

describe("ptn database", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("has stops table with id index", async () => {
    await db.stops.put({
      id: "stop_1",
      name: "Test Stop",
      location: { lat: 54.68, lon: 25.28 },
      lastSeen: Date.now(),
    });
    const stop = await db.stops.get("stop_1");
    expect(stop?.name).toBe("Test Stop");
  });

  it("has usageStats table with stopId index", async () => {
    await db.usageStats.put({
      stopId: "stop_1",
      tapCount: 5,
      lastTapped: Date.now(),
    });
    const stat = await db.usageStats.get("stop_1");
    expect(stat?.tapCount).toBe(5);
  });
});

describe("schema declaration", () => {
  it("adds downloaded-city storage in version 2 without changing the version-1 schema", () => {
    const decls = migrationCoordinator.declaredMigrations();
    expect(decls).toHaveLength(2);
    const {offlineCities, offlineTransfers, ...originalStores} = STORES;
    expect(decls[0]).toMatchObject({id: "ptn", version: 1, stores: originalStores});
    expect(decls[1]).toMatchObject({id: "offline-city-packages", version: 2, stores: {offlineCities, offlineTransfers}});
    expect(decls[0].upgrade).toBeUndefined();
  });

  it("classifies every declared table in TABLE_KIND", () => {
    expect(Object.keys(STORES).sort()).toEqual(Object.keys(TABLE_KIND).sort());
  });

  it("keys gbfsSystems by its composite key", () => {
    expect(STORES.gbfsSystems).toBe("key");
  });
});
