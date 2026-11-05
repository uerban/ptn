import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../../src/db/index.ts";
import type { RoutingBundleData } from "@pt/shared";
import {
  installPtbCatalogFetch,
  ptbCatalogState,
  resetPtbCatalogState,
  STUB_ETAG,
  STUB_GENERATION_ID,
} from "../helpers/ptbCatalog.ts";

const mockData: RoutingBundleData = {
  stops: [{ id: "s1", name: "Stop A", lat: 54.68, lon: 25.28 }],
  routes: [{
    id: "r1", shortName: "1", mode: "BUS", color: "FF0000", textColor: "FFFFFF",
    stopIds: ["s1"],
    trips: [{ tripId: "t1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800] }],
  }],
  calendar: [{
    serviceId: "svc1",
    days: [true, true, true, true, true, false, false],
    startDate: "20250101", endDate: "20271231",
    exceptions: {},
  }],
  meta: { generatedAt: new Date().toISOString(), cityId: "vilnius" },
};

const reportErrorMock = vi.fn();

// The catalog arrives as PTB bytes; these cases are about what `syncGtfsData`
// PERSISTS, so the decode is stubbed and each test just sets the wire object it
// wants written. See `tests/helpers/ptbCatalog.ts`.
vi.mock("../../src/services/ptbCatalogWorkerClient.ts", async () => {
  const { ptbCatalogState } = await import("../helpers/ptbCatalog.ts");
  return { decodePtbCatalogInWorker: async () => ptbCatalogState.wire };
});

vi.mock("../../src/services/errorReporter.ts", () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

beforeEach(async () => {
  await db.delete();
  await db.open();
  reportErrorMock.mockClear();
  resetPtbCatalogState();
  ptbCatalogState.wire = mockData;
  installPtbCatalogFetch();
});

describe("syncGtfsData", () => {
  it("downloads and stores RAPTOR data in IndexedDB", async () => {
    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    const result = await syncGtfsData("vilnius");
    expect(result).toBe(true);

    const routes = await db.gtfsRoutes.toArray();
    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe("r1");

    const trips = await db.gtfsTrips.toArray();
    expect(trips).toHaveLength(1);
    expect(trips[0].tripId).toBe("t1");

    const services = await db.gtfsServices.toArray();
    expect(services).toHaveLength(1);

    const meta = await db.gtfsSyncMeta.get("current");
    expect(meta?.cityId).toBe("vilnius");
    expect(meta?.etag).toBe(STUB_ETAG);
  });

  it("persists PTB global trip ordinals into the Dexie fallback tables", async () => {
    ptbCatalogState.wire = {
        ...mockData,
        routes: [{
          ...mockData.routes[0]!,
          trips: [{ ...mockData.routes[0]!.trips[0]!, ptbTripIdx: 7 }],
        }],
      } satisfies RoutingBundleData;

    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    await syncGtfsData("vilnius");

    const trips = await db.gtfsTrips.toArray();
    expect(trips).toHaveLength(1);
    expect(trips[0]!.ptbTripIdx).toBe(7);
  });

  it("persists GTFS direction_id into the Dexie fallback tables", async () => {
    ptbCatalogState.wire = {
        ...mockData,
        routes: [{
          ...mockData.routes[0]!,
          trips: [{ ...mockData.routes[0]!.trips[0]!, directionId: 1 }],
        }],
      } satisfies RoutingBundleData;

    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    await syncGtfsData("vilnius");

    expect((await db.gtfsTrips.get("t1"))?.directionId).toBe(1);
  });

  it("persists frequency windows on sync meta for the Dexie fallback path", async () => {
    ptbCatalogState.wire = {
        ...mockData,
        frequencies: [{ tripIdx: 7, startSecs: 21600, endSecs: 86400, headwaySecs: 600, exactTimes: 0 }],
      } satisfies RoutingBundleData;

    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    await syncGtfsData("vilnius");

    const meta = await db.gtfsSyncMeta.get("current");
    expect(meta?.frequencies).toEqual([
      { tripIdx: 7, startSecs: 21600, endSecs: 86400, headwaySecs: 600, exactTimes: 0 },
    ]);
  });

  // A no-data answer is returned only after `fetchCatalog` confirms the cached
  // bundle is usable, so a second cache-integrity repair is unnecessary.

  it("treats an unchanged generation with a usable cached bundle as a no-op", async () => {
    await db.gtfsSyncMeta.put({
      id: "current",
      cityId: "vilnius",
      etag: STUB_ETAG,
      generationId: STUB_GENERATION_ID,
      lastSynced: Date.now() - 60_000,
      generatedAt: "2026-04-26T00:00:00Z",
    });
    await db.gtfsBundle.put({
      cityId: "vilnius",
      compressedBytes: new Uint8Array([0x1f, 0x8b]).buffer, // gzip magic; only existence + size are probed
      format: "gzip",
      bundleGeneratedAt: "2026-04-26T00:00:00Z",
      compressedSize: 2,
      decompressedSize: 0,
      writtenAt: Date.now(),
    });

    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    const result = await syncGtfsData("vilnius");

    // False means "nothing rewritten", not "failed".
    expect(result).toBe(false);
    const meta = await db.gtfsSyncMeta.get("current");
    expect(meta?.etag).toBe(STUB_ETAG);
    // lastSynced advances so the next scheduled sync backs off properly.
    expect(meta?.lastSynced).toBeGreaterThan(Date.now() - 30_000);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it("replaces a foreign city's meta row instead of stamping it as synced", async () => {
    // Meta belongs to oslo; we sync vilnius. The row must end up describing
    // vilnius — stamping oslo's row as freshly synced would suppress its next
    // legitimate refresh.
    await db.gtfsSyncMeta.put({
      id: "current",
      cityId: "oslo",
      etag: "oslo-etag",
      generationId: STUB_GENERATION_ID,
      lastSynced: Date.now() - 60_000,
      generatedAt: "2026-04-20T00:00:00Z",
    });

    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    const result = await syncGtfsData("vilnius");

    expect(result).toBe(true);
    const meta = await db.gtfsSyncMeta.get("current");
    expect(meta?.cityId).toBe("vilnius");
    expect(meta?.etag).toBe(STUB_ETAG);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it("db.gtfsRoutes stays route_id-unique when the wire carries per-pattern repeated ids (Unbounded)", async () => {
    // Simulate a per-pattern wire: two records sharing route_id "r1".
    // Pattern A: s1→s2 (the full route), Pattern B: s1 only (short-turn).
    // db.gtfsRoutes (PK=id) must collapse to ONE row for "r1" (the display-
    // aggregated record with the longest stopIds); the full per-pattern records
    // live only in the gtfsBundle blob.
    ptbCatalogState.wire = {
        ...mockData,
        routes: [
          {
            id: "r1", shortName: "1", mode: "BUS", color: "FF0000", textColor: "FFFFFF",
            stopIds: ["s1", "s2"],
            trips: [{ tripId: "t1", serviceId: "svc1", headsign: "Full", departureSecs: [28800, 29400] }],
          },
          {
            // Same id — this is the second pattern (short-turn)
            id: "r1", shortName: "1", mode: "BUS", color: "FF0000", textColor: "FFFFFF",
            stopIds: ["s1"],
            trips: [{ tripId: "t2", serviceId: "svc1", headsign: "Short", departureSecs: [32400] }],
          },
        ],
      };
    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    await syncGtfsData("vilnius");

    // db.gtfsRoutes must have EXACTLY ONE row per route_id (display-aggregated)
    const routes = await db.gtfsRoutes.toArray();
    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe("r1");
    // The aggregated row uses the longest pattern's stopIds (s1→s2)
    expect(routes[0].stopIds).toEqual(["s1", "s2"]);

    // The gtfsBundle blob must carry the per-pattern records (both entries).
    // readGtfsBundle deserializes the blob; routes[].id is repeated under Unbounded.
    const { readGtfsBundle } = await import("../../src/services/gtfsBundle.ts");
    const wire = await readGtfsBundle("vilnius");
    expect(wire).not.toBeNull();
    expect(wire!.routes.filter((r) => r.id === "r1")).toHaveLength(2);
  });

  it("persists directionPatterns on the Dexie gtfsRoutes row so the line-preview fix survives a bundle-blob fallback", async () => {
    // Sync a feed that has directionPatterns. The Dexie fallback is the read path when the bundle blob
    // is missing/corrupt or VITE_GTFS_BUNDLE_READ=0; if directionPatterns
    // doesn't survive the gtfsRoutes write, the entire fix silently
    // regresses on every fallback read.
    ptbCatalogState.wire = {
        ...mockData,
        routes: [{
          ...mockData.routes[0],
          stopIds: ["s1", "s2"],
          directionPatterns: [
            { key: "0", headsign: "Centre", stopIds: ["s1", "s2"] },
            { key: "1", headsign: "Suburb", stopIds: ["s2", "s3", "s1"] },
          ],
        }],
      };
    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    await syncGtfsData("vilnius");

    const routes = await db.gtfsRoutes.toArray();
    expect(routes).toHaveLength(1);
    expect(routes[0].directionPatterns).toEqual([
      { key: "0", headsign: "Centre", stopIds: ["s1", "s2"] },
      { key: "1", headsign: "Suburb", stopIds: ["s2", "s3", "s1"] },
    ]);
  });

  it("retains same-direction branch headsigns while aggregating Dexie route rows", async () => {
    const directionPatterns = [
      { key: "0", headsign: "Centre", stopIds: ["s1", "s2"] },
      { key: "0", headsign: "Centre via Branch", stopIds: ["s1", "s3", "s2"] },
    ];
    ptbCatalogState.wire = {
        ...mockData,
        routes: [
          { ...mockData.routes[0], directionPatterns },
          { ...mockData.routes[0], stopIds: ["s1"], directionPatterns },
        ],
      } satisfies RoutingBundleData;

    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    await syncGtfsData("vilnius");

    expect((await db.gtfsRoutes.get("r1"))?.directionPatterns?.map((p) => p.headsign)).toEqual([
      "Centre",
      "Centre via Branch",
    ]);
  });
});
