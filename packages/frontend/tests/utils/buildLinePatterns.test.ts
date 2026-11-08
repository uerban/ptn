import { seedLegacyCityProjection } from "../../src/test-helpers/cityData.ts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildLinePatterns } from "../../src/utils/buildLinePatterns.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { db } from "../../src/db/index.ts";
import type { RaptorIndex, RaptorIndexRoute } from "../../src/services/raptorIndex.ts";
import type { TransportMode } from "@pt/shared";

const reportErrorMock = vi.fn();
vi.mock("../../src/services/errorReporter.ts", () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));

function makeRoute(overrides: Partial<RaptorIndexRoute> & { id: string }): RaptorIndexRoute {
  return {
    shortName: "1",
    mode: "BUS" as TransportMode,
    stopIds: [],
    trips: [],
    ...overrides,
  };
}

function makeIndex(routes: RaptorIndexRoute[]): RaptorIndex {
  const routeIdToIdx = new Map<string, number>();
  const routesAtStop = new Map<string, number[]>();
  for (let i = 0; i < routes.length; i++) {
    routeIdToIdx.set(routes[i].id, i);
    for (const stopId of routes[i].stopIds) {
      let arr = routesAtStop.get(stopId);
      if (!arr) { arr = []; routesAtStop.set(stopId, arr); }
      arr.push(i);
    }
  }
  return {
    routes,
    routeIdToIdx,
    routesAtStop,
    services: new Map(),
  };
}

async function seedStops(stops: { id: string; name: string; lat: number; lon: number }[]) {
  await db.gtfsStops.bulkPut(stops);
}

