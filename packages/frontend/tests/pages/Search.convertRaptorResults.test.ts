import { describe, it, expect, beforeEach } from "vitest";
import { convertRaptorResults } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import type { RtComposedItinerary } from "../../src/services/rtOverlay.ts";

const labels = { origin: "Origin", destination: "Destination" };

function composed(overrides: Partial<RtComposedItinerary>): RtComposedItinerary {
  return {
    sourceWalkSecs: 300,
    legs: [
      {
        type: "transit",
        fromStopId: "S1",
        toStopId: "S3",
        departSecs: 28800,
        arriveSecs: 30000,
        routeId: "R1",
        tripId: "T1",
        boardStopIdx: 0,
        alightStopIdx: 2,
      },
    ],
    destWalkSecs: 0,
    totalSecs: 1500,
    departureSecs: 28500,
    arrivalSecs: 30000,
    transfers: 0,
    totalWalkSecs: 300,
    ...overrides,
  };
}

describe("convertRaptorResults — first-mile walk pace", () => {
  beforeEach(async () => {
    await db.gtfsStops.clear();
    await db.gtfsStops.bulkPut([
      { id: "S1", name: "Stop A", lat: 54.68, lon: 25.28 },
      { id: "S3", name: "Stop C", lat: 54.72, lon: 25.28 },
    ]);
  });

  const convert = (results: RtComposedItinerary[]) =>
    convertRaptorResults(
      results,
      new Date(2026, 2, 30, 7, 55, 0),
      { lat: 54.676, lon: 25.28 },
      { lat: 54.72, lon: 25.28 },
      undefined,
      20260330,
      labels,
    );

  it("marks the walk to a stop only a run reaches", async () => {
    const [it] = await convert([composed({ sourceRunToCatch: true })]);
    expect(it.legs[0].mode).toBe("WALK");
    expect(it.legs[0].runToCatch).toBe(true);
  });

  it("leaves an ordinary walk unmarked", async () => {
    const [it] = await convert([composed({})]);
    expect(it.legs[0].mode).toBe("WALK");
    expect(it.legs[0].runToCatch).toBeUndefined();
  });
});

describe("convertRaptorResults — RT already in the times", () => {
  beforeEach(async () => {
    await db.gtfsStops.clear();
    await db.gtfsStops.bulkPut([
      { id: "S1", name: "Stop A", lat: 54.68, lon: 25.28 },
      { id: "S3", name: "Stop C", lat: 54.72, lon: 25.28 },
    ]);
  });

  it("carries the delay the overlay folded into a ride's times", async () => {
    const base = composed({});
    const shifted = { ...base.legs[0], departSecs: 28920, arriveSecs: 30120, appliedDelaySeconds: 120 };
    const [it] = await convertRaptorResults(
      [{ ...base, legs: [shifted] }],
      new Date(2026, 2, 30, 7, 55, 0),
      { lat: 54.676, lon: 25.28 },
      { lat: 54.72, lon: 25.28 },
      undefined,
      20260330,
      labels,
    );
    const ride = it.legs.find((l) => l.mode !== "WALK")!;
    expect(ride.appliedDelaySeconds).toBe(120);
  });
});

describe("convertRaptorResults — walking distance", () => {
  beforeEach(async () => {
    await db.gtfsStops.clear();
    await db.gtfsStops.bulkPut([
      { id: "S1", name: "Stop A", lat: 54.68, lon: 25.28 },
      { id: "S3", name: "Stop C", lat: 54.72, lon: 25.28 },
    ]);
  });

  const convert = (results: RtComposedItinerary[]) =>
    convertRaptorResults(
      results,
      new Date(2026, 2, 30, 7, 55, 0),
      { lat: 54.676, lon: 25.28 },
      { lat: 54.72, lon: 25.28 },
      undefined,
      20260330,
      labels,
    );

  it("shows the walked metres, not the seconds at 1.25 m/s", async () => {
    // 300 m at 3.5 km/h is 309 s; at 1.25 m/s that would read 386 m.
    const [it] = await convert([composed({ sourceWalkSecs: 309, totalWalkSecs: 309, totalWalkMeters: 300 })]);
    expect(it.walkingDistanceMeters).toBe(300);
  });

  it("falls back to the seconds when no distance is known", async () => {
    const [it] = await convert([composed({})]);
    expect(it.walkingDistanceMeters).toBe(375);
  });
});
