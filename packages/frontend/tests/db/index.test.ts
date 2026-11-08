import Dexie from "dexie";
import { describe, it, expect, beforeEach, vi } from "vitest";
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
    expect(decls).toHaveLength(7);
    const {offlineCities, offlineTransfers, offlineCityMetadata, cityUsageStats: _cityUsage, cityArtifacts: _artifacts, cityArtifactMetadata: _artifactMetadata, cityCachePointers: _pointers, cityShapes: _shapes, sharedArtifactMetadata: _sharedMetadata, ...latestOriginal} = STORES;
    const originalStores = {...latestOriginal, savedLocations: "id, savedAt", recentLocations: "id, usedAt"};
    expect(decls[0]).toMatchObject({id: "ptn", version: 1, stores: originalStores});
    expect(decls[1]).toMatchObject({id: "offline-city-packages", version: 2, stores: {offlineCities, offlineTransfers}});
    expect(decls[0].upgrade).toBeUndefined();
    expect(decls[2]).toMatchObject({id: "offline-city-metadata", version: 3, stores: {offlineCityMetadata}});
    expect(decls[5]).toMatchObject({id: "city-shape-artifacts", version: 6, stores: {cityShapes: "hash"}});
    expect(decls[6]).toMatchObject({id: "shared-artifact-inventory", version: 7, stores: {sharedArtifactMetadata: "key"}});
  });

  it("classifies every declared table in TABLE_KIND", () => {
    expect(Object.keys(STORES).sort()).toEqual(Object.keys(TABLE_KIND).sort());
  });

  it("keys gbfsSystems by its composite key", () => {
    expect(STORES.gbfsSystems).toBe("key");
  });
});

it("discovers v6 sidecar inventory by keys without materializing payloads", async () => {
  await db.delete();
  const previous = new Dexie("ptn");
  previous.version(6).stores(Object.assign({}, ...migrationCoordinator.declaredMigrations().filter(decl => decl.version <= 6).map(decl => decl.stores)));
  await previous.open();
  await previous.table("offlineTransfers").put({hash: "walk", bytes: new Uint8Array([1])});
  await previous.table("cityShapes").put({hash: "shape", bytes: new Uint8Array([2])});
  previous.close();
  const forbidden = () => {throw new Error("upgrade cloned sidecar payload");};
  db.offlineTransfers.hook("reading", forbidden); db.cityShapes.hook("reading", forbidden);
  try {
    await db.open();
    expect(await db.sharedArtifactMetadata.toArray()).toEqual([
      {key: "shapes:shape", kind: "shapes", hash: "shape", lastUsedAt: 0},
      {key: "transfers:walk", kind: "transfers", hash: "walk", lastUsedAt: 0},
    ]);
  } finally {
    db.offlineTransfers.hook("reading").unsubscribe(forbidden); db.cityShapes.hook("reading").unsubscribe(forbidden);
  }
});

it("upgrades version-2 downloads using keys only and leaves payloads untouched", async () => {
  await db.delete();
  const previous = new Dexie("ptn");
  const v2Stores = Object.assign({}, ...migrationCoordinator.declaredMigrations().filter(decl => decl.version <= 2).map(decl => decl.stores));
  previous.version(2).stores(v2Stores);
  await previous.open();
  await previous.table("offlineCities").bulkPut([
    {cityId: "vilnius", tables: {large: ["untouched"]}},
    {cityId: "krakow", tables: {large: ["also untouched"]}},
  ]);
  previous.close();
  const getAll = IDBObjectStore.prototype.getAll;
  const spy = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(function (...args) {
    if (this.name === "offlineCities") throw new Error("upgrade read timetable payloads");
    return getAll.apply(this, args);
  });
  try {
    await db.open();
    expect(await db.offlineCityMetadata.toArray()).toEqual([
      {cityId: "krakow", state: "legacy"}, {cityId: "vilnius", state: "legacy"},
    ]);
  } finally { spy.mockRestore(); }
  expect((await db.offlineCities.get("vilnius"))?.tables).toEqual({large: ["untouched"]});
});


it("upgrades city ownership indexes without rewriting private payloads or guessing legacy ownership", async () => {
  await db.delete();
  const old = new Dexie("ptn");
  const {cityUsageStats: _usage, ...stores} = STORES;
  old.version(3).stores({...stores, savedLocations: "id, savedAt", recentLocations: "id, usedAt"});
  await old.open();
  const cipher = {iv: new Uint8Array([1, 2, 3]), ct: new Uint8Array([4, 5, 6]).buffer};
  const saved = {id: "legacy-private", endpoint: cipher, aliasCipher: cipher, alias: "", encrypted: true, savedAt: 123};
  const recent = {id: "old-recent", endpoint: cipher, usedAt: 456, usedAsOrigin: true};
  await old.table("savedLocations").put(saved);
  await old.table("recentLocations").put(recent);
  await old.table("usageStats").put({stopId: "ambiguous", tapCount: 5, lastTapped: 100});
  old.close();
  await db.open();
  const loadedSave = await db.savedLocations.get(saved.id);
  const loadedRecent = await db.recentLocations.get(recent.id);
  expect({...loadedSave, endpoint: null, aliasCipher: null}).toEqual({...saved, endpoint: null, aliasCipher: null});
  expect({...loadedRecent, endpoint: null}).toEqual({...recent, endpoint: null});
  for (const value of [loadedSave?.endpoint, loadedSave?.aliasCipher, loadedRecent?.endpoint]) {
    const loadedCipher = value as unknown as typeof cipher;
    expect([...new Uint8Array(loadedCipher.ct)]).toEqual([4, 5, 6]);
    expect([...loadedCipher.iv]).toEqual([1, 2, 3]);
  }
  expect(await db.savedLocations.where("cityId").equals("vilnius").count()).toBe(0);
  expect(await db.cityUsageStats.count()).toBe(0);
  expect((await db.usageStats.get("ambiguous"))?.tapCount).toBe(5);
});
