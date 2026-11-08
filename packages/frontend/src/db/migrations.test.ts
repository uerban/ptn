import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";

describe("IndexedDB schema", () => {
  beforeEach(async () => {
    await Dexie.delete("ptn");
  });

  it("creates a fresh DB at version 8 with every declared table", async () => {
    const { db, STORES } = await import("./index.ts");
    await db.open();
    expect(db.verno).toBe(8);
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
    expect(current.db.verno).toBe(8);
    for (const name of ["savedLocations", "recentLocations", "usageStats", "personalUsage"]) {
      expect(current.db.table(name).schema.indexes).toEqual([]);
    }
    // Rows survive for the encrypted-storage migration to convert.
    expect(await current.db.savedLocations.count()).toBe(1);
    expect(await current.db.recentLocations.count()).toBe(1);
    expect(await current.db.usageStats.count()).toBe(1);
    current.db.close();
  });

  it("upgrades a version-2 database: offline metadata filled, personal indexes absent", async () => {
    const current = await import("./index.ts");
    current.db.close();
    const v2 = new Dexie("ptn");
    v2.version(2).stores({
      ...current.STORES,
      usageStats: "stopId, lastTapped",
      recentLocations: "id, usedAt",
      savedLocations: "id, savedAt",
      personalUsage: null,
      cityUsageStats: null,
      offlineCityMetadata: null,
      cityArtifacts: null,
      cityArtifactMetadata: null,
      cityCachePointers: null,
      cityShapes: null,
      sharedArtifactMetadata: null,
    });
    await v2.open();
    await v2.table("offlineCities").put({ cityId: "riga", tables: {} });
    await v2.table("offlineTransfers").put({ hash: "t1", bytes: new Uint8Array([1]) });
    v2.close();

    await current.db.open();
    expect(current.db.verno).toBe(8);
    expect(await current.db.offlineCityMetadata.get("riga")).toEqual({ cityId: "riga", state: "legacy" });
    expect(await current.db.sharedArtifactMetadata.get("transfers:t1")).toMatchObject({ hash: "t1" });
    for (const name of ["savedLocations", "recentLocations", "usageStats", "personalUsage", "cityUsageStats"]) {
      expect(current.db.table(name).schema.indexes).toEqual([]);
    }
    current.db.close();
  });

  it("upgrades a database already at the encrypted-storage schema (version 3)", async () => {
    const current = await import("./index.ts");
    current.db.close();
    const v3 = new Dexie("ptn");
    v3.version(3).stores({
      ...current.STORES,
      cityUsageStats: null,
      offlineCityMetadata: null,
      cityArtifacts: null,
      cityArtifactMetadata: null,
      cityCachePointers: null,
      cityShapes: null,
      sharedArtifactMetadata: null,
    });
    await v3.open();
    await v3.table("offlineCities").put({ cityId: "tallinn", tables: {} });
    await v3.table("personalUsage").put({ id: "u1", sealed: { v: 1, iv: [], ct: [] } });
    await v3.table("savedLocations").put({ id: "s1", sealed: { v: 1, iv: [], ct: [] } });
    v3.close();

    await current.db.open();
    expect(current.db.verno).toBe(8);
    // Version 3 here was the encrypted-storage schema: the metadata upgrade
    // that shares its number never ran, so version 8 fills it.
    expect(await current.db.offlineCityMetadata.get("tallinn")).toEqual({ cityId: "tallinn", state: "legacy" });
    expect(await current.db.personalUsage.count()).toBe(1);
    expect(await current.db.savedLocations.count()).toBe(1);
    for (const name of ["savedLocations", "recentLocations", "usageStats", "personalUsage", "cityUsageStats"]) {
      expect(current.db.table(name).schema.indexes).toEqual([]);
    }
    current.db.close();
  });

  it("upgrades a version-7 per-city database, dropping plaintext city indexes but keeping rows", async () => {
    const current = await import("./index.ts");
    current.db.close();
    const v7 = new Dexie("ptn");
    v7.version(7).stores({
      ...current.STORES,
      usageStats: "stopId, lastTapped",
      cityUsageStats: "id, cityId, lastTapped",
      recentLocations: "id, usedAt, cityId",
      savedLocations: "id, savedAt, cityId",
      personalUsage: null,
    });
    await v7.open();
    await v7.table("offlineCityMetadata").put({ cityId: "riga", state: "complete", sizeBytes: 5 });
    await v7.table("cityUsageStats").put({ id: '["riga","s1"]', cityId: "riga", stopId: "s1", tapCount: 2, lastTapped: 4 });
    await v7.table("savedLocations").put({ id: "s1", cityId: "riga", savedAt: 1, alias: "Home" });
    v7.close();

    await current.db.open();
    expect(current.db.verno).toBe(8);
    expect(await current.db.offlineCityMetadata.get("riga")).toMatchObject({ state: "complete", sizeBytes: 5 });
    for (const name of ["savedLocations", "recentLocations", "usageStats", "personalUsage", "cityUsageStats"]) {
      expect(current.db.table(name).schema.indexes).toEqual([]);
    }
    // Rows survive for the encrypted-storage migration to convert.
    expect(await current.db.cityUsageStats.count()).toBe(1);
    expect(await current.db.savedLocations.count()).toBe(1);
    current.db.close();
  });

  it("ensureDbReady opens a healthy DB without recovery", async () => {
    const { ensureDbReady } = await import("./migrationRunner.ts");
    const result = await ensureDbReady();
    expect(result.recovered).toBe(false);
  });
});
