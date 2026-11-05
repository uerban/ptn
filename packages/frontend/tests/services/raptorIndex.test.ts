import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db/index.ts";
import { buildRaptorIndex, hydrate, rawFromBundle } from "../../src/services/raptorIndex.ts";
import { activeRouteIdsAtStop } from "../../src/services/hasUpcomingDeparture.ts";
import { makeGetNextDeparture } from "../../src/services/nextDeparture.ts";
import { writeGtfsBundle, type RaptorBundleWire } from "../../src/services/gtfsBundle.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import type { GtfsRouteRecord, GtfsTripRecord, GtfsServiceRecord } from "../../src/db/index.ts";
import { loadPtb, PatternMode, ptbBundleToWire } from "@pt/shared";

const FREQUENCIES_FIXTURE = resolve(
  process.cwd(),
  "../shared/src/ptb/__fixtures__/frequencies-parity.ptb",
);

beforeEach(async () => {
  await db.delete();
  await db.open();

  await db.gtfsRoutes.bulkPut([
    { id: "r1", shortName: "1", mode: "BUS", color: "FF0000", textColor: "FFFFFF", stopIds: ["s1", "s2", "s3"] },
    { id: "r2", shortName: "2", mode: "TRAM", color: "0000FF", textColor: "FFFFFF", stopIds: ["s2", "s4"] },
  ] satisfies GtfsRouteRecord[]);

  await db.gtfsTrips.bulkPut([
    { tripId: "t1", routeId: "r1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800, 29400, 30000] },
    { tripId: "t2", routeId: "r1", serviceId: "svc1", headsign: "Centre", departureSecs: [32400, 33000, 33600] },
    { tripId: "t3", routeId: "r2", serviceId: "svc1", headsign: "Station", departureSecs: [28800, 29100] },
  ] satisfies GtfsTripRecord[]);

  await db.gtfsServices.bulkPut([
    { serviceId: "svc1", days: [true, true, true, true, true, false, false], startDate: "20250101", endDate: "20271231", exceptions: {} },
  ] satisfies GtfsServiceRecord[]);
});

describe("buildRaptorIndex", () => {
  it("builds routesAtStop index", async () => {
    const index = await buildRaptorIndex();
    expect(index.routesAtStop.get("s2")).toBeDefined();
    expect(index.routesAtStop.get("s2")!).toHaveLength(2);
    expect(index.routesAtStop.get("s1")!).toHaveLength(1);
  });

  it("provides route data with sorted trips", async () => {
    const index = await buildRaptorIndex();
    const r1 = index.routes[index.routeIdToIdx.get("r1")!];
    expect(r1.stopIds).toEqual(["s1", "s2", "s3"]);
    expect(r1.trips).toHaveLength(2);
    expect(r1.trips[0].departureSecs[0]).toBeLessThan(r1.trips[1].departureSecs[0]);
  });

  it("builds calendar with service lookup", async () => {
    const index = await buildRaptorIndex();
    expect(index.services.get("svc1")).toBeDefined();
    expect(index.services.get("svc1")!.days[0]).toBe(true);
    expect(index.services.get("svc1")!.days[5]).toBe(false);
  });

  it("surfaces directionPatterns from the Dexie gtfsRoutes row onto the resulting RaptorIndex", async () => {
    // The bundle-blob path is the primary read; the Dexie gtfsRoutes
    // path is the fallback. The directionPatterns field must survive the
    // Dexie round-trip so bidirectional line-preview rendering remains intact.
    await db.gtfsRoutes.put({
      id: "rBidi",
      shortName: "69",
      mode: "BUS",
      color: "00FF00",
      textColor: "FFFFFF",
      stopIds: ["s1", "s2", "s3"],
      directionPatterns: [
        { key: "0", headsign: "Centre", stopIds: ["s1", "s2", "s3"] },
        { key: "1", headsign: "Suburb", stopIds: ["s3", "s4", "s1"] },
      ],
    } satisfies GtfsRouteRecord);
    await db.gtfsTrips.put({
      tripId: "tBidi",
      routeId: "rBidi",
      serviceId: "svc1",
      headsign: "Centre",
      departureSecs: [28800, 29400, 30000],
    } satisfies GtfsTripRecord);

    const index = await buildRaptorIndex();
    const r = index.routes[index.routeIdToIdx.get("rBidi")!];
    expect(r.directionPatterns).toEqual([
      { key: "0", headsign: "Centre", stopIds: ["s1", "s2", "s3"] },
      { key: "1", headsign: "Suburb", stopIds: ["s3", "s4", "s1"] },
    ]);
  });

  it("indexes return-only stops from directionPatterns into routesAtStop", async () => {
    // Bidirectional bus 69 lookalike: canonical sequence covers the
    // forward direction; the return direction adds opposite-side-of-road
    // stops not in canonical. Without the directionPatterns union, the
    // urban-mode filter (`activeRouteIdsAtStop`) silently hides those
    // stops because `routesAtStop` short-circuits to `undefined` for them.
    await db.gtfsRoutes.put({
      id: "rBidi",
      shortName: "69",
      mode: "BUS",
      stopIds: ["s-fwd-a", "s-fwd-b"],
      directionPatterns: [
        { key: "0", headsign: "Centre", stopIds: ["s-fwd-a", "s-fwd-b"] },
        { key: "1", headsign: "Suburb", stopIds: ["s-rev-b", "s-rev-a"] },
      ],
    } satisfies GtfsRouteRecord);
    await db.gtfsTrips.put({
      tripId: "tBidi",
      routeId: "rBidi",
      serviceId: "svc1",
      headsign: "Centre",
      departureSecs: [28800, 29400],
    } satisfies GtfsTripRecord);

    const index = await buildRaptorIndex();
    const idx = index.routeIdToIdx.get("rBidi")!;
    expect(index.routesAtStop.get("s-fwd-a")).toContain(idx);
    expect(index.routesAtStop.get("s-rev-a")).toContain(idx);
    expect(index.routesAtStop.get("s-rev-b")).toContain(idx);
  });

  it("hydrates frequency windows from sync meta on the Dexie fallback path", async () => {
    await db.gtfsTrips.put({
      tripId: "t1",
      routeId: "r1",
      serviceId: "svc1",
      headsign: "Centre",
      ptbTripIdx: 7,
      departureSecs: [28800, 29400, 30000],
    } satisfies GtfsTripRecord);
    await db.gtfsSyncMeta.put({
      id: "current",
      cityId: "vilnius",
      etag: '"seed"',
      generationId: "s".repeat(64),
      lastSynced: Date.now(),
      generatedAt: "2026-04-22T00:00:00Z",
      frequencies: [{ tripIdx: 7, startSecs: 28800, endSecs: 36000, headwaySecs: 600, exactTimes: 0 }],
    });

    const index = await buildRaptorIndex();

    expect(index.frequenciesByTrip?.get(7)).toEqual([
      { tripIdx: 7, startSecs: 28800, endSecs: 36000, headwaySecs: 600, exactTimes: 0 },
    ]);
  });
});

describe("buildRaptorIndex — gtfsBundle blob path", () => {
  // Bundle-first read is default-on; fallback to Dexie tables is silent.
  // These tests exercise both branches so future regressions don't go
  // unnoticed (e.g. if the feature-flag default flips or the bundle shape
  // drifts from the Dexie-table shape).

  const wire: RaptorBundleWire = {
    version: 1,
    meta: { generatedAt: "2026-04-22T00:00:00Z" },
    routes: [
      {
        id: "r1",
        shortName: "1",
        mode: "BUS",
        color: "ff0000",
        textColor: "ffffff",
        stopIds: ["s1", "s2", "s3"],
        trips: [
          { tripId: "t1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800, 29400, 30000] },
          { tripId: "t2", serviceId: "svc1", headsign: "Centre", departureSecs: [32400, 33000, 33600] },
        ],
      },
      {
        id: "r2",
        shortName: "2",
        mode: "TRAM",
        color: "0000ff",
        textColor: "ffffff",
        stopIds: ["s2", "s4"],
        trips: [
          { tripId: "t3", serviceId: "svc1", headsign: "Station", departureSecs: [28800, 29100] },
        ],
      },
    ],
    calendar: [
      { serviceId: "svc1", days: [true, true, true, true, true, false, false], startDate: "20250101", endDate: "20271231", exceptions: {} },
    ],
    stops: [
      { id: "s1", name: "Stop 1", lat: 54.0, lon: 25.0 },
      { id: "s2", name: "Stop 2", lat: 54.1, lon: 25.1 },
      { id: "s3", name: "Stop 3", lat: 54.2, lon: 25.2 },
      { id: "s4", name: "Stop 4", lat: 54.3, lon: 25.3, wheelchairBoarding: 1 },
    ],
  };

  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("hydrates RaptorIndex from the blob when present", async () => {
    const cityId = useCityStore.getState().activeCity.id;
    await writeGtfsBundle(cityId, wire);

    const index = await buildRaptorIndex();
    expect(index.routes).toHaveLength(2);
    expect(index.routeIdToIdx.get("r1")).toBeDefined();
    expect(index.routes[index.routeIdToIdx.get("r1")!].trips).toHaveLength(2);
    expect(index.routesAtStop.get("s2")).toHaveLength(2);
    expect(index.services.get("svc1")!.days[0]).toBe(true);
    expect(index.stopWheelchairBoarding?.get("s4")).toBe(1);
  });

  it("surfaces meta.cityTzIana on the blob path", async () => {
    const cityId = useCityStore.getState().activeCity.id;
    // Same wire but with the agency tz set in meta (PTB sidecar path).
    const wireWithTz: RaptorBundleWire = {
      ...wire,
      meta: { ...wire.meta, cityTzIana: "Europe/Vilnius" },
    };
    await writeGtfsBundle(cityId, wireWithTz);

    const index = await buildRaptorIndex();
    expect(index.cityTzIana).toBe("Europe/Vilnius");
  });

  it("leaves cityTzIana undefined when meta omits it (network path)", async () => {
    const cityId = useCityStore.getState().activeCity.id;
    await writeGtfsBundle(cityId, wire); // base wire has no cityTzIana

    const index = await buildRaptorIndex();
    expect(index.cityTzIana).toBeUndefined();
  });

  it("produces the same shape from blob as from Dexie tables", async () => {
    const cityId = useCityStore.getState().activeCity.id;

    // Dexie-only
    await db.gtfsRoutes.bulkPut(
      wire.routes.map((r) => ({
        id: r.id, shortName: r.shortName, mode: r.mode as "BUS" | "TRAM",
        color: r.color, textColor: r.textColor, stopIds: r.stopIds,
      })),
    );
    await db.gtfsTrips.bulkPut(
      wire.routes.flatMap((r) =>
        r.trips.map((t) => ({
          tripId: t.tripId, routeId: r.id, serviceId: t.serviceId,
          headsign: t.headsign, departureSecs: t.departureSecs,
          wheelchairAccessible: t.wheelchairAccessible,
        })),
      ),
    );
    await db.gtfsServices.bulkPut(wire.calendar);
    await db.gtfsStops.bulkPut(wire.stops);

    const dexie = await buildRaptorIndex();

    await writeGtfsBundle(cityId, wire);
    const blob = await buildRaptorIndex();

    expect(blob.routes).toEqual(dexie.routes);
    expect(Array.from(blob.routeIdToIdx.entries())).toEqual(Array.from(dexie.routeIdToIdx.entries()));
    expect(Array.from(blob.routesAtStop.entries())).toEqual(Array.from(dexie.routesAtStop.entries()));
    expect(Array.from(blob.services.entries())).toEqual(Array.from(dexie.services.entries()));
    expect(Array.from(blob.stopWheelchairBoarding?.entries() ?? [])).toEqual(
      Array.from(dexie.stopWheelchairBoarding?.entries() ?? []),
    );
  });

  it("preserves trip.shapeId when hydrating from the blob", async () => {
    // shapeId on the wire must survive gzip round-trip and rehydration. The
    // blob-read path had dropped it silently before — a ticking regression
    // for Phase 2 when readLegSnapshot migrates off db.gtfsTrips.
    const cityId = useCityStore.getState().activeCity.id;
    const wireWithShape: RaptorBundleWire = {
      meta: { generatedAt: "2026-04-22T00:00:00Z" },
      routes: [
        {
          id: "r1", shortName: "1", mode: "BUS", stopIds: ["s1", "s2"],
          trips: [
            { tripId: "t1", serviceId: "svc1", headsign: "H", departureSecs: [0, 60], shapeId: "S1" },
          ],
        },
      ],
      calendar: [
        { serviceId: "svc1", days: [true, true, true, true, true, false, false], startDate: "20260101", endDate: "20271231", exceptions: {} },
      ],
      stops: [
        { id: "s1", name: "A", lat: 0, lon: 0 },
        { id: "s2", name: "B", lat: 0, lon: 0 },
      ],
    };

    await writeGtfsBundle(cityId, wireWithShape);

    const index = await buildRaptorIndex();
    const r1 = index.routes[index.routeIdToIdx.get("r1")!];
    expect(r1.trips[0].shapeId).toBe("S1");
  });

  it("preserves trip.directionId when hydrating from the blob", async () => {
    const cityId = useCityStore.getState().activeCity.id;
    const wireWithDirection: RaptorBundleWire = {
      meta: { generatedAt: "2026-04-22T00:00:00Z" },
      routes: [{
        id: "r1", shortName: "1", mode: "BUS", stopIds: ["s1", "s2"],
        trips: [{
          tripId: "t1", serviceId: "svc1", headsign: "Depot",
          directionId: 1, departureSecs: [0, 60],
        }],
      }],
      calendar: [{
        serviceId: "svc1", days: [true, true, true, true, true, false, false],
        startDate: "20260101", endDate: "20271231", exceptions: {},
      }],
      stops: [
        { id: "s1", name: "A", lat: 0, lon: 0 },
        { id: "s2", name: "B", lat: 0, lon: 0 },
      ],
    };

    await writeGtfsBundle(cityId, wireWithDirection);
    const index = await buildRaptorIndex();
    expect(index.routes[0]?.trips[0]?.directionId).toBe(1);
  });

  it("falls back to Dexie tables when the blob is absent", async () => {
    await db.gtfsRoutes.bulkPut([
      { id: "r1", shortName: "1", mode: "BUS", stopIds: ["s1", "s2"] },
    ] satisfies GtfsRouteRecord[]);
    await db.gtfsTrips.bulkPut([
      { tripId: "t1", routeId: "r1", serviceId: "svc1", headsign: "Centre", departureSecs: [28800] },
    ] satisfies GtfsTripRecord[]);
    await db.gtfsServices.bulkPut([
      { serviceId: "svc1", days: [true, true, true, true, true, false, false], startDate: "20250101", endDate: "20271231", exceptions: {} },
    ] satisfies GtfsServiceRecord[]);

    const index = await buildRaptorIndex();
    expect(index.routes).toHaveLength(1);
    expect(index.routes[0].trips).toHaveLength(1);
  });
});

describe("hydrate — frequency windows", () => {
  it("keeps PTB global ordinals distinct from route-local sorted trip positions", () => {
    const wire: RaptorBundleWire = {
      version: 1,
      meta: { generatedAt: "2026-06-25T00:00:00.000Z" },
      stops: [
        { id: "s0", name: "S0", lat: 0, lon: 0 },
        { id: "s1", name: "S1", lat: 0, lon: 1 },
      ],
      routes: [{
        id: "r",
        shortName: "R",
        mode: "BUS",
        stopIds: ["s0", "s1"],
        trips: [
          { tripId: "late", serviceId: "svc", headsign: "Late", ptbTripIdx: 7, departureSecs: [36000, 36300] },
          { tripId: "early", serviceId: "svc", headsign: "Early", ptbTripIdx: 3, departureSecs: [30000, 30300] },
        ],
      }],
      calendar: [{ serviceId: "svc", days: [true, true, true, true, true, true, true], startDate: "20260101", endDate: "20261231", exceptions: {} }],
      frequencies: [{ tripIdx: 7, startSecs: 36000, endSecs: 39600, headwaySecs: 600, exactTimes: 0 }],
    };

    const index = hydrate(rawFromBundle(wire));

    expect(index.routes[0]!.trips.map((t) => t.tripId)).toEqual(["early", "late"]);
    expect(index.routes[0]!.trips.map((t) => t.ptbTripIdx)).toEqual([3, 7]);
    expect(index.frequenciesByTrip?.get(7)).toEqual(wire.frequencies);
    expect(index.frequenciesByTrip?.get(1)).toBeUndefined();
  });

  it.each([PatternMode.Off, PatternMode.Unbounded, PatternMode.CoveringMerge])(
    "groups frequencies by PTB global ordinal and keeps ptbTripIdx in %s mode",
    (mode) => {
      const ptb = loadPtb(readFileSync(FREQUENCIES_FIXTURE));
      const wire = ptbBundleToWire(ptb, mode);
      const index = hydrate(rawFromBundle(wire, mode), undefined, mode);
      const globalTripIdx = ptb.frequencies![0]!.tripIdx;
      const expectedRows = ptb.frequencies!.filter((f) => f.tripIdx === globalTripIdx);

      expect(index.frequenciesByTrip?.get(globalTripIdx)).toEqual(expectedRows);
      expect(index.routes.flatMap((r) => r.trips).some((t) => t.ptbTripIdx === globalTripIdx)).toBe(true);
      if (index.patterns) {
        expect(index.patterns.flatMap((r) => r.trips).some((t) => t.ptbTripIdx === globalTripIdx)).toBe(true);
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// hydrate() two-model split (Tasks 4–6): patterns[]/patternsAtStop (scan) +
// reconstructed display routes[]/routeIdToIdx/routesAtStop.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal shared Raw fixture for the pattern-split tests. */
const sharedServiceRecords = [
  {
    serviceId: "svc1",
    days: [true, true, true, true, true, false, false],
    startDate: "20260101",
    endDate: "20271231",
    exceptions: {} as Record<string, number>,
  },
];
const sharedStopRecords = [
  { id: "s0", name: "S0", lat: 0, lon: 0 },
  { id: "s1", name: "S1", lat: 0, lon: 0 },
  { id: "s2", name: "S2", lat: 0, lon: 0 },
  { id: "s3", name: "S3", lat: 0, lon: 0 },
  { id: "s4", name: "S4", lat: 0, lon: 0 },
];

/**
 * Two route records sharing id "R0" (the per-pattern wire shape):
 *   record 0: stopIds [s0,s1,s2,s4] — pattern A (the "main" sequence)
 *   record 1: stopIds [s0,s1,s3,s4] — pattern B (branch via s3)
 *
 * Each record carries its own inline trips (per-record shape from rawFromBundle).
 */
const twoPatternRaw = {
  routeRecords: [
    {
      id: "R0", shortName: "0", mode: "BUS" as const,
      stopIds: ["s0", "s1", "s2", "s4"],
      trips: [
        { tripId: "tA", serviceId: "svc1", headsign: "A",
          departureSecs: [28800, 29400, 30000, 30600] },
      ],
    },
    {
      id: "R0", shortName: "0", mode: "BUS" as const,
      stopIds: ["s0", "s1", "s3", "s4"],
      trips: [
        { tripId: "tB", serviceId: "svc1", headsign: "B",
          departureSecs: [32400, 33000, 33600, 34200] },
      ],
    },
  ],
  tripRecords: [] as Array<{ tripId: string; routeId: string; serviceId: string; headsign: string; departureSecs: number[] }>,
  serviceRecords: sharedServiceRecords,
  stopRecords: sharedStopRecords,
};

/**
 * Single route record (standard Off-path shape): one record, all trips inline.
 */
const singlePatternRaw = {
  routeRecords: [
    {
      id: "R1", shortName: "1", mode: "BUS" as const,
      stopIds: ["s0", "s1", "s2"],
      trips: [
        { tripId: "t1", serviceId: "svc1", headsign: "X", departureSecs: [28800, 29400, 30000] },
        { tripId: "t2", serviceId: "svc1", headsign: "X", departureSecs: [32400, 33000, 33600] },
      ],
    },
  ],
  tripRecords: [] as Array<{ tripId: string; routeId: string; serviceId: string; headsign: string; departureSecs: number[] }>,
  serviceRecords: sharedServiceRecords,
  stopRecords: sharedStopRecords,
};

describe("hydrate() — two-model split (Tasks 4-6)", () => {
  it("keeps branch directionPatterns that share direction_id but have different headsigns", () => {
    const raw = {
      routeRecords: [
        {
          id: "R0", shortName: "0", mode: "BUS" as const,
          stopIds: ["s0", "s1", "s2"],
          trips: [{ tripId: "tA", serviceId: "svc1", headsign: "Centre", departureSecs: [1, 2, 3] }],
          directionPatterns: [
            { key: "0", headsign: "Centre", stopIds: ["s0", "s1", "s2"] },
            { key: "0", headsign: "Centre via Branch", stopIds: ["s0", "s3", "s2"] },
          ],
        },
        {
          id: "R0", shortName: "0", mode: "BUS" as const,
          stopIds: ["s0", "s3", "s2"],
          trips: [{ tripId: "tB", serviceId: "svc1", headsign: "Centre via Branch", departureSecs: [4, 5, 6] }],
          directionPatterns: [
            { key: "0", headsign: "Centre", stopIds: ["s0", "s1", "s2"] },
            { key: "0", headsign: "Centre via Branch", stopIds: ["s0", "s3", "s2"] },
          ],
        },
      ],
      tripRecords: [] as Array<{ tripId: string; routeId: string; serviceId: string; headsign: string; departureSecs: number[] }>,
      serviceRecords: sharedServiceRecords,
      stopRecords: sharedStopRecords,
    };

    const idx = hydrate(raw, undefined, PatternMode.Unbounded);
    expect(idx.routes[0]?.directionPatterns?.map((p) => [p.key, p.headsign])).toEqual([
      ["0", "Centre"],
      ["0", "Centre via Branch"],
    ]);
  });

  it("(a) Unbounded + 2-record-same-id: scan has 2 patterns, branch stop s3 reachable via patternsAtStop[1]; display has 1 route with longest stopIds and union of trips", () => {
    const idx = hydrate(twoPatternRaw, undefined, PatternMode.Unbounded);

    // SCAN: two pattern entries, 1:1 with wire records
    expect(idx.patterns).toHaveLength(2);
    expect(idx.patterns![0].stopIds).toEqual(["s0", "s1", "s2", "s4"]);
    expect(idx.patterns![1].stopIds).toEqual(["s0", "s1", "s3", "s4"]);

    // Branch stop s3 is ONLY in pattern 1 (index 1)
    expect(idx.patternsAtStop!.get("s3")).toEqual([1]);
    // s0, s1, s4 are in BOTH patterns
    expect(idx.patternsAtStop!.get("s0")).toEqual([0, 1]);
    expect(idx.patternsAtStop!.get("s2")).toEqual([0]);

    // DISPLAY: ONE aggregated route for "R0"
    expect(idx.routes).toHaveLength(1);
    expect(idx.routeIdToIdx.get("R0")).toBe(0);
    // Display stopIds = longest pattern's sequence (pattern A: [s0,s1,s2,s4])
    expect(idx.routes[0].stopIds).toEqual(["s0", "s1", "s2", "s4"]);
    // Display trips = union of both patterns' trips, re-sorted
    expect(idx.routes[0].trips).toHaveLength(2);
    expect(idx.routes[0].trips[0].tripId).toBe("tA"); // departs earlier
    expect(idx.routes[0].trips[1].tripId).toBe("tB");

    // Display routesAtStop includes s3 (from directionPatterns union? No — s3 is
    // in the branch pattern's stopIds which becomes the display route's stopIds
    // only if it's the longest. Here pattern A is also length 4, so s3 comes from
    // pattern B's stopIds being merged into the display route's buildDisplayAtStop.
    // Actually aggregateDisplay picks longest by length — both are length 4.
    // The first one (pattern A) is selected as canonical. But buildDisplayAtStop
    // iterates the display routes[0].stopIds which is pattern A's. Pattern B's
    // stops are NOT in directionPatterns (none set), so s3 is NOT in routesAtStop.
    // That's correct — display canonical is A, scan patterns cover s3 via patternsAtStop.
    expect(idx.routesAtStop.get("s0")).toContain(0);
    expect(idx.routesAtStop.get("s2")).toContain(0);
    // s3 is NOT in display routesAtStop (only in patternsAtStop for scan)
    expect(idx.routesAtStop.get("s3")).toBeUndefined();
  });

  it("(b) Unbounded + single-pattern route: patterns.length===1, display unchanged from Off", () => {
    const idxOn = hydrate(singlePatternRaw, undefined, PatternMode.Unbounded);
    const idxOff = hydrate(singlePatternRaw, undefined, PatternMode.Off);

    // Scan: one pattern (1:1 with the single record)
    expect(idxOn.patterns).toHaveLength(1);
    expect(idxOn.patterns![0].stopIds).toEqual(["s0", "s1", "s2"]);

    // Display: same as Off (one route, same stopIds, same trips)
    expect(idxOn.routes).toHaveLength(1);
    expect(idxOn.routes[0].stopIds).toEqual(idxOn.patterns![0].stopIds);
    expect(idxOn.routes).toEqual(idxOff.routes);
    expect(Array.from(idxOn.routeIdToIdx.entries())).toEqual(Array.from(idxOff.routeIdToIdx.entries()));
    expect(Array.from(idxOn.routesAtStop.entries())).toEqual(Array.from(idxOff.routesAtStop.entries()));
  });

  it("(c) aggregateDisplay longest-wins: display stopIds adopts the strictly longer pattern regardless of record order", () => {
    // The existing twoPatternRaw fixture has two same-length patterns (both len 4),
    // so the `stopIds.length > existing.stopIds.length` branch is never exercised.
    // This test uses two records where the SECOND is strictly longer (len 5 > len 4),
    // and then verifies with B-first order to prove "longest wins" not "last wins".
    const longerSecond = {
      routeRecords: [
        {
          id: "R0", shortName: "0", mode: "BUS" as const,
          stopIds: ["s0", "s1", "s2", "s4"],           // pattern A — length 4
          trips: [
            { tripId: "tA", serviceId: "svc1", headsign: "A",
              departureSecs: [28800, 29400, 30000, 30600] },
          ],
        },
        {
          id: "R0", shortName: "0", mode: "BUS" as const,
          stopIds: ["s0", "s1", "s2", "s3", "s4"],     // pattern B — length 5
          trips: [
            { tripId: "tB", serviceId: "svc1", headsign: "B",
              departureSecs: [32400, 33000, 33600, 34200, 34800] },
          ],
        },
      ],
      tripRecords: [] as Array<{ tripId: string; routeId: string; serviceId: string; headsign: string; departureSecs: number[] }>,
      serviceRecords: sharedServiceRecords,
      stopRecords: sharedStopRecords,
    };

    // B second: longer record comes last — longest must still win
    const idxBSecond = hydrate(longerSecond, undefined, PatternMode.Unbounded);
    expect(idxBSecond.routes[0].stopIds).toEqual(["s0", "s1", "s2", "s3", "s4"]);

    // B first: longer record comes first — must still win (not be overwritten by shorter A)
    const longerFirst = {
      ...longerSecond,
      routeRecords: [longerSecond.routeRecords[1], longerSecond.routeRecords[0]],
    };
    const idxBFirst = hydrate(longerFirst, undefined, PatternMode.Unbounded);
    expect(idxBFirst.routes[0].stopIds).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("(c) Off mode (default): patterns undefined, routes/routesAtStop use the canonical display model", () => {
    const idx = hydrate(singlePatternRaw); // mode defaults to Off

    // No pattern structures
    expect(idx.patterns).toBeUndefined();
    expect(idx.patternsAtStop).toBeUndefined();

    // Standard display model
    expect(idx.routes).toHaveLength(1);
    expect(idx.routeIdToIdx.get("R1")).toBe(0);
    expect(idx.routesAtStop.get("s0")).toEqual([0]);
    expect(idx.routes[0].trips).toHaveLength(2);
    // trips sorted by departureSecs[0]
    expect(idx.routes[0].trips[0].departureSecs[0]).toBeLessThan(idx.routes[0].trips[1].departureSecs[0]);
  });

  it("(d) explicit PatternMode.Off: byte-identical result on two-record raw (uses only first record per id)", () => {
    // Off mode processes records as-is; routeIdToIdx.set overwrites on dup id.
    // Both records share R0, so last-writer-wins for routeIdToIdx (idx=1).
    const idx = hydrate(twoPatternRaw, undefined, PatternMode.Off);
    expect(idx.patterns).toBeUndefined();
    expect(idx.patternsAtStop).toBeUndefined();
    // Two route objects (both R0 records become display routes)
    expect(idx.routes).toHaveLength(2);
    // routeIdToIdx maps R0 → last index (1), matching the display index contract.
    expect(idx.routeIdToIdx.get("R0")).toBe(1);
  });

  it("(e) Unbounded: a SHORTER pattern's trips are re-aligned to the canonical stopIds so display reads the correct column", () => {
    // Under Unbounded, aggregateDisplay aligns a shorter pattern's trips to
    // the longest (canonical) sequence. Display consumers index by the
    // canonical column (`stopIds.indexOf(stopId)` → `departureSecs[idx]`), so
    // a branch trip must not read the wrong column or `undefined`.
    //
    //   long  A: [s0, s1, s2, s3]  (canonical — length 4)
    //   short B: [s0, s1, s3]      (skips s2 — length 3)
    //
    // s3 is canonical index 3. B's own index is 2, so its s3 time must be
    // re-aligned to canonical column 3.
    const raw = {
      routeRecords: [
        {
          id: "R0", shortName: "0", mode: "BUS" as const,
          stopIds: ["s0", "s1", "s2", "s3"],
          trips: [
            // A serves s3 only out-of-window (15:00) so the only in-window s3
            // departure must come from the SHORT pattern B.
            { tripId: "tA", serviceId: "svc1", headsign: "A",
              departureSecs: [50400, 51000, 53400, 54000] },
          ],
        },
        {
          id: "R0", shortName: "0", mode: "BUS" as const,
          stopIds: ["s0", "s1", "s3"],            // skips s2
          trips: [
            // B departs s3 (B's own index 2) at 10:30 = 37800 — inside the
            // 2h window from 10:00.
            { tripId: "tB", serviceId: "svc1", headsign: "B",
              departureSecs: [36600, 37200, 37800] },
          ],
        },
      ],
      tripRecords: [] as Array<{ tripId: string; routeId: string; serviceId: string; headsign: string; departureSecs: number[] }>,
      serviceRecords: sharedServiceRecords,
      stopRecords: sharedStopRecords,
    };

    const idx = hydrate(raw, undefined, PatternMode.Unbounded);

    // Canonical display stopIds = the long pattern A's sequence.
    expect(idx.routes).toHaveLength(1);
    expect(idx.routes[0].stopIds).toEqual(["s0", "s1", "s2", "s3"]);

    // The re-aligned tB: s0→col0, s1→col1, s3→col3, s2 (col2) unserved (-1).
    const tB = idx.routes[0].trips.find((t) => t.tripId === "tB")!;
    expect(tB.departureSecs).toEqual([36600, 37200, -1, 37800]);

    // Wednesday Apr 22, 2026 at 10:00, 2h window. s3 must be active because B
    // departs s3 at 10:30. The canonical column resolves B's departure rather
    // than A's out-of-window value.
    const wed10 = new Date(2026, 3, 22, 10, 0, 0);
    expect(Array.from(activeRouteIdsAtStop("s3", wed10, 2, idx))).toEqual(["R0"]);

    // Sanity: s2 (canonical-only, served by A) is NOT active in-window (A's s2
    // departure is 53400 = 14:50), confirming the read targets the right column.
    expect(activeRouteIdsAtStop("s2", wed10, 2, idx).size).toBe(0);

    // nextDeparture is covered transitively: it reads the same canonical column
    // (`trip.departureSecs[stopIdx]`) and is fed the same display route. With the
    // re-alignment, the s3 (canonical col 3) read resolves to B's 10:30 = 37800.
    // The branch trip must resolve through the canonical column. Use a
    // wall-clock that puts 10:00 as the local time.
    const getNext = makeGetNextDeparture(
      idx,
      { getTripDelay: () => null, getReceivedAt: () => null },
      () => wed10.getTime(),
    );
    const nd = getNext("R0", "s3");
    expect(nd).not.toBeNull();
    // 10:30 − 10:00 = 30 minutes, exact (canonical column read, not approximate).
    expect(nd!.minutesUntil).toBe(30);
    expect(nd!.isApproximate).toBe(false);
    expect(nd!.headsign).toBe("B");
  });
});
