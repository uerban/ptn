import { describe, it, expect } from "vitest";
import type { Departure, LatLon } from "@pt/shared";
import {
  ANY_DIR,
  assignDeparturesToSides,
  oppositePatterns,
  patternDirKeys,
  resolveNearbySides,
  reverseStopFor,
  routeSidesAt,
  type NearbyDirectionsInput,
  type ReverseStopContext,
  type Row,
  type Side,
} from "./nearbyDirections.ts";
import type { RaptorIndexRoute } from "./raptorIndex.ts";
import type { StopForGrouping } from "./stopGrouping.ts";
import { pattern, patternIndex, type TripSpec } from "../test-helpers/patternIndex.ts";

describe("patternDirKeys", () => {
  it("keys a pattern by the direction_id its trips carry", () => {
    const index = patternIndex([
      pattern("1", ["A", "S", "B"], [
        { tripId: "t1", headsign: "Centre", directionId: 0 },
        { tripId: "t2", headsign: "Centre", directionId: 0 },
      ]),
      pattern("1", ["B2", "S2", "A2"], [{ tripId: "t3", headsign: "Airport", directionId: 1 }]),
    ]);
    const keys = patternDirKeys(index);
    expect(keys.byPattern.get(0)).toBe("d0");
    expect(keys.byPattern.get(1)).toBe("d1");
    expect(keys.byTrip.get("t1")).toBe("d0");
    expect(keys.byTrip.get("t2")).toBe("d0");
    expect(keys.byTrip.get("t3")).toBe("d1");
  });

  it("falls back to the headsign when no trip carries a direction_id", () => {
    const index = patternIndex([
      pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre" }]),
      pattern("1", ["B2", "S2", "A2"], [{ tripId: "t2", headsign: "Airport" }]),
    ]);
    const keys = patternDirKeys(index);
    expect(keys.byPattern.get(0)).toBe("h:Centre");
    expect(keys.byPattern.get(1)).toBe("h:Airport");
    expect(keys.byTrip.get("t2")).toBe("h:Airport");
  });

  it("a CoveringMerge folded trip without direction_id inherits its pattern's d0", () => {
    // Mirrors covering-merge.ptb under CoveringMerge: the short T0 folds into
    // T1's pattern at offset 1 (holes at positions 0 and 4) and the wire
    // converter drops its direction_id on that branch.
    const index = patternIndex([
      pattern("R", ["s0", "s1", "s2", "s3", "s4"], [
        { tripId: "T0", headsign: "Short turn", departureSecs: [-1, 1000, 1300, 1600, -1] },
        { tripId: "T1", headsign: "Terminal", directionId: 0, departureSecs: [2000, 2300, 2600, 2900, 3200] },
      ]),
    ]);
    const keys = patternDirKeys(index);
    expect(keys.byPattern.get(0)).toBe("d0");
    expect(keys.byTrip.get("T0")).toBe("d0");
    expect(keys.byTrip.get("T1")).toBe("d0");
  });

  it("conflicting direction_ids fall back to the headsign of the pattern's offset-0 trips", () => {
    const folded = (tripId: string): TripSpec => ({
      tripId, headsign: "Depot", departureSecs: [-1, 30000, 30120],
    });
    const index = patternIndex([
      pattern("7", ["A", "S", "B"], [
        { tripId: "t1", headsign: "Centre", directionId: 0 },
        { tripId: "t2", headsign: "Centre", directionId: 1 },
        // More numerous, but folded (they do not serve position 0): ignored.
        folded("f1"), folded("f2"), folded("f3"),
      ]),
    ]);
    const keys = patternDirKeys(index);
    expect(keys.byPattern.get(0)).toBe("h:Centre");
    expect(keys.byTrip.get("t2")).toBe("h:Centre");
    expect(keys.byTrip.get("f1")).toBe("h:Centre");
  });

  it("with no trip serving position 0, the headsign comes from every trip", () => {
    const folded = (tripId: string, headsign: string): TripSpec => ({
      tripId, headsign, departureSecs: [-1, 30000, 30120],
    });
    const index = patternIndex([
      pattern("7", ["A", "S", "B"], [folded("f1", "Centre"), folded("f2", "Depot"), folded("f3", "Depot")]),
    ]);
    expect(patternDirKeys(index).byPattern.get(0)).toBe("h:Depot");
  });

  it("a headsign tie breaks alphabetically, whatever the order of the trips", () => {
    const zoo: TripSpec = { tripId: "z", headsign: "Zoo" };
    const airport: TripSpec = { tripId: "a", headsign: "Airport" };
    const keyOf = (trips: TripSpec[]) => patternDirKeys(patternIndex([pattern("7", ["A", "S"], trips)])).byPattern.get(0);
    expect(keyOf([zoo, airport])).toBe("h:Airport");
    expect(keyOf([airport, zoo])).toBe("h:Airport");
  });

  it("is memoised per index", () => {
    const patterns = [pattern("1", ["A", "S"], [{ tripId: "t1", headsign: "X", directionId: 0 }])];
    const index = patternIndex(patterns);
    expect(patternDirKeys(index)).toBe(patternDirKeys(index));
    expect(patternDirKeys(patternIndex([...patterns]))).not.toBe(patternDirKeys(index));
  });

  it("patterns absent (PatternMode Off / Dexie fallback) → empty maps", () => {
    const keys = patternDirKeys({});
    expect(keys.byPattern.size).toBe(0);
    expect(keys.byTrip.size).toBe(0);
  });
});

