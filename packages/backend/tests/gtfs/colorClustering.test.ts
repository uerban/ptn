import { describe, it, expect } from "vitest";
import {
  ciede2000,
  clusterRouteColors,
  nameColorCluster,
} from "../../src/gtfs/colorClustering.js";

describe("ciede2000", () => {
  it("identical colors have distance 0", () => {
    expect(ciede2000("#ff0000", "#ff0000")).toBeCloseTo(0, 1);
  });

  it("similar blues are close", () => {
    const dist = ciede2000("#0073AC", "#0068A0");
    expect(dist).toBeLessThan(10);
  });

  it("red and green are far apart", () => {
    const dist = ciede2000("#ff0000", "#00ff00");
    expect(dist).toBeGreaterThan(50);
  });
});

describe("clusterRouteColors", () => {
  it("groups similar colors into one cluster", () => {
    const routes = [
      { id: "r1", shortName: "1", color: "#0073AC", mode: "BUS" as const },
      { id: "r2", shortName: "2", color: "#0068A0", mode: "BUS" as const },
      { id: "r3", shortName: "3", color: "#007AB8", mode: "BUS" as const },
    ];
    const { subModes } = clusterRouteColors(routes);
    expect(subModes).toHaveLength(1);
    expect(subModes[0].routeCount).toBe(3);
    expect(subModes[0].parentMode).toBe("BUS");
  });

  it("separates distinct colors into sub-modes", () => {
    const routes = [
      { id: "r1", shortName: "1", color: "#0073AC", mode: "BUS" as const },
      { id: "r2", shortName: "2", color: "#0073AC", mode: "BUS" as const },
      { id: "r3", shortName: "N1", color: "#111111", mode: "BUS" as const },
      { id: "r4", shortName: "N2", color: "#111111", mode: "BUS" as const },
    ];
    const { subModes } = clusterRouteColors(routes);
    expect(subModes).toHaveLength(2);
  });

  it("promotes a single-route outlier with ΔE>25 from dominant", () => {
    const routes = [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`, shortName: `${i}`, color: "#0073AC", mode: "BUS" as const,
      })),
      { id: "r-night", shortName: "N1", color: "#111111", mode: "BUS" as const },
    ];
    const { subModes } = clusterRouteColors(routes);
    expect(subModes).toHaveLength(2);
    const nightCluster = subModes.find((c) => c.routeCount === 1);
    expect(nightCluster).toBeDefined();
  });

  it("merges a single-route near-match with ΔE<25 into dominant", () => {
    const routes = [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`, shortName: `${i}`, color: "#0073AC", mode: "BUS" as const,
      })),
      { id: "r-similar", shortName: "S1", color: "#0068A0", mode: "BUS" as const },
    ];
    const { subModes } = clusterRouteColors(routes);
    expect(subModes).toHaveLength(1);
    expect(subModes[0].routeCount).toBe(11);
  });

  it("routes with no color join a default cluster", () => {
    const routes = [
      { id: "r1", shortName: "1", color: "", mode: "BUS" as const },
      { id: "r2", shortName: "2", color: "", mode: "BUS" as const },
      { id: "r3", shortName: "N1", color: "#111111", mode: "BUS" as const },
      { id: "r4", shortName: "N2", color: "#111111", mode: "BUS" as const },
    ];
    const { subModes } = clusterRouteColors(routes);
    const defaultCluster = subModes.find((c) => c.id === "BUS");
    expect(defaultCluster).toBeDefined();
    expect(defaultCluster!.routeCount).toBe(2);
  });

  it("handles multiple modes independently", () => {
    const routes = [
      { id: "r1", shortName: "1", color: "#0073AC", mode: "BUS" as const },
      { id: "r2", shortName: "2", color: "#0073AC", mode: "BUS" as const },
      { id: "r3", shortName: "T1", color: "#16a34a", mode: "TRAM" as const },
      { id: "r4", shortName: "T2", color: "#16a34a", mode: "TRAM" as const },
    ];
    const { subModes } = clusterRouteColors(routes);
    expect(subModes).toHaveLength(2);
    expect(subModes.find((c) => c.parentMode === "BUS")).toBeDefined();
    expect(subModes.find((c) => c.parentMode === "TRAM")).toBeDefined();
  });

  it("builds routeSubModeMap from cluster membership", () => {
    const routes = [
      { id: "r1", shortName: "1", color: "#0073AC", mode: "BUS" as const },
      { id: "r2", shortName: "2", color: "#0073AC", mode: "BUS" as const },
      { id: "r3", shortName: "N1", color: "#111111", mode: "BUS" as const },
      { id: "r4", shortName: "N2", color: "#111111", mode: "BUS" as const },
      { id: "r5", shortName: "5", color: "", mode: "BUS" as const },
    ];
    const { subModes, routeSubModeMap } = clusterRouteColors(routes);
    // All routes should be mapped
    expect(routeSubModeMap.size).toBe(5);
    // Routes in the same cluster should have the same sub-mode
    expect(routeSubModeMap.get("r1")).toBe(routeSubModeMap.get("r2"));
    expect(routeSubModeMap.get("r3")).toBe(routeSubModeMap.get("r4"));
    // Different clusters should have different sub-mode IDs
    expect(routeSubModeMap.get("r1")).not.toBe(routeSubModeMap.get("r3"));
    // No-color route maps to default sub-mode
    expect(routeSubModeMap.get("r5")).toBe("BUS");
    // Every mapped sub-mode ID should exist in subModes
    for (const smId of routeSubModeMap.values()) {
      expect(subModes.find((s) => s.id === smId)).toBeDefined();
    }
  });
});

describe("nameColorCluster", () => {
  it("names a blue cluster", () => {
    expect(nameColorCluster("#0073AC", "BUS").label).toBe("Bus (blue)");
  });

  it("names a black cluster", () => {
    expect(nameColorCluster("#111111", "BUS").label).toBe("Bus (black)");
  });

  it("names a green cluster", () => {
    expect(nameColorCluster("#2E8B57", "TRAM").label).toBe("Tram (green)");
  });
});
