import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { PATTERN_MODE, PatternMode } from "@pt/shared/raptor";
import {
  DATA_SCHEMA_VERSION,
  dataSchemaStamp,
  ensureDataSchemaUpToDate,
  clearDeployedDataTables,
} from "./dataSchemaVersion.ts";
import { db, STORES, TABLE_KIND, type PtnTableName } from "./index.ts";

const KEY = "ptn:dataSchemaVersion";

const SERVER_DERIVED_TABLES = (Object.keys(TABLE_KIND) as PtnTableName[]).filter(
  (name) => TABLE_KIND[name] === "server-derived",
);
const USER_OWNED_TABLES = (Object.keys(TABLE_KIND) as PtnTableName[]).filter(
  (name) => TABLE_KIND[name] === "user-owned",
);

beforeEach(async () => {
  localStorage.clear();
  if (db.isOpen()) await db.close();
  await Dexie.delete("ptn");
  await db.open();
  vi.restoreAllMocks();
});

afterEach(async () => {
  if (db.isOpen()) await db.close();
});

describe("mode-composite data-schema stamp", () => {
  beforeEach(() => localStorage.clear());

  it("PATTERN_MODE default is covering-merge so the cache stamp forces a rebuild", () => {
    expect(PATTERN_MODE).toBe("covering-merge");
  });

  it("mode change wipes exactly once, then is up-to-date (no boot loop)", async () => {
    localStorage.setItem(KEY, dataSchemaStamp(PatternMode.Off));
    const first = await ensureDataSchemaUpToDate(PatternMode.Unbounded);
    expect(first.kind).toBe("wiped");
    expect(localStorage.getItem(KEY)).toBe(`${DATA_SCHEMA_VERSION}:unbounded`);
    const second = await ensureDataSchemaUpToDate(PatternMode.Unbounded);
    expect(second.kind).toBe("up-to-date"); // no second wipe
  });

  it.each(["7:off", "2:unbounded", "1", String(DATA_SCHEMA_VERSION + 1) + ":off"])(
    "a stamp from another data-schema version (%s) wipes exactly once",
    async (stored) => {
      localStorage.setItem(KEY, stored);
      const first = await ensureDataSchemaUpToDate(PatternMode.Off);
      expect(first.kind).toBe("wiped");
      expect(localStorage.getItem(KEY)).toBe(`${DATA_SCHEMA_VERSION}:off`);
      const second = await ensureDataSchemaUpToDate(PatternMode.Off);
      expect(second.kind).toBe("up-to-date");
    },
  );

  it("same-mode boot is a no-op", async () => {
    localStorage.setItem(KEY, dataSchemaStamp(PatternMode.Unbounded));
    const r = await ensureDataSchemaUpToDate(PatternMode.Unbounded);
    expect(r.kind).toBe("up-to-date");
  });

  it("fresh install stamps without reporting a wipe", async () => {
    const r = await ensureDataSchemaUpToDate(PatternMode.Off);
    expect(r.kind).toBe("fresh-install");
    expect(r.previous).toBeNull();
  });

  it("a localStorage read failure is reported and treated as unstamped (boot proceeds)", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const r = await ensureDataSchemaUpToDate(PatternMode.Off);
    expect(r.kind).toBe("fresh-install"); // unstamped → boot continues, never throws
    spy.mockRestore();
  });

  it("a localStorage write failure is swallowed and boot still proceeds as fresh-install", async () => {
    // localStorage is empty (beforeEach clears it) → fresh-install path → setStoredDataSchemaStamp is called
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const r = await ensureDataSchemaUpToDate(PatternMode.Off);
    expect(r.kind).toBe("fresh-install"); // write failure must not throw or change the result
    spy.mockRestore();
  });
});

