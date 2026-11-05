import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../../src/db/index.ts";
import type { RoutingBundleData } from "@pt/shared";
import {
  installPtbCatalogFetch,
  ptbCatalogState,
  resetPtbCatalogState,
  STUB_ETAG,
} from "../helpers/ptbCatalog.ts";

/**
 * T6: Mid-sync interruption — verify GTFS sync transaction is atomic.
 *
 * If bulkPut fails partway through the transaction, nothing should be
 * committed. This ensures no partial / inconsistent state after an
 * interruption (page close, crash, etc.).
 */

const mockData: RoutingBundleData = {
  stops: [{ id: "s1", name: "Stop A", lat: 54.68, lon: 25.28 }],
  routes: [
    {
      id: "r1",
      shortName: "1",
      mode: "BUS",
      color: "FF0000",
      textColor: "FFFFFF",
      stopIds: ["s1"],
      trips: [
        {
          tripId: "t1",
          serviceId: "svc1",
          headsign: "Centre",
          departureSecs: [28800],
        },
      ],
    },
  ],
  calendar: [
    {
      serviceId: "svc1",
      days: [true, true, true, true, true, false, false],
      startDate: "20250101",
      endDate: "20271231",
      exceptions: {},
    },
  ],
  meta: { generatedAt: new Date().toISOString(), cityId: "vilnius" },
};

// Catalog transport is PTB bytes; only the decoded wire matters here.
vi.mock("../../src/services/ptbCatalogWorkerClient.ts", async () => {
  const { ptbCatalogState } = await import("../helpers/ptbCatalog.ts");
  return { decodePtbCatalogInWorker: async () => ptbCatalogState.wire };
});

beforeEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  resetPtbCatalogState();
  ptbCatalogState.wire = mockData;
  installPtbCatalogFetch();
  await db.delete();
  await db.open();
});

describe("GTFS sync transaction atomicity (T6)", () => {
  it("rolls back all writes when bulkPut fails mid-transaction", async () => {
    // Seed existing data that should survive a failed sync
    await db.gtfsRoutes.put({
      id: "r-existing",
      shortName: "99",
      mode: "TRAM",
      stopIds: ["s0"],
    });

    // Sabotage gtfsServices.bulkPut to throw mid-transaction.
    // The transaction wraps routes, trips, services, stops, and syncMeta —
    // if services.bulkPut throws, the entire transaction must roll back.
    vi.spyOn(db.gtfsServices, "bulkPut").mockRejectedValueOnce(
      new Error("Simulated write failure"),
    );

    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");

    // Sync should throw because of the simulated failure
    await expect(syncGtfsData("vilnius")).rejects.toThrow(
      "Simulated write failure",
    );

    // After a rolled-back transaction, the tables were cleared inside the
    // transaction before writes began. Since the transaction aborted, the
    // clears are also rolled back, so existing data should still be present.
    const routes = await db.gtfsRoutes.toArray();
    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe("r-existing");

    // No new trips should have been committed
    const trips = await db.gtfsTrips.toArray();
    expect(trips).toHaveLength(0);

    // syncMeta should be unchanged (no partial update)
    const meta = await db.gtfsSyncMeta.get("current");
    expect(meta).toBeUndefined();
  });

  it("commits all tables atomically on success", async () => {
    const { syncGtfsData } = await import("../../src/services/gtfsSync.ts");
    const result = await syncGtfsData("vilnius");
    expect(result).toBe(true);

    // All tables should be populated
    const routes = await db.gtfsRoutes.toArray();
    expect(routes).toHaveLength(1);
    expect(routes[0].id).toBe("r1");

    const trips = await db.gtfsTrips.toArray();
    expect(trips).toHaveLength(1);

    const services = await db.gtfsServices.toArray();
    expect(services).toHaveLength(1);

    const stops = await db.gtfsStops.toArray();
    expect(stops).toHaveLength(1);

    const meta = await db.gtfsSyncMeta.get("current");
    expect(meta?.cityId).toBe("vilnius");
    expect(meta?.etag).toBe(STUB_ETAG);
  });
});