describe("oppositePatterns", () => {
  it("returns the route's patterns with the other direction_id", () => {
    const index = patternIndex([
      pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre", directionId: 0 }]),
      pattern("1", ["B2", "S2", "A2"], [{ tripId: "t2", headsign: "Airport", directionId: 1 }]),
      // Branch of the same direction.
      pattern("1", ["A", "S", "C"], [{ tripId: "t3", headsign: "Centre via C", directionId: 0 }]),
      pattern("2", ["B2", "S2"], [{ tripId: "t4", headsign: "Airport", directionId: 1 }]),
    ]);
    expect(oppositePatterns(index, "1", "d0", "S")).toEqual([1]);
    expect(oppositePatterns(index, "1", "d1", "S2")).toEqual([0, 2]);
  });

  it("direction_id is authoritative: an opposite pattern through S still counts", () => {
    // Terminus: both directions serve S.
    const index = patternIndex([
      pattern("1", ["S", "A", "B"], [{ tripId: "t1", headsign: "B", directionId: 0 }]),
      pattern("1", ["B", "A", "S"], [{ tripId: "t2", headsign: "S", directionId: 1 }]),
    ]);
    expect(oppositePatterns(index, "1", "d0", "S")).toEqual([1]);
  });

  it("a headsign-keyed opposite must not pass through S", () => {
    const index = patternIndex([
      pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre" }]),
      // Different headsign, but through S: a branch, not the other side.
      pattern("1", ["A", "S", "C"], [{ tripId: "t2", headsign: "Centre via C" }]),
      pattern("1", ["B2", "S2", "A2"], [{ tripId: "t3", headsign: "Airport" }]),
    ]);
    expect(oppositePatterns(index, "1", "h:Centre", "S")).toEqual([2]);
  });

  it("mixed keys (direction_id vs headsign) also apply the through-S guard", () => {
    const index = patternIndex([
      pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre", directionId: 0 }]),
      // Conflicting direction_ids → headsign key; through S → excluded.
      pattern("1", ["A", "S", "C"], [
        { tripId: "t2", headsign: "Loop", directionId: 0 },
        { tripId: "t3", headsign: "Loop", directionId: 1 },
      ]),
      pattern("1", ["B2", "S2", "A2"], [
        { tripId: "t4", headsign: "Airport", directionId: 0 },
        { tripId: "t5", headsign: "Airport", directionId: 1 },
      ]),
    ]);
    expect(oppositePatterns(index, "1", "d0", "S")).toEqual([2]);
  });

  it("a single-direction loop route has no opposite", () => {
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#loop-routes
    const index = patternIndex([
      pattern("L", ["A", "S", "B", "C", "A"], [
        { tripId: "t1", headsign: "Circle", directionId: 0 },
        { tripId: "t2", headsign: "Circle", directionId: 0 },
      ]),
      // A short-working variant in the same direction is not an opposite either.
      pattern("L", ["A", "S", "B"], [{ tripId: "t3", headsign: "Circle", directionId: 0 }]),
    ]);
    expect(oppositePatterns(index, "L", "d0", "S")).toEqual([]);
  });

  it("a route with one pattern has no opposite", () => {
    const index = patternIndex([
      pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre" }]),
    ]);
    expect(oppositePatterns(index, "1", "h:Centre", "S")).toEqual([]);
  });

  it("an unknown routeId → empty", () => {
    const index = patternIndex([
      pattern("1", ["A", "S"], [{ tripId: "t1", headsign: "Centre", directionId: 0 }]),
      pattern("1", ["S2", "A2"], [{ tripId: "t2", headsign: "Airport", directionId: 1 }]),
    ]);
    expect(oppositePatterns(index, "nope", "d0", "S")).toEqual([]);
  });

  it("patterns absent → empty", () => {
    expect(oppositePatterns({}, "1", "d0", "S")).toEqual([]);
  });
});