describe("ensureDataSchemaUpToDate", () => {
  it("on partial wipe failure, does NOT stamp the version and reports kind=wipe-incomplete", async () => {
    localStorage.setItem(KEY, dataSchemaStamp(PatternMode.Off)); // wrong mode triggers wipe
    // Use Unbounded so stored !== current → wipe path
    await db.stops.put({
      id: "s1",
      name: "T",
      location: { lat: 0, lon: 0 },
      lastSeen: Date.now(),
    });
    vi.spyOn(db.stops, "clear").mockRejectedValueOnce(new Error("boom"));

    const result = await ensureDataSchemaUpToDate(PatternMode.Unbounded);

    expect(result.kind).toBe("wipe-incomplete");
    if (result.kind === "wipe-incomplete") {
      expect(result.failed).toContain("stops");
    }
    // Other tables still cleared (Promise.all completes all).
    expect(await db.gtfsRoutes.count()).toBe(0);
    // Stamp NOT written — next boot retries the wipe.
    expect(localStorage.getItem(KEY)).toBe(dataSchemaStamp(PatternMode.Off));
  });

  it("clears every table classified server-derived in TABLE_KIND", async () => {
    localStorage.setItem(KEY, dataSchemaStamp(PatternMode.Off));
    await Promise.all(SERVER_DERIVED_TABLES.map((name) => seedRow(name)));

    await ensureDataSchemaUpToDate(PatternMode.Unbounded);

    for (const name of SERVER_DERIVED_TABLES) {
      expect(await db[name].count()).toBe(0);
    }
  });

  it("preserves every user-owned table classified in TABLE_KIND", async () => {
    localStorage.setItem(KEY, dataSchemaStamp(PatternMode.Off));
    await Promise.all(USER_OWNED_TABLES.filter((n) => n !== "installKey").map(seedRow));

    await ensureDataSchemaUpToDate(PatternMode.Unbounded);

    for (const name of USER_OWNED_TABLES) {
      if (name === "installKey") continue;
      expect(await db[name].count()).toBeGreaterThan(0);
    }
  });

  it("opens a higher-version database, clears deployed rows, and preserves user rows", async () => {
    if (db.isOpen()) await db.close();
    await Dexie.delete("ptn");

    const oldDeployment = new Dexie("ptn");
    oldDeployment.version(20).stores(STORES);
    await oldDeployment.open();
    await oldDeployment.table("gtfsRoutes").put({
      id: "old-route", shortName: "1", mode: "BUS", stopIds: [],
    });
    await oldDeployment.table("gtfsTrips").put({
      tripId: "old-trip", routeId: "old-route", serviceId: "old-service",
      headsign: "Old", departureSecs: [],
    });
    await oldDeployment.table("gtfsServices").put({
      serviceId: "old-service", days: [true, true, true, true, true, false, false],
      startDate: "20260101", endDate: "20261231", exceptions: {},
    });
    await oldDeployment.table("gtfsStops").put({
      id: "old-stop", name: "Old", lat: 54.7, lon: 25.3,
    });
    await oldDeployment.table("gtfsSyncMeta").put({
      id: "current", cityId: "vilnius", etag: '"old"', generationId: "o".repeat(64),
      lastSynced: 1, generatedAt: "2026-01-01",
    });
    await oldDeployment.table("gtfsBundle").put({
      cityId: "vilnius", compressedBytes: new ArrayBuffer(1), format: "gzip",
      bundleGeneratedAt: "2026-01-01", compressedSize: 1, decompressedSize: 1,
      writtenAt: 1,
    });
    await oldDeployment.table("ptbBytes").put({
      cityId: "vilnius", bytes: new Uint8Array([1]), etag: '"old"',
      firstStoredAt: 1, lastValidatedAt: 1,
    });
    await oldDeployment.table("poiTileCache").put({
      tileKey: "vilnius/12km/0_0", compressedBytes: new ArrayBuffer(1),
      loadedAt: 1, byteSize: 1,
    });
    await oldDeployment.table("savedLocations").put({
      id: "home", endpoint: { lat: 54.7, lon: 25.3 }, alias: "Home",
      savedAt: 1, encrypted: false,
    });
    oldDeployment.close();

    localStorage.setItem(KEY, "7:off");
    await db.open();
    const result = await ensureDataSchemaUpToDate(PatternMode.Unbounded);

    expect(result.kind).toBe("wiped");
    expect(await db.gtfsRoutes.count()).toBe(0);
    expect(await db.gtfsTrips.count()).toBe(0);
    expect(await db.gtfsServices.count()).toBe(0);
    expect(await db.gtfsStops.count()).toBe(0);
    expect(await db.gtfsSyncMeta.count()).toBe(0);
    expect(await db.gtfsBundle.count()).toBe(0);
    expect(await db.ptbBytes.count()).toBe(0);
    expect(await db.poiTileCache.count()).toBe(0);
    expect(await db.savedLocations.get("home")).toMatchObject({ alias: "Home" });
    expect(db.tables.map((table) => table.name)).toContain("gtfsRoutes");
  });
});