describe("buildLinePatterns", () => {
  beforeEach(async () => {
    await db.gtfsStops.clear();
    await db.gtfsTrips.clear();
    await seedLegacyCityProjection();
    useGtfsDataStore.setState({ raptorIndex: null, loadedCityId: null, syncing: false, error: null });
    reportErrorMock.mockClear();
  });

  it("returns empty array when raptorIndex is null", async () => {
    const result = await buildLinePatterns("r1");
    expect(result).toEqual([]);
  });

  it("returns empty array for missing routeId", async () => {
    useGtfsDataStore.setState({ raptorIndex: makeIndex([]) });
    const result = await buildLinePatterns("nonexistent");
    expect(result).toEqual([]);
  });

  it("builds two direction patterns for a bidirectional route", async () => {
    await seedStops([
      { id: "s1", name: "Alpha", lat: 54.35, lon: 18.65 },
      { id: "s2", name: "Beta", lat: 54.36, lon: 18.66 },
      { id: "s3", name: "Gamma", lat: 54.37, lon: 18.67 },
    ]);

    const route = makeRoute({
      id: "r1",
      shortName: "142",
      stopIds: ["s1", "s2", "s3"],
      trips: [
        // Direction 0: s1 -> s2 -> s3
        { tripId: "t1", serviceId: "svc1", headsign: "Central Station", departureSecs: [100, 200, 300] },
        { tripId: "t2", serviceId: "svc1", headsign: "Central Station", departureSecs: [400, 500, 600] },
        // Direction 1: s3 -> s2 -> s1
        { tripId: "t3", serviceId: "svc1", headsign: "Airport", departureSecs: [350, 250, 150] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r1");
    expect(patterns).toHaveLength(2);

    // Direction 0
    expect(patterns[0].directionId).toBe(0);
    expect(patterns[0].headsign).toBe("Central Station");
    expect(patterns[0].stops.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(patterns[0].stops[0].name).toBe("Alpha");
    expect(patterns[0].stops[0].location).toEqual({ lat: 54.35, lon: 18.65 });

    // Direction 1 — travel order is s3 -> s2 -> s1 (depSecs: 150, 250, 350)
    expect(patterns[1].directionId).toBe(1);
    expect(patterns[1].headsign).toBe("Airport");
    expect(patterns[1].stops.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
    // The trips carry no direction_id: the patterns claim none.
    expect(patterns.map((p) => "gtfsDirectionId" in p)).toEqual([false, false]);
  });

  it("builds one pattern for a unidirectional route", async () => {
    await seedStops([
      { id: "s1", name: "Start", lat: 54.0, lon: 18.0 },
      { id: "s2", name: "End", lat: 54.1, lon: 18.1 },
    ]);

    const route = makeRoute({
      id: "r2",
      shortName: "Loop",
      stopIds: ["s1", "s2"],
      trips: [
        { tripId: "t1", serviceId: "svc1", headsign: "Terminus", departureSecs: [100, 200] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r2");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].directionId).toBe(0);
    expect(patterns[0].headsign).toBe("Terminus");
    expect(patterns[0].stops).toHaveLength(2);
  });

  it("returns empty array for route with no trips", async () => {
    const route = makeRoute({ id: "r3", stopIds: ["s1"], trips: [] });
    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const result = await buildLinePatterns("r3");
    expect(result).toEqual([]);
  });

  it("resolves stop locations correctly from Dexie", async () => {
    await seedStops([
      { id: "s1", name: "North", lat: 54.40, lon: 18.60 },
      { id: "s2", name: "South", lat: 54.30, lon: 18.70 },
    ]);

    const route = makeRoute({
      id: "r4",
      stopIds: ["s1", "s2"],
      trips: [
        { tripId: "t1", serviceId: "svc1", headsign: "South", departureSecs: [100, 200] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r4");
    expect(patterns[0].stops[0].location).toEqual({ lat: 54.40, lon: 18.60 });
    expect(patterns[0].stops[1].location).toEqual({ lat: 54.30, lon: 18.70 });
  });

  it("skips stops not found in Dexie", async () => {
    // Only seed s1, not s2
    await seedStops([
      { id: "s1", name: "Only Stop", lat: 54.0, lon: 18.0 },
    ]);

    const route = makeRoute({
      id: "r5",
      stopIds: ["s1", "s2"],
      trips: [
        { tripId: "t1", serviceId: "svc1", headsign: "End", departureSecs: [100, 200] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r5");
    expect(patterns[0].stops).toHaveLength(1);
    expect(patterns[0].stops[0].id).toBe("s1");
  });

  it("picks representative trip with most visited stops", async () => {
    await seedStops([
      { id: "s1", name: "A", lat: 54.0, lon: 18.0 },
      { id: "s2", name: "B", lat: 54.1, lon: 18.1 },
      { id: "s3", name: "C", lat: 54.2, lon: 18.2 },
    ]);

    const route = makeRoute({
      id: "r6",
      stopIds: ["s1", "s2", "s3"],
      trips: [
        // Express trip: skips s2
        { tripId: "t1", serviceId: "svc1", headsign: "End", departureSecs: [100, -1, 300] },
        // Full trip: all stops
        { tripId: "t2", serviceId: "svc1", headsign: "End", departureSecs: [400, 500, 600] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r6");
    expect(patterns[0].stops).toHaveLength(3);
    expect(patterns[0].stops.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("sorts stops by departure time for correct travel order", async () => {
    await seedStops([
      { id: "s1", name: "First", lat: 54.0, lon: 18.0 },
      { id: "s2", name: "Second", lat: 54.1, lon: 18.1 },
      { id: "s3", name: "Third", lat: 54.2, lon: 18.2 },
    ]);

    // Route stopIds are in one order, but the trip visits them in reverse
    const route = makeRoute({
      id: "r7",
      stopIds: ["s1", "s2", "s3"],
      trips: [
        { tripId: "t1", serviceId: "svc1", headsign: "Reverse", departureSecs: [300, 200, 100] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r7");
    // Stops should be ordered by departure time: s3 (100), s2 (200), s1 (300)
    expect(patterns[0].stops.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
  });

  it("propagates the representative trip's shapeId from the in-memory raptorIndex", async () => {
    await seedStops([
      { id: "s1", name: "A", lat: 54.0, lon: 18.0 },
      { id: "s2", name: "B", lat: 54.1, lon: 18.1 },
    ]);

    const route = makeRoute({
      id: "rShape",
      stopIds: ["s1", "s2"],
      trips: [
        // Express trip (fewer stops) — would not be picked as representative.
        { tripId: "t-express", serviceId: "svc1", headsign: "End", departureSecs: [100, -1], shapeId: "shape-express" },
        // Full trip — picked, shapeId should propagate.
        { tripId: "t-full", serviceId: "svc1", headsign: "End", departureSecs: [200, 300], shapeId: "shape-full" },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("rShape");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].shapeId).toBe("shape-full");
  });

  it("falls back to gtfsTrips.shapeId when the raptorIndex trip carries no shapeId", async () => {
    await seedStops([
      { id: "s1", name: "A", lat: 54.0, lon: 18.0 },
      { id: "s2", name: "B", lat: 54.1, lon: 18.1 },
    ]);
    await db.gtfsTrips.put({
      tripId: "t-1",
      routeId: "rFallback",
      serviceId: "svc1",
      headsign: "End",
      departureSecs: [100, 200],
      shapeId: "shape-from-dexie",
    });

    const route = makeRoute({
      id: "rFallback",
      stopIds: ["s1", "s2"],
      // shapeId omitted on the in-memory trip — exercises the legacy
      // hydrate path where the raptor bundle was built before d76156b.
      trips: [
        { tripId: "t-1", serviceId: "svc1", headsign: "End", departureSecs: [100, 200] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("rFallback");
    expect(patterns[0].shapeId).toBe("shape-from-dexie");
  });

  it("falls back to undefined shapeId (no reject) when gtfsTrips.get throws", async () => {
    await seedStops([{ id: "s1", name: "A", lat: 54.0, lon: 18.0 }]);
    const route = makeRoute({
      id: "rRejects",
      stopIds: ["s1"],
      // shapeId omitted on the in-memory trip — forces the Dexie fallback.
      trips: [{ tripId: "t-rejects", serviceId: "svc1", headsign: "End", departureSecs: [100] }],
    });
    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getSpy = vi.spyOn(db.gtfsTrips, "get").mockRejectedValueOnce(new Error("idb closed"));

    const patterns = await buildLinePatterns("rRejects");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].shapeId).toBeUndefined();
    expect(warn).toHaveBeenCalled();

    getSpy.mockRestore();
    warn.mockRestore();
  });

  it("leaves shapeId undefined when neither raptor nor Dexie carries one", async () => {
    await seedStops([{ id: "s1", name: "A", lat: 54.0, lon: 18.0 }]);
    const route = makeRoute({
      id: "rNoShape",
      stopIds: ["s1"],
      trips: [{ tripId: "t-1", serviceId: "svc1", headsign: "End", departureSecs: [100] }],
    });
    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("rNoShape");
    expect(patterns[0].shapeId).toBeUndefined();
  });

  it("returns empty array when all stops are missing from Dexie", async () => {
    // No stops seeded — bulkGet returns undefined for all
    const route = makeRoute({
      id: "r8",
      stopIds: ["missing1", "missing2"],
      trips: [
        { tripId: "t1", serviceId: "svc1", headsign: "Nowhere", departureSecs: [100, 200] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r8");
    expect(patterns).toEqual([]);
  });

  it("uses directionPatterns to surface return-only stops absent from canonical stopIds", async () => {
    // Reproduces the Vilnius-69 / Kernavės-g. shape: outbound stops at
    // s1→K_OUT→s3, return at s3→K_IN→s1. Canonical stopIds (longest trip)
    // is one direction only; without per-direction patterns, K_IN never
    // makes it into the rendered pattern. With them, it does.
    await seedStops([
      { id: "s1",    name: "Centras",       lat: 54.68, lon: 25.28 },
      { id: "K_OUT", name: "Kernavės out",  lat: 54.69, lon: 25.27 },
      { id: "K_IN",  name: "Kernavės in",   lat: 54.69, lon: 25.27 },
      { id: "s3",    name: "Lazdynėliai",   lat: 54.67, lon: 25.21 },
    ]);

    const route = makeRoute({
      id: "r69",
      shortName: "69",
      stopIds: ["s1", "K_OUT", "s3"],
      trips: [
        { tripId: "t-out", serviceId: "svc1", headsign: "Lazdynėliai", departureSecs: [100, 200, 300] },
        // The return trip aligns to the canonical stopIds (K_IN absent → -1
        // in the dwellSecs/canonical view), but `directionPatterns` carries
        // its real sequence.
        { tripId: "t-in",  serviceId: "svc1", headsign: "Centras",     departureSecs: [-1, -1, 400] },
      ],
      directionPatterns: [
        { key: "0", headsign: "Lazdynėliai", stopIds: ["s1", "K_OUT", "s3"] },
        { key: "1", headsign: "Centras",     stopIds: ["s3", "K_IN", "s1"] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("r69");
    expect(patterns).toHaveLength(2);

    const outbound = patterns.find((p) => p.headsign === "Lazdynėliai")!;
    const inbound = patterns.find((p) => p.headsign === "Centras")!;
    expect(outbound.stops.map((s) => s.id)).toEqual(["s1", "K_OUT", "s3"]);
    // The return-only stop K_IN is present, which is the bug fix — under
    // the legacy canonical-only path it would be filtered out.
    expect(inbound.stops.map((s) => s.id)).toEqual(["s3", "K_IN", "s1"]);
    // A pattern key alone ("0"/"1", or a headsign that reads so) is no
    // direction_id: only trips carrying one make a pattern claim it.
    expect(patterns.map((p) => "gtfsDirectionId" in p)).toEqual([false, false]);
  });

  it("falls back to canonical stopIds filtering when directionPatterns is absent (legacy bundle)", async () => {
    await seedStops([
      { id: "s1", name: "A", lat: 54.0, lon: 25.0 },
      { id: "s2", name: "B", lat: 54.1, lon: 25.1 },
    ]);

    const route = makeRoute({
      id: "rLegacy",
      stopIds: ["s1", "s2"],
      trips: [
        { tripId: "t1", serviceId: "svc1", headsign: "End", departureSecs: [100, 200] },
      ],
      // No directionPatterns — exercise the legacy fallback path.
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("rLegacy");
    expect(patterns).toHaveLength(1);
    expect(patterns[0].stops.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("uses directionId to separate equal headsigns when directionPatterns is absent", async () => {
    await seedStops([
      { id: "s1", name: "A", lat: 54.0, lon: 25.0 },
      { id: "s2", name: "B", lat: 54.1, lon: 25.1 },
    ]);
    const route = makeRoute({
      id: "rPtb",
      stopIds: ["s1", "s2"],
      trips: [
        { tripId: "out", serviceId: "svc", headsign: "Depot", directionId: 0, departureSecs: [100, 200], shapeId: "out-shape" },
        { tripId: "in", serviceId: "svc", headsign: "Depot", directionId: 1, departureSecs: [400, 300], shapeId: "in-shape" },
      ],
    });
    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("rPtb");

    expect(patterns).toHaveLength(2);
    expect(patterns.map((pattern) => pattern.shapeId)).toEqual(["out-shape", "in-shape"]);
    expect(patterns[1].stops.map((stop) => stop.id)).toEqual(["s2", "s1"]);
    expect(patterns.map((pattern) => pattern.gtfsDirectionId)).toEqual([0, 1]);
  });

  it("keeps same-headsign directions separate and selects each direction's shape", async () => {
    // Valid GTFS shape: rider-facing headsign text is the same, while
    // direction_id distinguishes the opposite timetable directions.
    await seedStops([
      { id: "s1", name: "A", lat: 54.0, lon: 25.0 },
      { id: "s2", name: "B", lat: 54.1, lon: 25.1 },
      { id: "s3", name: "C", lat: 54.2, lon: 25.2 },
    ]);

    const route = makeRoute({
      id: "rLoop",
      shortName: "69",
      stopIds: ["s1", "s2"],
      trips: [
        { tripId: "t-out", serviceId: "svc1", headsign: "Centras", directionId: 0, departureSecs: [100, 200], shapeId: "shape-out" },
        { tripId: "t-in", serviceId: "svc1", headsign: "Centras", directionId: 1, departureSecs: [300, -1], shapeId: "shape-in" },
      ],
      directionPatterns: [
        { key: "0", headsign: "Centras", stopIds: ["s1", "s2"] },
        { key: "1", headsign: "Centras", stopIds: ["s2", "s3", "s1"] },
      ],
    });

    useGtfsDataStore.setState({ raptorIndex: makeIndex([route]) });

    const patterns = await buildLinePatterns("rLoop");

    expect(reportErrorMock).not.toHaveBeenCalled();
    expect(patterns).toHaveLength(2);
    expect(patterns[0].stops.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(patterns[0].shapeId).toBe("shape-out");
    expect(patterns[1].stops.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
    expect(patterns[1].shapeId).toBe("shape-in");
    expect(patterns.map((p) => p.gtfsDirectionId)).toEqual([0, 1]);
  });
});