// Metres per degree of latitude on the haversine sphere (R = 6 371 km).
const M_PER_DEG = (6_371_000 * Math.PI) / 180;
const USER: LatLon = { lat: 54.68, lon: 25.28 };

/** A stop `north` / `east` metres from the user (negative = south / west). */
function stopAt(
  id: string,
  name: string,
  north: number,
  east = 0,
  parentStation?: string,
): StopForGrouping {
  return {
    id,
    name,
    lat: USER.lat + north / M_PER_DEG,
    lon: USER.lon + east / (M_PER_DEG * Math.cos((USER.lat * Math.PI) / 180)),
    ...(parentStation !== undefined ? { parentStation } : {}),
  };
}

function ctxOf(
  patterns: RaptorIndexRoute[],
  stops: StopForGrouping[],
  assigned: string[] = [],
): ReverseStopContext {
  const byId = new Map(stops.map((s) => [s.id, s]));
  return {
    index: patternIndex(patterns),
    user: USER,
    getStop: (id) => byId.get(id),
    assigned: new Set(assigned),
  };
}

// Line 1: "d0" serves S; the opposite "d1" pattern runs over `oppositeStops`.
function lineOne(oppositeStops: string[]): RaptorIndexRoute[] {
  return [
    pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre", directionId: 0 }]),
    pattern("1", oppositeStops, [{ tripId: "t2", headsign: "Airport", directionId: 1 }]),
  ];
}

const LINE_ONE = { routeId: "1", dirKey: "d0" };

