import { describe, it, expect } from "vitest";
import { findLineClusters } from "../../src/services/lineClustering.ts";
import type { RaptorIndexRoute } from "../../src/services/raptorIndex.ts";
import type { RouteDirectionPattern } from "@pt/shared";

function makeRoute(
  id: string,
  shortName: string,
  stopIds: string[],
  directionPatterns?: RouteDirectionPattern[],
): RaptorIndexRoute {
  return {
    id,
    shortName,
    mode: "BUS",
    stopIds,
    trips: [],
    ...(directionPatterns ? { directionPatterns } : {}),
  };
}

describe("findLineClusters", () => {
  it("groups routes sharing >= minSharedStops consecutive stops from the given stop", () => {
    // Routes A and B share stops S1 -> S2 -> S3 -> S4 from S1 onward.
    // Route C diverges immediately after S1.
    const routes: RaptorIndexRoute[] = [
      makeRoute("A", "10", ["S1", "S2", "S3", "S4", "S5"]),
      makeRoute("B", "11", ["S1", "S2", "S3", "S4", "S6"]),
      makeRoute("C", "12", ["S1", "X1", "X2", "X3"]),
    ];

    const clusters = findLineClusters("S1", routes, 3);

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster.routeIds.sort()).toEqual(["A", "B"]);
    expect(cluster.labels.sort()).toEqual(["10", "11"]);
    // Shared prefix from S1: S1, S2, S3, S4
    expect(cluster.sharedStopIds).toEqual(["S1", "S2", "S3", "S4"]);
    // Direction hint is the last shared stop
    expect(cluster.direction).toBe("S4");
  });

  it("returns empty array when no routes serve the given stop", () => {
    const routes: RaptorIndexRoute[] = [
      makeRoute("A", "10", ["S1", "S2", "S3"]),
      makeRoute("B", "11", ["S4", "S5", "S6"]),
    ];

    const clusters = findLineClusters("UNKNOWN", routes, 2);

    expect(clusters).toEqual([]);
  });

  it("does not cluster routes when shared stops are below the threshold", () => {
    // Routes share only S1, S2 (2 stops) but threshold is 3.
    const routes: RaptorIndexRoute[] = [
      makeRoute("A", "10", ["S1", "S2", "S3", "S4"]),
      makeRoute("B", "11", ["S1", "S2", "X1", "X2"]),
    ];

    const clusters = findLineClusters("S1", routes, 3);

    expect(clusters).toHaveLength(0);
  });

  it("handles routes where fromStopId appears at different positions", () => {
    // Route A: S0 -> S1 -> S2 -> S3 -> S4  (S1 is index 1)
    // Route B: S1 -> S2 -> S3 -> S4 -> S5  (S1 is index 0)
    // From S1, both routes share S1 -> S2 -> S3 -> S4.
    const routes: RaptorIndexRoute[] = [
      makeRoute("A", "10", ["S0", "S1", "S2", "S3", "S4"]),
      makeRoute("B", "11", ["S1", "S2", "S3", "S4", "S5"]),
    ];

    const clusters = findLineClusters("S1", routes, 3);

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster.routeIds.sort()).toEqual(["A", "B"]);
    // Shared from S1: S1, S2, S3, S4
    expect(cluster.sharedStopIds).toEqual(["S1", "S2", "S3", "S4"]);
    expect(cluster.direction).toBe("S4");
  });

  it("creates separate clusters for distinct groups", () => {
    // Group 1: routes A and B share S1->S2->S3->S4
    // Group 2: routes C and D share S1->P1->P2->P3
    const routes: RaptorIndexRoute[] = [
      makeRoute("A", "10", ["S1", "S2", "S3", "S4"]),
      makeRoute("B", "11", ["S1", "S2", "S3", "S4", "S5"]),
      makeRoute("C", "20", ["S1", "P1", "P2", "P3"]),
      makeRoute("D", "21", ["S1", "P1", "P2", "P3", "P4"]),
    ];

    const clusters = findLineClusters("S1", routes, 3);

    expect(clusters).toHaveLength(2);
    const sorted = clusters.sort((a, b) =>
      a.routeIds[0].localeCompare(b.routeIds[0]),
    );
    expect(sorted[0].routeIds.sort()).toEqual(["A", "B"]);
    expect(sorted[1].routeIds.sort()).toEqual(["C", "D"]);
  });

  it("handles a stop that is the last stop in a route (no forward stops)", () => {
    // Route A ends at S3. Slicing from S3 gives only ["S3"].
    // Route B ends at S3 too. Shared prefix is ["S3"] = 1 stop < threshold 2.
    const routes: RaptorIndexRoute[] = [
      makeRoute("A", "10", ["S1", "S2", "S3"]),
      makeRoute("B", "11", ["X1", "X2", "S3"]),
    ];

    const clusters = findLineClusters("S3", routes, 2);

    expect(clusters).toHaveLength(0);
  });

  it("matches a return-only stop via directionPatterns and clusters it with the inbound continuation", () => {
    // ALPHA's canonical (longest-trip) sequence is its outbound direction
    // ["P1","P2","P3","P4"], which does not include the return-only stop
    // "X". Its second directionPattern (the inbound leg) starts at "X" and
    // continues "X" → "Y" → "Z". From stop "X", ALPHA should appear in the
    // cluster that shares its inbound continuation (BETA, GAMMA), not in
    // the unrelated DELTA/EPSILON cluster that diverges immediately after
    // "X".
    const routes: RaptorIndexRoute[] = [
      makeRoute("ALPHA", "1", ["P1", "P2", "P3", "P4"], [
        { key: "0", headsign: "Outbound", stopIds: ["P1", "P2", "P3", "P4"] },
        { key: "1", headsign: "Inbound", stopIds: ["X", "Y", "Z"] },
      ]),
      makeRoute("BETA", "2", ["X", "Y", "Z"]),
      makeRoute("GAMMA", "3", ["X", "Y", "Z", "Z2"]),
      makeRoute("DELTA", "4", ["X", "Q1", "Q2", "Q3"]),
      makeRoute("EPSILON", "5", ["X", "Q1", "Q2", "Q3"]),
    ];

    const clusters = findLineClusters("X", routes, 3);

    expect(clusters).toHaveLength(2);

    const alphaCluster = clusters.find((c) => c.routeIds.includes("ALPHA"));
    expect(alphaCluster).toBeDefined();
    expect(alphaCluster!.routeIds.sort()).toEqual(["ALPHA", "BETA", "GAMMA"]);
    expect(alphaCluster!.sharedStopIds).toEqual(["X", "Y", "Z"]);

    const otherCluster = clusters.find((c) => !c.routeIds.includes("ALPHA"));
    expect(otherCluster).toBeDefined();
    expect(otherCluster!.routeIds.sort()).toEqual(["DELTA", "EPSILON"]);
  });

  it("clusters all routes sharing the same long prefix into one group", () => {
    const routes: RaptorIndexRoute[] = [
      makeRoute("A", "1", ["S1", "S2", "S3", "S4", "S5"]),
      makeRoute("B", "2", ["S1", "S2", "S3", "S4", "S6"]),
      makeRoute("C", "3", ["S1", "S2", "S3", "S4", "S7"]),
    ];

    const clusters = findLineClusters("S1", routes, 3);

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0];
    expect(cluster.routeIds.sort()).toEqual(["A", "B", "C"]);
    // All three share S1->S2->S3->S4
    expect(cluster.sharedStopIds).toEqual(["S1", "S2", "S3", "S4"]);
  });
});
