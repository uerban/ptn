import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("maplibre-gl", () => ({ default: {} }));
vi.mock("../../src/map/maplibre.ts", () => ({ default: {} }));

import { db } from "../../src/db/index.ts";
import { loadGtfsCorridorFeatureCollection } from "../../src/components/Map/GtfsCorridorLayer.tsx";
import { writeGtfsBundle } from "../../src/services/gtfsBundle.ts";

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe("GtfsCorridorLayer data loader", () => {
  it("does not use stale GTFS display tables from another city", async () => {
    await db.gtfsSyncMeta.put({
      id: "current",
      cityId: "vilnius",
      etag: '"corridor"',
      lastSynced: Date.now(),
      generatedAt: "2026-08-13T00:00:00Z",
      generationId: "c".repeat(64),
    });
    await db.gtfsRoutes.put({
      id: "R1",
      shortName: "1",
      mode: "BUS",
      stopIds: ["A", "B"],
    });
    await db.gtfsStops.bulkPut([
      { id: "A", name: "A", lat: 54.6872, lon: 25.2797 },
      { id: "B", name: "B", lat: 54.688, lon: 25.281 },
    ]);

    const data = await loadGtfsCorridorFeatureCollection("oslo");

    expect(data.features).toEqual([]);
  });

  it("loads GTFS-derived corridors when the meta row matches the active city", async () => {
    await db.gtfsSyncMeta.put({
      id: "current",
      cityId: "vilnius",
      etag: '"corridor"',
      lastSynced: Date.now(),
      generatedAt: "2026-08-13T00:00:00Z",
      generationId: "c".repeat(64),
    });
    await db.gtfsRoutes.put({
      id: "R1",
      shortName: "1",
      mode: "BUS",
      stopIds: ["A", "B"],
    });
    await db.gtfsTrips.put({
      tripId: "T1",
      routeId: "R1",
      serviceId: "SVC",
      headsign: "Centre",
      departureSecs: [28800],
    });
    await db.gtfsStops.bulkPut([
      { id: "A", name: "A", lat: 54.6872, lon: 25.2797 },
      { id: "B", name: "B", lat: 54.688, lon: 25.281 },
    ]);

    const data = await loadGtfsCorridorFeatureCollection("vilnius");

    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties.id).toBe("stopseq:R1");
  });

  it("falls back to the current-city GTFS bundle when Dexie display tables are stale", async () => {
    await db.gtfsSyncMeta.put({
      id: "current",
      cityId: "vilnius",
      etag: '"corridor"',
      lastSynced: Date.now(),
      generatedAt: "2026-08-13T00:00:00Z",
      generationId: "c".repeat(64),
    });
    await db.gtfsRoutes.put({
      id: "OLD",
      shortName: "0",
      mode: "BUS",
      stopIds: ["X", "Y"],
    });
    await writeGtfsBundle("oslo", {
      meta: { generatedAt: "2026-08-13T00:00:00Z" },
      routes: [
        {
          id: "R1",
          shortName: "1",
          mode: "METRO",
          stopIds: ["A", "B"],
          trips: [
            {
              tripId: "T1",
              serviceId: "SVC",
              headsign: "Centre",
              departureSecs: [28800, 29400],
            },
          ],
        },
      ],
      calendar: [],
      stops: [
        { id: "A", name: "A", lat: 59.91, lon: 10.75 },
        { id: "B", name: "B", lat: 59.92, lon: 10.76 },
      ],
    });

    const data = await loadGtfsCorridorFeatureCollection("oslo");

    expect(data.features).toHaveLength(1);
    expect(data.features[0].properties).toMatchObject({
      id: "stopseq:R1",
      mode: "METRO",
    });
    expect(data.features[0].geometry.coordinates).toEqual([
      [10.75, 59.91],
      [10.76, 59.92],
    ]);
  });
});
