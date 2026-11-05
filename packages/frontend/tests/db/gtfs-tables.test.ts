import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db/index.ts";
import type { GtfsRouteRecord, GtfsTripRecord, GtfsServiceRecord, GtfsSyncMeta } from "../../src/db/index.ts";

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("Dexie GTFS tables", () => {
  it("stores and retrieves a route", async () => {
    const route: GtfsRouteRecord = {
      id: "r1", shortName: "1", mode: "BUS", color: "FF0000",
      textColor: "FFFFFF", stopIds: ["s1", "s2", "s3"],
    };
    await db.gtfsRoutes.put(route);
    const fetched = await db.gtfsRoutes.get("r1");
    expect(fetched).toEqual(route);
  });

  it("stores and retrieves trips by routeId", async () => {
    const trip: GtfsTripRecord = {
      tripId: "t1", routeId: "r1", serviceId: "svc1",
      headsign: "Centre", departureSecs: [28800, 29400],
    };
    await db.gtfsTrips.put(trip);
    const byRoute = await db.gtfsTrips.where("routeId").equals("r1").toArray();
    expect(byRoute).toHaveLength(1);
    expect(byRoute[0].tripId).toBe("t1");
  });

  it("stores and retrieves sync metadata", async () => {
    const meta: GtfsSyncMeta = {
      id: "current",
      cityId: "vilnius",
      etag: '"12345"',
      lastSynced: Date.now(),
      generatedAt: new Date().toISOString(),
      generationId: "1".repeat(64),
    };
    await db.gtfsSyncMeta.put(meta);
    const fetched = await db.gtfsSyncMeta.get("current");
    expect(fetched?.cityId).toBe("vilnius");
  });
});
