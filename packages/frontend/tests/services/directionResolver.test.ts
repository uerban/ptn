import { describe, it, expect } from "vitest";
import { resolveDirections } from "../../src/services/directionResolver.ts";
import type { RaptorIndexRoute } from "../../src/services/raptorIndex.ts";
import type { RouteDirectionPattern } from "@pt/shared";

function makeRoute(
  id: string,
  shortName: string,
  stopIds: string[],
  headsign?: string,
  color?: string,
  directionPatterns?: RouteDirectionPattern[],
): RaptorIndexRoute {
  return {
    id,
    shortName,
    mode: "BUS",
    color,
    stopIds,
    trips: headsign !== undefined ? [{ tripId: `${id}-trip`, serviceId: "svc", headsign, departureSecs: [0] }] : [],
    directionPatterns,
  };
}

function buildIndex(routes: RaptorIndexRoute[]) {
  const routesAtStop = new Map<string, number[]>();
  for (let idx = 0; idx < routes.length; idx++) {
    const seen = new Set<string>();
    const collect = (stopId: string) => {
      if (seen.has(stopId)) return;
      seen.add(stopId);
      let arr = routesAtStop.get(stopId);
      if (!arr) { arr = []; routesAtStop.set(stopId, arr); }
      arr.push(idx);
    };
    for (const stopId of routes[idx].stopIds) collect(stopId);
    for (const pattern of routes[idx].directionPatterns ?? []) {
      for (const stopId of pattern.stopIds) collect(stopId);
    }
  }
  return { routes, routesAtStop };
}

