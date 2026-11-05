import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../../src/db/index.ts";
import { readLegSnapshot } from "../../../src/services/legGeometry/readLegSnapshot.ts";
import type { RaptorLeg } from "@pt/shared";

const LEG: RaptorLeg = {
  type: "transit", fromStopId: "A", toStopId: "C",
  departSecs: 0, arriveSecs: 300,
  routeId: "R1", tripId: "T1",
  boardStopIdx: 0, alightStopIdx: 2,
};

describe("readLegSnapshot", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it("empty DB → all undefined", async () => {
    const snap = await readLegSnapshot(LEG);
    expect(snap).toEqual({ route: undefined, trip: undefined, shape: undefined, stops: undefined });
  });

  it("route + stops only when trip missing", async () => {
    await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
    await db.gtfsStops.bulkPut([
      { id: "A", name: "A", lat: 1, lon: 1 },
      { id: "B", name: "B", lat: 2, lon: 2 },
      { id: "C", name: "C", lat: 3, lon: 3 },
    ]);
    const snap = await readLegSnapshot(LEG);
    expect(snap.route?.id).toBe("R1");
    expect(snap.stops?.length).toBe(3);
    expect(snap.trip).toBeUndefined();
    expect(snap.shape).toBeUndefined();
  });

  it("resolves shape when trip.shapeId present", async () => {
    await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: ["A", "B", "C"] });
    await db.gtfsTrips.put({
      tripId: "T1", routeId: "R1", serviceId: "S", headsign: "",
      departureSecs: [0, 60, 120], shapeId: "SHP",
    });
    await db.gtfsShapes.put({ shapeId: "SHP", encodedPolyline: "xx", source: "gtfs" });
    const snap = await readLegSnapshot(LEG);
    expect(snap.shape?.shapeId).toBe("SHP");
  });

  // --- Phase 4B: patternStopIds geometry tests ---

  // Seed helper shared by Phase 4B tests.
  // Display route has canonical stops ["s0","s1","s2","s4"] (no s3).
  // Branch pattern has ["s0","s1","s3","s4"] (s3 is the branch stop).
  const CANONICAL_STOP_IDS = ["s0", "s1", "s2", "s4"];
  const BRANCH_PATTERN_STOP_IDS = ["s0", "s1", "s3", "s4"];

  async function seedBranchStops() {
    await db.gtfsRoutes.put({ id: "R1", shortName: "1", mode: "BUS", stopIds: CANONICAL_STOP_IDS });
    await db.gtfsStops.bulkPut([
      { id: "s0", name: "S0", lat: 1.0, lon: 1.0 },
      { id: "s1", name: "S1", lat: 1.1, lon: 1.1 },
      { id: "s2", name: "S2", lat: 1.2, lon: 1.2 },
      { id: "s3", name: "S3", lat: 1.3, lon: 1.3 }, // branch stop, absent from canonical
      { id: "s4", name: "S4", lat: 1.4, lon: 1.4 },
    ]);
  }

  it("patternStopIds present (no shape): slices branch pattern, not canonical", async () => {
    await seedBranchStops();
    // Board s0 (idx 0), alight s3 (idx 2) in branch pattern → slice ["s0","s1","s3"]
    const leg: RaptorLeg = {
      type: "transit", fromStopId: "s0", toStopId: "s3",
      departSecs: 0, arriveSecs: 300,
      routeId: "R1", tripId: "T1",
      boardStopIdx: 0, alightStopIdx: 2,
      patternStopIds: BRANCH_PATTERN_STOP_IDS,
    };
    const snap = await readLegSnapshot(leg);
    // stops must be [s0, s1, s3] — the branch sequence, NOT [s0, s1, s2]
    const ids = snap.stops?.map((s) => s?.id);
    expect(ids).toEqual(["s0", "s1", "s3"]);
  });

  it("patternStopIds present (shape decode failure): intermediate tier uses branch slice", async () => {
    await seedBranchStops();
    // Trip exists with a shapeId but the shape record is absent → shape tier
    // falls through to intermediate tier in buildTransitGeometry. readLegSnapshot
    // must still return the branch-pattern stop slice so the intermediate tier
    // can resolve the correct coords.
    await db.gtfsTrips.put({
      tripId: "T1", routeId: "R1", serviceId: "S", headsign: "",
      departureSecs: [0, 60, 120, 180], shapeId: "MISSING_SHAPE",
    });
    // Deliberately do NOT insert the shape — simulates decode failure / absent shape.
    const leg: RaptorLeg = {
      type: "transit", fromStopId: "s0", toStopId: "s3",
      departSecs: 0, arriveSecs: 300,
      routeId: "R1", tripId: "T1",
      boardStopIdx: 0, alightStopIdx: 2,
      patternStopIds: BRANCH_PATTERN_STOP_IDS,
    };
    const snap = await readLegSnapshot(leg);
    // shape must be undefined (shape record missing)
    expect(snap.shape).toBeUndefined();
    // stops must still reflect the branch pattern slice ["s0","s1","s3"]
    const ids = snap.stops?.map((s) => s?.id);
    expect(ids).toEqual(["s0", "s1", "s3"]);
  });

  it("patternStopIds absent (PatternMode Off): falls back to display route stopIds", async () => {
    await seedBranchStops();
    // Leg with no patternStopIds — legacy / PatternMode Off behaviour.
    // Board idx 0, alight idx 2 should slice canonical ["s0","s1","s2"].
    const leg: RaptorLeg = {
      type: "transit", fromStopId: "s0", toStopId: "s2",
      departSecs: 0, arriveSecs: 300,
      routeId: "R1", tripId: "T1",
      boardStopIdx: 0, alightStopIdx: 2,
      // no patternStopIds
    };
    const snap = await readLegSnapshot(leg);
    const ids = snap.stops?.map((s) => s?.id);
    expect(ids).toEqual(["s0", "s1", "s2"]);
  });
});