describe("clearDeployedDataTables", () => {
  it("clears server-derived tables and reports no failures on the happy path", async () => {
    await db.stops.put({
      id: "s1",
      name: "T",
      location: { lat: 0, lon: 0 },
      lastSeen: Date.now(),
    });
    await db.usageStats.put({ stopId: "s1", tapCount: 1, lastTapped: Date.now() });

    const { failed } = await clearDeployedDataTables();

    expect(failed).toEqual([]);
    expect(await db.stops.count()).toBe(0);
    expect(await db.usageStats.count()).toBe(1);
  });

  it("collects per-table failures so the caller can decide whether to stamp", async () => {
    vi.spyOn(db.gtfsRoutes, "clear").mockRejectedValueOnce(new Error("io"));

    const { failed } = await clearDeployedDataTables();

    expect(failed).toEqual(["gtfsRoutes"]);
  });
});

describe("stamp-change eviction of cached PTB bytes", () => {
  // fetchPtbBytesPreferCache serves cached bytes without a network call. A
  // client that cannot read the cached format would fail closed forever unless
  // the stamp change evicts ptbBytes and forces the resume path to the network.
  // The wipe is driven by stamp inequality, so a rollback evicts just like an
  // upgrade.
  beforeEach(() => localStorage.clear());

  it("evicts cached ptbBytes when a newer client's stamp is found", async () => {
    await db.ptbBytes.put({
      cityId: "vilnius",
      bytes: new Uint8Array([0x50, 0x54, 0x42, 0x00, 2]),
      etag: '"newer"',
      firstStoredAt: Date.now(),
      lastValidatedAt: Date.now(),
      windowDays: 90,
      horizonEndDate: "20260830",
    } as unknown as Parameters<typeof db.ptbBytes.put>[0]);
    localStorage.setItem(KEY, `${DATA_SCHEMA_VERSION + 1}:off`); // newer client's stamp

    const r = await ensureDataSchemaUpToDate(PatternMode.Off);
    expect(r.kind).toBe("wiped");

    // An empty table forces fetchPtbBytesPreferCache to the network. See the
    // "falls back to network-first when cache is empty" test in
    // services/gtfsBundleBytes.test.ts.
    expect(await db.ptbBytes.get("vilnius")).toBeUndefined();
    expect(await db.ptbBytes.count()).toBe(0);
    expect(localStorage.getItem(KEY)).toBe(`${DATA_SCHEMA_VERSION}:off`); // re-stamped to current
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function seedRow(name: PtnTableName): Promise<void> {
  switch (name) {
    case "stops":
      return void (await db.stops.put({
        id: "s1", name: "x", location: { lat: 0, lon: 0 }, lastSeen: Date.now(),
      }));
    case "stopGroups":
      return void (await db.stopGroups.put({
        groupId: "g1", name: "x", stopIds: ["s1"], type: "name_cluster", lat: 0, lon: 0,
      }));
    case "gtfsRoutes":
      return void (await db.gtfsRoutes.put({ id: "r1", shortName: "1", mode: "BUS", stopIds: [] }));
    case "gtfsTrips":
      return void (await db.gtfsTrips.put({
        tripId: "t1", routeId: "r1", serviceId: "sv1", headsign: "x", departureSecs: [],
      }));
    case "gtfsServices":
      return void (await db.gtfsServices.put({
        serviceId: "sv1",
        days: [false, false, false, false, false, false, false],
        startDate: "20260101",
        endDate: "20261231",
        exceptions: {},
      }));
    case "gtfsStops":
      return void (await db.gtfsStops.put({ id: "gs1", name: "x", lat: 0, lon: 0 }));
    case "gtfsSyncMeta":
      return void (await db.gtfsSyncMeta.put({
        id: "current", cityId: "vilnius", etag: '"seed"', generationId: "s".repeat(64),
        lastSynced: 0, generatedAt: "2026-01-01",
      }));
    case "gtfsBundle":
      return void (await db.gtfsBundle.put({
        cityId: "vilnius",
        compressedBytes: new ArrayBuffer(0),
        format: "gzip",
        bundleGeneratedAt: "2026-01-01",
        compressedSize: 0,
        decompressedSize: 0,
        writtenAt: 0,
      }));
    case "gtfsShapes":
      return void (await db.gtfsShapes.put({ shapeId: "sh1", encodedPolyline: "", source: "gtfs" }));
    case "poiIndex":
      return void (await db.poiIndex.put({
        id: "p1", cityId: "vilnius", name: "x", geoBucket: "0,0", aliases: {},
        category: "x", lat: 0, lon: 0, source: "osm", rankBoost: 0, tier: "strict",
      }));
    case "poiSyncMeta":
      return void (await db.poiSyncMeta.put({
        cityId: "vilnius", activeBundleHash: "x", entryCount: 0, installedAt: 0, tier: "strict",
      }));
    case "geocoderDedup":
      return void (await db.geocoderDedup.put({
        queryHash: "h1",
        ct: new ArrayBuffer(0),
        iv: new ArrayBuffer(0),
        createdAt: 0,
        providerId: "third-party-nominatim",
        gridMeters: 100,
      }));
    case "poiTileCache":
      return void (await db.poiTileCache.put({
        tileKey: "t1", compressedBytes: new ArrayBuffer(0), loadedAt: 0, byteSize: 0,
        cityId: "vilnius", bundleSha256: "b".repeat(64), generationId: "g".repeat(64),
      }));
    case "addressSearchArtifacts":
      return void (await db.addressSearchArtifacts.put({
        cityId: "vilnius",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        generatedAt: "2026-08-15T00:00:00.000Z",
        installedAt: Date.now(),
        rowCount: 1,
        keyCount: 1,
        bytes: new ArrayBuffer(8),
      }));
    case "usageStats":
      return void (await db.usageStats.put({ stopId: "s1", tapCount: 1, lastTapped: Date.now() }));
    case "recentLocations":
      return void (await db.recentLocations.put({
        id: "rl1",
        sealed: { v: 1, iv: new ArrayBuffer(12), ct: new ArrayBuffer(16) },
      }));
    case "savedLocations":
      return void (await db.savedLocations.put({
        id: "sv1",
        sealed: { v: 1, iv: new ArrayBuffer(12), ct: new ArrayBuffer(16) },
      }));
    case "personalUsage":
      return void (await db.personalUsage.put({
        id: "pu1",
        sealed: { v: 1, iv: new ArrayBuffer(12), ct: new ArrayBuffer(16) },
      }));
    case "installKey":
      // Constructing a real CryptoKey is impractical in this env. The
      // satisfies-driven TABLE_KIND is the load-bearing guarantee that
      // installKey is never wiped; this branch exists so seedRow stays
      // exhaustive over PtnTableName at the type level.
      return;
  }
}