describe("resolveDirections", () => {
  it("returns two DirectionLabels for routes going in opposite directions", () => {
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "S3"], "toward Oliwa", "#ff0000"),
      makeRoute("r2", "11", ["S1", "S4", "S5"], "toward Wrzeszcz", "#0000ff"),
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>();

    const result = resolveDirections("S1", index, stopNames);

    expect(result).toHaveLength(2);
    const labels = result.map((d) => d.label).sort();
    expect(labels).toEqual(["toward Oliwa", "toward Wrzeszcz"]);

    const oliwa = result.find((d) => d.label === "toward Oliwa")!;
    expect(oliwa.routeLabels).toEqual(["10"]);
    expect(oliwa.routeColors).toEqual(["#ff0000"]);

    const wrzeszcz = result.find((d) => d.label === "toward Wrzeszcz")!;
    expect(wrzeszcz.routeLabels).toEqual(["11"]);
    expect(wrzeszcz.routeColors).toEqual(["#0000ff"]);
  });

  it("groups two routes sharing the same headsign into one DirectionLabel", () => {
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "S3"], "toward Oliwa", "#ff0000"),
      makeRoute("r2", "12", ["S1", "S2", "S4"], "toward Oliwa", "#00ff00"),
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>();

    const result = resolveDirections("S1", index, stopNames);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("toward Oliwa");
    expect(result[0].routeLabels.sort()).toEqual(["10", "12"]);
    expect(result[0].routeColors.sort()).toEqual(["#00ff00", "#ff0000"]);
  });

  it("returns an empty array for a stop with no routes", () => {
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "S3"], "toward Oliwa"),
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>();

    const result = resolveDirections("UNKNOWN", index, stopNames);

    expect(result).toEqual([]);
  });

  it("falls back to terminal stop name from stopNames when headsign is absent", () => {
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "S3"]), // no headsign
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>([["S3", "Central Station"]]);

    const result = resolveDirections("S1", index, stopNames);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Central Station");
    expect(result[0].routeLabels).toEqual(["10"]);
  });

  it("falls back to terminal stopId when headsign is absent and stopNames has no entry", () => {
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "S99"]), // no headsign, S99 not in stopNames
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>();

    const result = resolveDirections("S1", index, stopNames);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("S99");
  });

  it("uses the matching directionPattern's terminal when stop appears only on a return-direction pattern (no headsign)", () => {
    // Bidirectional route with no headsign; outbound stops at TERM_OUT, inbound
    // at TERM_IN. Stop X appears only on the inbound (return-only) pattern,
    // stop S2 only on the outbound. Canonical `stopIds` covers the outbound.
    // GTFS pattern stop_ids are ordered by stop_sequence (start → end), so the
    // last element is the direction's terminal. Outbound terminates at
    // TERM_OUT; inbound terminates at TERM_IN, and stop X is the return-only
    // intermediate stop.
    const directionPatterns: RouteDirectionPattern[] = [
      { key: "0", headsign: "", stopIds: ["S1", "S2", "TERM_OUT"] },
      { key: "1", headsign: "", stopIds: ["S1", "X", "TERM_IN"] },
    ];
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "TERM_OUT"], undefined, undefined, directionPatterns),
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>([
      ["TERM_OUT", "Outbound Terminus"],
      ["TERM_IN", "Inbound Terminus"],
    ]);

    const outbound = resolveDirections("S2", index, stopNames);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].label).toBe("Outbound Terminus");

    const inbound = resolveDirections("X", index, stopNames);
    expect(inbound).toHaveLength(1);
    expect(inbound[0].label).toBe("Inbound Terminus");
  });

  it("prefers the matching directionPattern's headsign when a stop is on a return-only pattern", () => {
    const directionPatterns: RouteDirectionPattern[] = [
      { key: "0", headsign: "toward Oliwa", stopIds: ["S1", "S2", "S3"] },
      { key: "1", headsign: "toward Wrzeszcz", stopIds: ["S3", "X", "S1"] },
    ];
    // Route's canonical stopIds reflect only the outbound; trips[0].headsign
    // is the outbound headsign. Stop X is return-only.
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "S3"], "toward Oliwa", "#ff0000", directionPatterns),
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>();

    const result = resolveDirections("X", index, stopNames);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("toward Wrzeszcz");
  });

  it("does not leak the outbound trip headsign when the matched pattern's headsign is empty", () => {
    // Regression guard: `pattern?.headsign || route.trips[0]?.headsign`
    // would fall through to the first trip's headsign (typically the
    // outbound direction) when the matched pattern's headsign is the
    // empty string — silently re-leaking the outbound label at a
    // return-only stop. Fix branches on `pattern` instead, so an empty
    // matched headsign routes through the terminal-name fallback.
    const directionPatterns: RouteDirectionPattern[] = [
      { key: "0", headsign: "toward Center", stopIds: ["S1", "S2", "TERM_OUT"] },
      { key: "1", headsign: "", stopIds: ["S1", "X", "TERM_IN"] },
    ];
    const routes = [
      // Route's first trip carries the outbound headsign (typical case).
      makeRoute("r1", "10", ["S1", "S2", "TERM_OUT"], "toward Center", undefined, directionPatterns),
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>([
      ["TERM_OUT", "Outbound Terminus"],
      ["TERM_IN", "Inbound Terminus"],
    ]);

    const result = resolveDirections("X", index, stopNames);
    expect(result).toHaveLength(1);
    // Must NOT be "toward Center" (would indicate outbound headsign leaked
    // through). Must be the inbound pattern's terminal.
    expect(result[0].label).toBe("Inbound Terminus");
  });

  it("labels a return-only stop by its own direction even when the canonical sequence contains it", () => {
    // `aggregateDisplay` makes the LONGEST pattern canonical, so on a
    // bidirectional route the canonical is normally the return leg and a
    // return-only stop sits ON it. `findStopIdxInRoute` then reports no
    // pattern, and the old fallback took `trips[0]`'s headsign — the earliest
    // departure across BOTH directions, which is typically the outbound run
    // that never calls at this stop.
    const directionPatterns: RouteDirectionPattern[] = [
      { key: "0", headsign: "Bravo Center", stopIds: ["A", "B"] },
      { key: "1", headsign: "Alpha Terminal", stopIds: ["B", "X", "A"] },
    ];
    const route = makeRoute("r1", "1", ["B", "X", "A"], undefined, undefined, directionPatterns);
    route.trips = [
      { tripId: "out-1", serviceId: "svc", headsign: "Bravo Center", departureSecs: [0, 600] },
      { tripId: "in-1", serviceId: "svc", headsign: "Alpha Terminal", departureSecs: [1800, 2400, 3000] },
    ];
    const index = buildIndex([route]);

    const atReturnOnly = resolveDirections("X", index, new Map());
    expect(atReturnOnly).toHaveLength(1);
    expect(atReturnOnly[0].label).toBe("Alpha Terminal");

    // A stop both directions call at stays on the trips[0] fallback: there is
    // no single correct headsign to prefer, so this must not change.
    const atShared = resolveDirections("A", index, new Map());
    expect(atShared).toHaveLength(1);
    expect(atShared[0].label).toBe("Bravo Center");
  });

  it("groups fallback terminal-based labels the same way as headsign grouping", () => {
    const routes = [
      makeRoute("r1", "10", ["S1", "S2", "TERM_A"]), // no headsign
      makeRoute("r2", "20", ["S1", "S3", "TERM_A"]), // no headsign, same terminal
    ];
    const index = buildIndex(routes);
    const stopNames = new Map<string, string>([["TERM_A", "Airport"]]);

    const result = resolveDirections("S1", index, stopNames);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("Airport");
    expect(result[0].routeLabels.sort()).toEqual(["10", "20"]);
  });
});
