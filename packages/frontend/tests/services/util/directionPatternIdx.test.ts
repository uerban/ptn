import { describe, it, expect } from "vitest";
import { findStopIdxInRoute } from "../../../src/services/util/directionPatternIdx.ts";
import type { RaptorIndexRoute } from "../../../src/services/raptorIndex.ts";
import type { RouteDirectionPattern } from "@pt/shared";

function makeRoute(
  stopIds: string[],
  directionPatterns?: RouteDirectionPattern[],
): RaptorIndexRoute {
  return {
    id: "R",
    shortName: "R",
    mode: "BUS",
    stopIds,
    trips: [],
    ...(directionPatterns ? { directionPatterns } : {}),
  };
}

describe("findStopIdxInRoute", () => {
  it("canonical: matches at idx 0", () => {
    const route = makeRoute(["A", "B", "C"]);
    const { idx, pattern } = findStopIdxInRoute(route, "A");
    expect(idx).toBe(0);
    expect(pattern).toBeNull();
  });

  it("canonical: matches at middle", () => {
    const route = makeRoute(["A", "B", "C"]);
    const { idx, pattern } = findStopIdxInRoute(route, "B");
    expect(idx).toBe(1);
    expect(pattern).toBeNull();
  });

  it("canonical: matches at last idx", () => {
    const route = makeRoute(["A", "B", "C"]);
    const { idx, pattern } = findStopIdxInRoute(route, "C");
    expect(idx).toBe(2);
    expect(pattern).toBeNull();
  });

  it("pattern-only: matches at pattern idx 0", () => {
    const dp: RouteDirectionPattern = {
      key: "1",
      headsign: "Return",
      stopIds: ["X", "Y", "Z"],
    };
    const route = makeRoute(["A", "B", "C"], [dp]);
    const { idx, pattern } = findStopIdxInRoute(route, "X");
    expect(idx).toBe(0);
    expect(pattern).toBe(dp);
  });

  it("pattern-only: matches at pattern last idx", () => {
    const dp: RouteDirectionPattern = {
      key: "1",
      headsign: "Return",
      stopIds: ["X", "Y", "Z"],
    };
    const route = makeRoute(["A", "B", "C"], [dp]);
    const { idx, pattern } = findStopIdxInRoute(route, "Z");
    expect(idx).toBe(2);
    expect(pattern).toBe(dp);
  });

  it("second-pattern-only: returns the second pattern", () => {
    const dpA: RouteDirectionPattern = {
      key: "0",
      headsign: "Outbound",
      stopIds: ["A", "B", "C"],
    };
    const dpB: RouteDirectionPattern = {
      key: "1",
      headsign: "Return",
      stopIds: ["X", "Y", "Z"],
    };
    const route = makeRoute(["A", "B", "C"], [dpA, dpB]);
    const { idx, pattern } = findStopIdxInRoute(route, "Y");
    expect(idx).toBe(1);
    expect(pattern).toBe(dpB);
  });

  it("in-both-patterns: returns the first match in wire order", () => {
    const dpA: RouteDirectionPattern = {
      key: "0",
      headsign: "Outbound",
      stopIds: ["A", "M", "C"],
    };
    const dpB: RouteDirectionPattern = {
      key: "1",
      headsign: "Return",
      stopIds: ["Z", "M", "X"],
    };
    // Stop "M" is in canonical so the canonical match wins.
    const route = makeRoute(["A", "M", "C"], [dpA, dpB]);
    const { idx, pattern } = findStopIdxInRoute(route, "M");
    expect(idx).toBe(1);
    expect(pattern).toBeNull();
  });

  it("in-both-patterns but not canonical: first pattern wins", () => {
    const dpA: RouteDirectionPattern = {
      key: "0",
      headsign: "Outbound",
      stopIds: ["A", "M", "C"],
    };
    const dpB: RouteDirectionPattern = {
      key: "1",
      headsign: "Return",
      stopIds: ["Z", "M", "X"],
    };
    // Canonical does not contain "M"; first pattern wins by wire order.
    const route = makeRoute(["P", "Q", "R"], [dpA, dpB]);
    const { idx, pattern } = findStopIdxInRoute(route, "M");
    expect(idx).toBe(1);
    expect(pattern).toBe(dpA);
  });

  it("in-neither: returns idx -1 and pattern null", () => {
    const dp: RouteDirectionPattern = {
      key: "1",
      headsign: "Return",
      stopIds: ["X", "Y", "Z"],
    };
    const route = makeRoute(["A", "B", "C"], [dp]);
    const { idx, pattern } = findStopIdxInRoute(route, "MISSING");
    expect(idx).toBe(-1);
    expect(pattern).toBeNull();
  });

  it("missing directionPatterns: canonical miss returns -1", () => {
    const route = makeRoute(["A", "B", "C"]);
    const { idx, pattern } = findStopIdxInRoute(route, "X");
    expect(idx).toBe(-1);
    expect(pattern).toBeNull();
  });

  it("empty directionPatterns: canonical miss returns -1", () => {
    const route = makeRoute(["A", "B", "C"], []);
    const { idx, pattern } = findStopIdxInRoute(route, "X");
    expect(idx).toBe(-1);
    expect(pattern).toBeNull();
  });
});
