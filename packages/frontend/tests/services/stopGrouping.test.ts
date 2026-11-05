import { describe, it, expect } from "vitest";
import {
  groupStops,
  STOP_PROXIMITY_THRESHOLD_M,
  type StopForGrouping,
} from "../../src/services/stopGrouping.ts";

// Vilnius-area base coordinate used as a reference point for distance tests.
// ~100 m north shift in latitude ≈ 0.0009 degrees.
const BASE_LAT = 54.6872;
const BASE_LON = 25.2797;

describe("groupStops", () => {
  it("exports STOP_PROXIMITY_THRESHOLD_M = 150", () => {
    expect(STOP_PROXIMITY_THRESHOLD_M).toBe(150);
  });

  // ── Strategy 1: parent_station ───────────────────────────────────────────

  describe("parent_station grouping", () => {
    it("groups stops sharing the same parentStation", () => {
      const stops: StopForGrouping[] = [
        { id: "s1", name: "Central Station", lat: BASE_LAT, lon: BASE_LON, parentStation: "PS1" },
        { id: "s2", name: "Central Station", lat: BASE_LAT + 0.0002, lon: BASE_LON, parentStation: "PS1" },
        { id: "s3", name: "Other Stop", lat: BASE_LAT + 1, lon: BASE_LON + 1 },
      ];

      const result = groupStops(stops);
      const parentGroup = result.find((g) => g.type === "parent_station");

      expect(parentGroup).toBeDefined();
      expect(parentGroup!.groupId).toBe("parent:PS1");
      expect(parentGroup!.stopIds).toContain("s1");
      expect(parentGroup!.stopIds).toContain("s2");
      expect(parentGroup!.stopIds).toHaveLength(2);
    });

    it("does not re-group parent_station stops in later strategies", () => {
      const stops: StopForGrouping[] = [
        // Two stops with parentStation — should be captured by strategy 1 only
        { id: "s1", name: "Central Station", lat: BASE_LAT, lon: BASE_LON, parentStation: "PS1" },
        { id: "s2", name: "Central Station", lat: BASE_LAT + 0.0002, lon: BASE_LON, parentStation: "PS1" },
      ];

      const result = groupStops(stops);

      // Only one group should contain s1/s2
      const groupsWithS1 = result.filter((g) => g.stopIds.includes("s1"));
      const groupsWithS2 = result.filter((g) => g.stopIds.includes("s2"));

      expect(groupsWithS1).toHaveLength(1);
      expect(groupsWithS2).toHaveLength(1);
      expect(groupsWithS1[0].type).toBe("parent_station");
      expect(groupsWithS2[0].type).toBe("parent_station");
    });

    it("uses the first member's name as group name", () => {
      const stops: StopForGrouping[] = [
        { id: "s1", name: "Airport Terminal A", lat: BASE_LAT, lon: BASE_LON, parentStation: "AIRPORT" },
        { id: "s2", name: "Airport Terminal B", lat: BASE_LAT, lon: BASE_LON + 0.001, parentStation: "AIRPORT" },
      ];

      const result = groupStops(stops);
      const group = result.find((g) => g.groupId === "parent:AIRPORT");
      expect(group).toBeDefined();
      expect(group!.name).toBe("Airport Terminal A");
    });
  });

  // ── Strategy 2: name_numbered ────────────────────────────────────────────

  describe("name_numbered grouping", () => {
    it("groups numbered suffix stops like 'Dworzec Glowny 01/02/03'", () => {
      const stops: StopForGrouping[] = [
        { id: "n1", name: "Dworzec Glowny 01", lat: BASE_LAT, lon: BASE_LON },
        { id: "n2", name: "Dworzec Glowny 02", lat: BASE_LAT + 0.001, lon: BASE_LON },
        { id: "n3", name: "Dworzec Glowny 03", lat: BASE_LAT - 0.001, lon: BASE_LON },
      ];

      const result = groupStops(stops);
      const group = result.find((g) => g.type === "name_numbered");

      expect(group).toBeDefined();
      expect(group!.groupId).toBe("numbered:Dworzec Glowny");
      expect(group!.name).toBe("Dworzec Glowny");
      expect(group!.stopIds).toHaveLength(3);
    });

    it("handles '01a' suffix variant", () => {
      const stops: StopForGrouping[] = [
        { id: "x1", name: "Market Square 01a", lat: BASE_LAT, lon: BASE_LON },
        { id: "x2", name: "Market Square 01b", lat: BASE_LAT + 0.001, lon: BASE_LON },
      ];

      const result = groupStops(stops);
      const group = result.find((g) => g.groupId === "numbered:Market Square");

      expect(group).toBeDefined();
      expect(group!.type).toBe("name_numbered");
      expect(group!.stopIds).toContain("x1");
      expect(group!.stopIds).toContain("x2");
    });

    it("does not create a numbered group for a single numbered stop", () => {
      const stops: StopForGrouping[] = [
        { id: "lone", name: "Bus Stop 01", lat: BASE_LAT, lon: BASE_LON },
      ];

      const result = groupStops(stops);
      const numberedGroup = result.find((g) => g.type === "name_numbered");
      expect(numberedGroup).toBeUndefined();

      // Should become a single-stop cluster instead
      const singleGroup = result.find((g) => g.stopIds.includes("lone"));
      expect(singleGroup).toBeDefined();
    });
  });

  // ── Strategy 3: name_cluster ─────────────────────────────────────────────

  describe("name_cluster grouping", () => {
    it("clusters same-name stops within 150 m", () => {
      // ~100 m apart (well within threshold)
      const stops: StopForGrouping[] = [
        { id: "c1", name: "Gedimino", lat: BASE_LAT, lon: BASE_LON },
        { id: "c2", name: "Gedimino", lat: BASE_LAT + 0.0009, lon: BASE_LON },
      ];

      const result = groupStops(stops);
      const cluster = result.find((g) => g.type === "name_cluster" && g.stopIds.length > 1);

      expect(cluster).toBeDefined();
      expect(cluster!.groupId).toMatch(/^cluster:Gedimino:/);
      expect(cluster!.stopIds).toContain("c1");
      expect(cluster!.stopIds).toContain("c2");
    });

    it("does not cluster same-name stops more than 150 m apart", () => {
      // ~200 m apart — beyond threshold
      const stops: StopForGrouping[] = [
        { id: "f1", name: "Far Stop", lat: BASE_LAT, lon: BASE_LON },
        { id: "f2", name: "Far Stop", lat: BASE_LAT + 0.0018, lon: BASE_LON },
      ];

      const result = groupStops(stops);
      const clusters = result.filter(
        (g) => g.type === "name_cluster" && g.name === "Far Stop",
      );

      // Two separate single-stop groups
      expect(clusters).toHaveLength(2);
      expect(clusters.every((c) => c.stopIds.length === 1)).toBe(true);
    });

    it("keeps a single ungrouped stop as a single-stop group", () => {
      const stops: StopForGrouping[] = [
        { id: "solo", name: "Unique Corner", lat: BASE_LAT, lon: BASE_LON },
      ];

      const result = groupStops(stops);

      expect(result).toHaveLength(1);
      expect(result[0].groupId).toBe("single:solo");
      expect(result[0].stopIds).toEqual(["solo"]);
      expect(result[0].type).toBe("name_cluster");
    });
  });

  // ── Mixed scenarios ──────────────────────────────────────────────────────

  describe("mixed strategies", () => {
    it("applies all three strategies without double-grouping", () => {
      const stops: StopForGrouping[] = [
        // parent_station group
        { id: "p1", name: "Station", lat: BASE_LAT, lon: BASE_LON, parentStation: "ST" },
        { id: "p2", name: "Station", lat: BASE_LAT + 0.0001, lon: BASE_LON, parentStation: "ST" },
        // numbered group
        { id: "n1", name: "Market 01", lat: BASE_LAT + 0.01, lon: BASE_LON },
        { id: "n2", name: "Market 02", lat: BASE_LAT + 0.02, lon: BASE_LON },
        // cluster group
        { id: "c1", name: "Park", lat: BASE_LAT + 0.1, lon: BASE_LON },
        { id: "c2", name: "Park", lat: BASE_LAT + 0.1009, lon: BASE_LON },
        // lone stop
        { id: "l1", name: "Lone", lat: BASE_LAT + 0.5, lon: BASE_LON },
      ];

      const result = groupStops(stops);

      // Each stop appears in exactly one group
      const allStopIds = result.flatMap((g) => g.stopIds);
      const uniqueIds = new Set(allStopIds);
      expect(uniqueIds.size).toBe(allStopIds.length); // no duplicates

      expect(result.some((g) => g.type === "parent_station")).toBe(true);
      expect(result.some((g) => g.type === "name_numbered")).toBe(true);
      expect(result.some((g) => g.type === "name_cluster")).toBe(true);
    });

    it("all 7 stops from mixed scenario are covered", () => {
      const stops: StopForGrouping[] = [
        { id: "p1", name: "Station", lat: BASE_LAT, lon: BASE_LON, parentStation: "ST" },
        { id: "p2", name: "Station", lat: BASE_LAT + 0.0001, lon: BASE_LON, parentStation: "ST" },
        { id: "n1", name: "Market 01", lat: BASE_LAT + 0.01, lon: BASE_LON },
        { id: "n2", name: "Market 02", lat: BASE_LAT + 0.02, lon: BASE_LON },
        { id: "c1", name: "Park", lat: BASE_LAT + 0.1, lon: BASE_LON },
        { id: "c2", name: "Park", lat: BASE_LAT + 0.1009, lon: BASE_LON },
        { id: "l1", name: "Lone", lat: BASE_LAT + 0.5, lon: BASE_LON },
      ];

      const result = groupStops(stops);
      const coveredIds = new Set(result.flatMap((g) => g.stopIds));

      for (const stop of stops) {
        expect(coveredIds.has(stop.id)).toBe(true);
      }
    });
  });
});