describe("reverseStopFor", () => {
  it("tier 1: the same-name pole on the other side beats a closer stop", () => {
    const ctx = ctxOf(lineOne(["FAR", "S2", "O", "FAR2"]), [
      stopAt("S", "Main St", -10),
      stopAt("S2", "Main St", 30),
      stopAt("O", "Oak Ave", 0, 20),
      stopAt("FAR", "Far", 2000),
      stopAt("FAR2", "Far 2", -2000),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)).toEqual({ stopId: "S2", dirKeys: ["d1"] });
  });

  it("tier 1: a parent_station sibling beats a closer stop", () => {
    const ctx = ctxOf(lineOne(["S2", "O"]), [
      stopAt("S", "Central", -10, 0, "P"),
      stopAt("S2", "Central Platform B", 60, 0, "P"),
      stopAt("O", "Oak Ave", 0, 20),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("S2");
  });

  it.each([
    ["the origin knows its parent station, the pole does not", "P", undefined],
    ["the pole knows its parent station, the origin does not", undefined, "P"],
  ])("tier 1 still joins a same-name pole when %s", (_name, originParent, poleParent) => {
    // Only server rows carry parent_station: the bundle floor's rows do not.
    const ctx = ctxOf(lineOne(["S2", "O"]), [
      stopAt("S", "Main St", -10, 0, originParent),
      stopAt("S2", "Main St", 30, 0, poleParent),
      stopAt("O", "Oak Ave", 0, 20),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("S2");
  });

  it("tier 1 keeps two different parent stations apart, even under one name", () => {
    const ctx = ctxOf(lineOne(["S2", "O"]), [
      stopAt("S", "Main St", -10, 0, "P"),
      stopAt("S2", "Main St", 30, 0, "Q"),
      stopAt("O", "Oak Ave", 0, 20),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("O");
  });

  it("tier 1: of two group members, the one closest to the user wins", () => {
    const ctx = ctxOf(lineOne(["S2a", "O", "S2b"]), [
      stopAt("S", "Main St", -10),
      stopAt("S2a", "Main St", 40),
      stopAt("S2b", "Main St", 25),
      stopAt("O", "Oak Ave", 0, 10),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("S2b");
  });

  it("the 500 m cap applies to tier 1: a numbered sibling 2 km away is ignored", () => {
    const ctx = ctxOf(lineOne(["D02", "O"]), [
      stopAt("S", "Dworzec 01", -10),
      stopAt("D02", "Dworzec 02", 2000),
      stopAt("O", "Oak Ave", 100),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("O");
  });

  it("tier 2: a one-way pair with different names → the closest opposite stop", () => {
    const ctx = ctxOf(lineOne(["E1", "E2", "E3"]), [
      stopAt("S", "Pine St", 0),
      stopAt("E1", "Elm St North", 200, 150),
      stopAt("E2", "Elm St South", 0, 150),
      stopAt("E3", "Elm St Park", -700, 150),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("E2");
  });

  it("a candidate at 501 m → none", () => {
    const ctx = ctxOf(lineOne(["X1", "X2"]), [
      stopAt("S", "Main St", 0),
      stopAt("X1", "Main St", 501),
      stopAt("X2", "Oak Ave", -900),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)).toBeNull();
  });

  it("candidates already assigned to a row are skipped", () => {
    const ctx = ctxOf(
      lineOne(["S2", "O"]),
      [stopAt("S", "Main St", -10), stopAt("S2", "Main St", 30), stopAt("O", "Oak Ave", 0, 20)],
      ["S2"],
    );
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("O");
  });

  it("the origin stop itself is never its own reverse stop (terminus)", () => {
    // direction_id opposite through S: the terminus serves both directions.
    const ctx = ctxOf(
      [
        pattern("1", ["S", "A"], [{ tripId: "t1", headsign: "A", directionId: 0 }]),
        pattern("1", ["A", "S"], [{ tripId: "t2", headsign: "S", directionId: 1 }]),
      ],
      [stopAt("S", "Terminus", 0), stopAt("A", "Far", 3000)],
    );
    expect(reverseStopFor(LINE_ONE, "S", ctx)).toBeNull();
  });

  it("returns the direction keys of every opposite pattern serving the stop", () => {
    const ctx = ctxOf(
      [
        pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre" }]),
        pattern("1", ["B2", "S2", "A2"], [{ tripId: "t2", headsign: "Airport" }]),
        pattern("1", ["C2", "S2", "A2"], [{ tripId: "t3", headsign: "Airport via C" }]),
        pattern("1", ["S3", "A3"], [{ tripId: "t4", headsign: "Depot" }]),
      ],
      [
        stopAt("S", "Main St", -10),
        stopAt("S2", "Main St", 30),
        stopAt("S3", "Depot Rd", 5),
      ],
    );
    expect(reverseStopFor({ routeId: "1", dirKey: "h:Centre" }, "S", ctx)).toEqual({
      stopId: "S2",
      dirKeys: ["h:Airport", "h:Airport via C"],
    });
  });

  it("a route with no opposite → none", () => {
    const ctx = ctxOf(
      [pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre", directionId: 0 }])],
      [stopAt("S", "Main St", 0), stopAt("A", "A", 50), stopAt("B", "B", -50)],
    );
    expect(reverseStopFor(LINE_ONE, "S", ctx)).toBeNull();
  });

  it("a candidate unknown to getStop is skipped without throwing", () => {
    const ctx = ctxOf(lineOne(["S2", "O"]), [
      stopAt("S", "Main St", -10),
      // "S2" has no stop record.
      stopAt("O", "Oak Ave", 0, 20),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("O");
  });

  it("an origin unknown to getStop still falls back to the closest candidate", () => {
    const ctx = ctxOf(lineOne(["S2", "O"]), [
      stopAt("S2", "Main St", 30),
      stopAt("O", "Oak Ave", 0, 20),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", ctx)?.stopId).toBe("O");
  });

  it("a distance tie breaks by the lowest stopId, in both tiers", () => {
    const tier2 = ctxOf(lineOne(["b", "a"]), [
      stopAt("S", "Pine St", 0),
      stopAt("b", "Elm North", 100),
      stopAt("a", "Elm South", -100),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", tier2)?.stopId).toBe("a");

    const tier1 = ctxOf(lineOne(["S2b", "O", "S2a"]), [
      stopAt("S", "Main St", 0),
      stopAt("S2b", "Main St", 0, 40),
      stopAt("S2a", "Main St", 0, -40),
      stopAt("O", "Oak Ave", 10),
    ]);
    expect(reverseStopFor(LINE_ONE, "S", tier1)?.stopId).toBe("S2a");
  });
});

function inputOf(
  patterns: RaptorIndexRoute[],
  stops: StopForGrouping[],
  nearestStopId = "S",
): NearbyDirectionsInput {
  const byId = new Map(stops.map((s) => [s.id, s]));
  return { index: patternIndex(patterns), nearestStopId, user: USER, getStop: (id) => byId.get(id) };
}

const side = (stopId: string, routeId: string, dirKey: string, row: Row): Side => ({
  stopId, routeId, dirKey, row,
});

// Route `id`: "d0" over `forward`, "d1" over `back`.
function twoWay(id: string, forward: string[], back: string[]): RaptorIndexRoute[] {
  return [
    pattern(id, forward, [{ tripId: `${id}-f`, headsign: `${id} out`, directionId: 0 }]),
    pattern(id, back, [{ tripId: `${id}-b`, headsign: `${id} in`, directionId: 1 }]),
  ];
}

describe("resolveNearbySides", () => {
  it("two-sided street: both lines top at S, bottom at the opposite pole", () => {
    const input = inputOf(
      [
        ...twoWay("1", ["A1", "S", "B1"], ["B1", "R", "A1"]),
        ...twoWay("2", ["A2", "S", "B2"], ["B2", "R", "A2"]),
      ],
      [stopAt("S", "Main St", -10), stopAt("R", "Main St", 30)],
    );
    expect(resolveNearbySides(input)).toEqual([
      side("S", "1", "d0", "top"),
      side("S", "2", "d0", "top"),
      side("R", "1", "d1", "bottom"),
      side("R", "2", "d1", "bottom"),
    ]);
  });

  it("junction split: each line's reverse at its own stop", () => {
    const input = inputOf(
      [
        ...twoWay("1", ["A", "S", "B"], ["B", "R1", "A"]),
        ...twoWay("2", ["C", "S", "D"], ["D", "R2", "C"]),
      ],
      [stopAt("S", "Junction", 0), stopAt("R1", "Junction", 30), stopAt("R2", "Junction", 0, 40)],
    );
    expect(resolveNearbySides(input)).toEqual([
      side("S", "1", "d0", "top"),
      side("S", "2", "d0", "top"),
      side("R1", "1", "d1", "bottom"),
      side("R2", "2", "d1", "bottom"),
    ]);
  });

  it("an extra line at a reverse stop gets its reverse in the top row, searched from that stop; one round only", () => {
    const input = inputOf(
      [
        ...twoWay("1", ["A", "S", "B"], ["B", "R1", "A"]),
        // Line 3 never serves S. Its "d1" runs past U (S's name, closest to
        // the user) and T (R1's name): searched from R1, tier 1 picks T.
        ...twoWay("3", ["X", "R1", "Y"], ["Y", "U", "T", "X"]),
        // Line 4 only serves T: a second round would add it — there is none.
        ...twoWay("4", ["P", "T", "Q"], ["Q", "V", "P"]),
      ],
      [
        stopAt("S", "Main St", -10),
        stopAt("R1", "Park Rd", 40),
        stopAt("T", "Park Rd", 40, -60),
        stopAt("U", "Main St", -12, 5),
        stopAt("V", "Elm St", 100),
      ],
    );
    expect(resolveNearbySides(input)).toEqual([
      side("S", "1", "d0", "top"),
      side("R1", "1", "d1", "bottom"),
      side("R1", "3", "d0", "bottom"),
      side("T", "3", "d1", "top"),
    ]);
  });

  it("a stop reached from both sides keeps its first row", () => {
    // R2 is line 2's reverse (bottom). Line 3, extra at R1, also runs its
    // "d1" through R2 and T: R2 stays bottom (hop 1 beats hop 2) and line 3
    // d1 is shown there, never at T in the top row.
    const input = inputOf(
      [
        ...twoWay("1", ["A", "S", "B"], ["B", "R1", "A"]),
        ...twoWay("2", ["C", "S", "D"], ["D", "R2", "C"]),
        ...twoWay("3", ["X", "R1", "Y"], ["Y", "R2", "T", "X"]),
      ],
      [
        stopAt("S", "Main St", -10),
        stopAt("R1", "Park Rd", 40),
        stopAt("R2", "Oak Ave", 0, 30),
        stopAt("T", "Park Rd", 40, -60),
      ],
    );
    const sides = resolveNearbySides(input);
    expect(sides).toEqual([
      side("S", "1", "d0", "top"),
      side("S", "2", "d0", "top"),
      side("R1", "1", "d1", "bottom"),
      side("R2", "2", "d1", "bottom"),
      side("R1", "3", "d0", "bottom"),
      side("R2", "3", "d1", "bottom"),
    ]);
    const rows = new Map<string, Set<Row>>();
    for (const s of sides) rows.set(s.stopId, (rows.get(s.stopId) ?? new Set<Row>()).add(s.row));
    for (const set of rows.values()) expect(set.size).toBe(1);
  });

  it("terminus where S serves both directions → both top, no bottom", () => {
    const input = inputOf(
      [
        ...twoWay("1", ["S", "A", "B"], ["B", "A", "S"]),
        // Would be an extra line if A were ever assigned.
        pattern("5", ["A", "Z"], [{ tripId: "t5", headsign: "Z", directionId: 0 }]),
      ],
      [stopAt("S", "Terminus", 0), stopAt("A", "Mid", 200), stopAt("Z", "Zed", 300)],
    );
    expect(resolveNearbySides(input)).toEqual([
      side("S", "1", "d0", "top"),
      side("S", "1", "d1", "top"),
    ]);
  });

  it("no opposite anywhere → top sides only", () => {
    const input = inputOf(
      [
        pattern("1", ["A", "S", "B"], [{ tripId: "t1", headsign: "Centre", directionId: 0 }]),
        pattern("2", ["C", "S", "D"], [{ tripId: "t2", headsign: "Depot" }]),
      ],
      [stopAt("S", "Main St", 0), stopAt("A", "A", 50), stopAt("D", "D", -50)],
    );
    expect(resolveNearbySides(input)).toEqual([
      side("S", "1", "d0", "top"),
      side("S", "2", "h:Depot", "top"),
    ]);
  });

  it("a lasso pattern visiting S twice seeds once", () => {
    // https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
    const input = inputOf(
      twoWay("L", ["A", "S", "B", "C", "S", "D"], ["D", "R", "A"]),
      [stopAt("S", "Main St", -10), stopAt("R", "Main St", 30)],
    );
    expect(resolveNearbySides(input)).toEqual([
      side("S", "L", "d0", "top"),
      side("R", "L", "d1", "bottom"),
    ]);
  });

  it("a hub with many lines: output order does not depend on pattern order", () => {
    const routes = ["M1", "2", "10", "A", "1"];
    const patterns = routes.flatMap((id) =>
      twoWay(id, [`${id}a`, "S", `${id}b`], [`${id}b`, "R", `${id}a`]),
    );
    const stops = [stopAt("S", "Hub", -10), stopAt("R", "Hub", 30)];
    const sides = resolveNearbySides(inputOf(patterns, stops));
    const order = ["1", "10", "2", "A", "M1"];
    expect(sides.filter((s) => s.row === "top").map((s) => s.routeId)).toEqual(order);
    expect(sides.filter((s) => s.row === "bottom").map((s) => s.routeId)).toEqual(order);
    expect(resolveNearbySides(inputOf([...patterns].reverse(), stops))).toEqual(sides);
  });

  it("S unknown to patternsAtStop → empty", () => {
    const input = inputOf(
      twoWay("1", ["A", "S", "B"], ["B", "R", "A"]),
      [stopAt("S", "Main St", 0)],
      "NOPE",
    );
    expect(resolveNearbySides(input)).toEqual([]);
  });

  it("patterns absent (PatternMode Off / Dexie fallback) → empty", () => {
    expect(
      resolveNearbySides({ index: {}, nearestStopId: "S", user: USER, getStop: () => undefined }),
    ).toEqual([]);
  });
});

function dep(routeId: string, tripId: string, minute = 0): Departure {
  return {
    routeId,
    routeShortName: routeId,
    mode: "BUS",
    headsign: "",
    scheduledTime: new Date(Date.UTC(2026, 8, 27, 8, minute)).toISOString(),
    tripId,
  };
}

describe("assignDeparturesToSides", () => {
  it("joins departures by trip → pattern direction key, keeping their order", () => {
    const index = patternIndex(twoWay("1", ["S", "A"], ["A", "S"]));
    const top0 = side("S", "1", "d0", "top");
    const top1 = side("S", "1", "d1", "top");
    const first = dep("1", "1-f", 1);
    const back = dep("1", "1-b", 2);
    const second = dep("1", "1-f", 3);
    const out = assignDeparturesToSides(
      [top0, top1],
      new Map([["S", [first, back, second]]]),
      patternDirKeys(index),
    );
    expect(out.get(top0)).toEqual([first, second]);
    expect(out.get(top1)).toEqual([back]);
  });

  it("a CoveringMerge folded trip without direction_id still joins its pattern's side", () => {
    const index = patternIndex([
      pattern("R", ["s0", "S", "s2"], [
        { tripId: "T0", headsign: "Short turn", departureSecs: [-1, 1000, 1300] },
        { tripId: "T1", headsign: "Terminal", directionId: 0 },
      ]),
      pattern("R", ["s2", "B", "s0"], [{ tripId: "T2", headsign: "Back", directionId: 1 }]),
    ]);
    const top = side("S", "R", "d0", "top");
    const out = assignDeparturesToSides(
      [top],
      new Map([["S", [dep("R", "T0")]]]),
      patternDirKeys(index),
    );
    expect(out.get(top)?.map((d) => d.tripId)).toEqual(["T0"]);
  });

  it("an unknown trip joins by route only when that route has one side at that stop", () => {
    const index = patternIndex([
      ...twoWay("1", ["S", "A"], ["A", "S"]),
      ...twoWay("2", ["C", "S", "D"], ["D", "R", "C"]),
    ]);
    const s1d0 = side("S", "1", "d0", "top");
    const s1d1 = side("S", "1", "d1", "top");
    const s2 = side("S", "2", "d0", "top");
    const r2 = side("R", "2", "d1", "bottom");
    const out = assignDeparturesToSides(
      [s1d0, s1d1, s2, r2],
      new Map([
        // Route 1 has two sides at S: its unknown trip is dropped, never shown twice.
        ["S", [dep("1", "legacy-1"), dep("2", "legacy-2"), dep("9", "legacy-9")]],
        ["R", [dep("2", "legacy-2r")]],
      ]),
      patternDirKeys(index),
    );
    expect(out.get(s1d0)).toEqual([]);
    expect(out.get(s1d1)).toEqual([]);
    expect(out.get(s2)?.map((d) => d.tripId)).toEqual(["legacy-2"]);
    expect(out.get(r2)?.map((d) => d.tripId)).toEqual(["legacy-2r"]);
  });

  it("at the nearest stop, a departure the rules would drop goes to its route's first side there", () => {
    const index = patternIndex([
      ...twoWay("1", ["S", "A"], ["A", "S"]),
      ...twoWay("2", ["A2", "S", "B2"], ["B2", "R", "A2"]),
    ]);
    const s1d0 = side("S", "1", "d0", "top");
    const s1d1 = side("S", "1", "d1", "top");
    const s2 = side("S", "2", "d0", "top");
    const r2 = side("R", "2", "d1", "bottom");
    const r2Twin = side("R", "2", "h:Other", "bottom");
    const out = assignDeparturesToSides(
      [s1d0, s1d1, s2, r2, r2Twin],
      new Map([
        // Unknown trip, two sides of its route at S; known trip "2-b" (d1)
        // whose direction has no side at S.
        ["S", [dep("1", "new-1"), dep("2", "2-b"), dep("9", "no-side")]],
        // R is not the nearest stop: the strict rules hold there.
        ["R", [dep("2", "new-2r")]],
      ]),
      patternDirKeys(index),
      { nearestStopId: "S" },
    );
    expect(out.get(s1d0)?.map((d) => d.tripId)).toEqual(["new-1"]);
    expect(out.get(s1d1)).toEqual([]);
    expect(out.get(s2)?.map((d) => d.tripId)).toEqual(["2-b"]);
    // A route with no side at all still has nowhere to go.
    expect([...out.values()].flat().some((d) => d.tripId === "no-side")).toBe(false);
    expect(out.get(r2)).toEqual([]);
    expect(out.get(r2Twin)).toEqual([]);
  });

  it("a known trip whose side lives at another stop is dropped; every side gets an entry", () => {
    const index = patternIndex(twoWay("1", ["A", "S", "B"], ["B", "R", "A"]));
    const top = side("S", "1", "d0", "top");
    const bottom = side("R", "1", "d1", "bottom");
    const out = assignDeparturesToSides(
      [top, bottom],
      // "1-b" (d1) listed at S: there is no (S, 1, d1) side. "X" has no side.
      new Map([["S", [dep("1", "1-f"), dep("1", "1-b")]], ["X", [dep("1", "1-f")]]]),
      patternDirKeys(index),
    );
    expect(out.get(top)?.map((d) => d.tripId)).toEqual(["1-f"]);
    expect(out.get(bottom)).toEqual([]);
    expect(out.size).toBe(2);
  });
});

describe("routeSidesAt", () => {
  it("without sides: one ANY_DIR top side per route, in order of first departure", () => {
    const out = routeSidesAt("S", [dep("2", "a"), dep("1", "b"), dep("2", "c"), dep("3", "d")], []);
    expect(ANY_DIR).toBe("*");
    expect(out).toEqual([
      side("S", "2", ANY_DIR, "top"),
      side("S", "1", ANY_DIR, "top"),
      side("S", "3", ANY_DIR, "top"),
    ]);
  });

  it("adds only the routes with no side at that stop; sides elsewhere do not count", () => {
    const sides = [side("S", "1", "d0", "top"), side("R", "2", "d1", "bottom")];
    const out = routeSidesAt("S", [dep("1", "a"), dep("2", "b"), dep("9", "c")], sides);
    expect(out).toEqual([side("S", "2", ANY_DIR, "top"), side("S", "9", ANY_DIR, "top")]);
  });

  it("nothing to add when every route already has a side there, or with no departures", () => {
    const sides = [side("S", "1", "d0", "top"), side("S", "1", "d1", "top")];
    expect(routeSidesAt("S", [dep("1", "a")], sides)).toEqual([]);
    expect(routeSidesAt("S", [], [])).toEqual([]);
  });

  it("with assignDeparturesToSides at the nearest stop, no departure there is lost", () => {
    // The index knows route 1 at S; route 7 comes from a newer tile only.
    const index = patternIndex(twoWay("1", ["A", "S", "B"], ["B", "R", "A"]));
    const resolved = [side("S", "1", "d0", "top"), side("R", "1", "d1", "bottom")];
    const atS = [dep("1", "1-f"), dep("7", "new-7"), dep("1", "1-new")];
    const sides = [...resolved, ...routeSidesAt("S", atS, resolved)];
    const out = assignDeparturesToSides(sides, new Map([["S", atS]]), patternDirKeys(index), {
      nearestStopId: "S",
    });
    expect([...out.values()].flat().map((d) => d.tripId).sort()).toEqual(["1-f", "1-new", "new-7"]);
    expect(out.get(sides[2]!)?.map((d) => d.tripId)).toEqual(["new-7"]);
  });
});
