import { describe, it, expect } from "vitest";
import {
  clusterRouteColors,
  ciede2000,
  nameColorCluster,
  hashStringToUnit,
  generateRouteColor,
} from "./colorClustering.js";
import type { TransportMode } from "@pt/shared";

/** Helper to build a route input. */
function route(
  id: string,
  shortName: string,
  mode: TransportMode,
  color = "",
) {
  return { id, shortName, color, mode };
}

describe("colorClustering", () => {
  describe("hashStringToUnit", () => {
    it("returns a value in [0, 1)", () => {
      for (const s of ["1", "42", "100", "A", "Tram 7", ""]) {
        const v = hashStringToUnit(s);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });

    it("is deterministic", () => {
      expect(hashStringToUnit("42")).toBe(hashStringToUnit("42"));
      expect(hashStringToUnit("abc")).toBe(hashStringToUnit("abc"));
    });

    it("produces different values for different inputs", () => {
      const vals = new Set(
        ["1", "2", "3", "10", "20", "100", "A", "B"].map(hashStringToUnit),
      );
      // At least 6 distinct values out of 8
      expect(vals.size).toBeGreaterThanOrEqual(6);
    });
  });

  describe("generateRouteColor", () => {
    it("returns a valid hex color", () => {
      const hex = generateRouteColor("42", "BUS");
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    });

    it("is deterministic for the same shortName and mode", () => {
      expect(generateRouteColor("10", "BUS")).toBe(
        generateRouteColor("10", "BUS"),
      );
    });

    it("produces different colors for different shortNames within the same mode", () => {
      const colors = new Set(
        ["1", "2", "5", "10", "50", "100", "200", "300"].map((sn) =>
          generateRouteColor(sn, "BUS"),
        ),
      );
      // At least 5 distinct colors out of 8
      expect(colors.size).toBeGreaterThanOrEqual(5);
    });

    it("generates colors within the mode's hue family", () => {
      // BUS colors should all be different from TRAM colors in general
      const busColors = ["1", "2", "3", "4", "5"].map((sn) =>
        generateRouteColor(sn, "BUS"),
      );
      const tramColors = ["1", "2", "3", "4", "5"].map((sn) =>
        generateRouteColor(sn, "TRAM"),
      );
      // Bus and tram palettes should be distinct (high deltaE between averages)
      // Check that at least some bus/tram pairs have deltaE > 15
      let highDeltaCount = 0;
      for (const bc of busColors) {
        for (const tc of tramColors) {
          if (ciede2000(bc, tc) > 15) highDeltaCount++;
        }
      }
      expect(highDeltaCount).toBeGreaterThan(0);
    });

    it("handles unknown mode gracefully", () => {
      const hex = generateRouteColor("42", "WALK");
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    });
  });

  describe("clusterRouteColors with colored routes", () => {
    it("preserves original behavior for routes with colors", () => {
      const routes = [
        route("r1", "1", "BUS", "#ff0000"),
        route("r2", "2", "BUS", "#ff1111"),
        route("r3", "3", "BUS", "#00ff00"),
        route("r4", "4", "BUS", "#00ee00"),
      ];
      const result = clusterRouteColors(routes);
      // All 4 routes should be assigned
      expect(result.routeSubModeMap.size).toBe(4);
      // Should produce 2 color clusters (red-ish and green-ish)
      expect(result.subModes.length).toBe(2);
      // Every route must be mapped
      for (const r of routes) {
        expect(result.routeSubModeMap.has(r.id)).toBe(true);
      }
    });

    it("creates a single sub-mode for identically colored routes", () => {
      const routes = [
        route("r1", "1", "TRAM", "#16a34a"),
        route("r2", "2", "TRAM", "#16a34a"),
        route("r3", "3", "TRAM", "#16a34a"),
      ];
      const result = clusterRouteColors(routes);
      expect(result.subModes.length).toBe(1);
      expect(result.subModes[0].id).toBe("TRAM");
    });
  });

  describe("clusterRouteColors with no colors (the monochrome fix)", () => {
    it("assigns the default color when <= 3 colorless routes", () => {
      const routes = [
        route("r1", "1", "BUS"),
        route("r2", "2", "BUS"),
        route("r3", "3", "BUS"),
      ];
      const result = clusterRouteColors(routes);
      // Should get exactly 1 sub-mode with default color
      expect(result.subModes.length).toBe(1);
      expect(result.subModes[0].color).toBe("#1d4ed8");
      expect(result.subModes[0].id).toBe("BUS");
    });

    it("generates varied colors at exactly the threshold (4 colorless routes)", () => {
      const routes = Array.from({ length: 4 }, (_, i) =>
        route(`r${i}`, String(i + 1), "BUS"),
      );
      const result = clusterRouteColors(routes);
      expect(result.subModes.length).toBeGreaterThan(1);
      expect(result.routeSubModeMap.size).toBe(4);
      for (const sm of result.subModes) {
        expect(sm.parentMode).toBe("BUS");
      }
    });

    it("generates varied colors when many routes lack color data", () => {
      const routes = Array.from({ length: 20 }, (_, i) =>
        route(`r${i}`, String(i + 1), "BUS"),
      );
      const result = clusterRouteColors(routes);

      // Should produce multiple sub-modes, not just one
      expect(result.subModes.length).toBeGreaterThan(1);

      // Every route must still be mapped
      expect(result.routeSubModeMap.size).toBe(20);

      // All sub-modes should have the correct parent mode
      for (const sm of result.subModes) {
        expect(sm.parentMode).toBe("BUS");
      }

      // Colors should not all be the same
      const uniqueColors = new Set(result.subModes.map((sm) => sm.color));
      expect(uniqueColors.size).toBeGreaterThan(1);
    });

    it("generates varied colors for trams too", () => {
      const routes = Array.from({ length: 15 }, (_, i) =>
        route(`t${i}`, String(i + 1), "TRAM"),
      );
      const result = clusterRouteColors(routes);

      expect(result.subModes.length).toBeGreaterThan(1);
      expect(result.routeSubModeMap.size).toBe(15);

      for (const sm of result.subModes) {
        expect(sm.parentMode).toBe("TRAM");
      }
    });

    it("produces deterministic results across runs", () => {
      const routes = Array.from({ length: 10 }, (_, i) =>
        route(`r${i}`, String(i + 1), "BUS"),
      );
      const result1 = clusterRouteColors(routes);
      const result2 = clusterRouteColors(routes);

      expect(result1.subModes.length).toBe(result2.subModes.length);
      for (let i = 0; i < result1.subModes.length; i++) {
        expect(result1.subModes[i].color).toBe(result2.subModes[i].color);
        expect(result1.subModes[i].id).toBe(result2.subModes[i].id);
      }
    });

    it("sub-mode IDs contain the hex color for generated clusters", () => {
      const routes = Array.from({ length: 8 }, (_, i) =>
        route(`r${i}`, String(i + 1), "BUS"),
      );
      const result = clusterRouteColors(routes);

      for (const sm of result.subModes) {
        // Each generated sub-mode ID should be BUS:<hex>
        expect(sm.id).toMatch(/^BUS:/);
        expect(sm.color).toMatch(/^#[0-9a-f]{6}$/);
      }
    });

    it("total routeCount across sub-modes equals the input count", () => {
      const routes = Array.from({ length: 12 }, (_, i) =>
        route(`r${i}`, String(i + 1), "TRAM"),
      );
      const result = clusterRouteColors(routes);
      const totalRouteCount = result.subModes.reduce(
        (sum, sm) => sum + sm.routeCount,
        0,
      );
      expect(totalRouteCount).toBe(12);
    });
  });

  describe("mixed: some routes with color, some without", () => {
    it("handles a mix of colored and colorless routes", () => {
      const routes = [
        // 3 routes with color
        route("c1", "C1", "BUS", "#ff0000"),
        route("c2", "C2", "BUS", "#ff1100"),
        route("c3", "C3", "BUS", "#0000ff"),
        // 2 routes without color (below threshold)
        route("nc1", "NC1", "BUS"),
        route("nc2", "NC2", "BUS"),
      ];
      const result = clusterRouteColors(routes);

      // All routes mapped
      expect(result.routeSubModeMap.size).toBe(5);

      // The colorless routes should get the default BUS sub-mode
      expect(result.routeSubModeMap.get("nc1")).toBe("BUS");
      expect(result.routeSubModeMap.get("nc2")).toBe("BUS");
    });

    it("uses default for colorless routes even when many, if colored clusters exist", () => {
      const routes = [
        route("c1", "C1", "BUS", "#ff0000"),
        route("c2", "C2", "BUS", "#ff1100"),
        // 5 routes without color — above threshold but colored clusters exist
        ...Array.from({ length: 5 }, (_, i) =>
          route(`nc${i}`, `NC${i}`, "BUS"),
        ),
      ];
      const result = clusterRouteColors(routes);

      // The colorless routes should get default since validClusters.length > 0
      for (let i = 0; i < 5; i++) {
        expect(result.routeSubModeMap.get(`nc${i}`)).toBe("BUS");
      }
    });
  });

  describe("nameColorCluster", () => {
    it("labels a blue color correctly", () => {
      const r = nameColorCluster("#1d4ed8", "BUS");
      expect(r.label).toBe("Bus (blue)");
      expect(r.colorName).toBe("blue");
    });

    it("labels a green color correctly", () => {
      const r = nameColorCluster("#16a34a", "TRAM");
      expect(r.label).toBe("Tram (green)");
      expect(r.colorName).toBe("green");
    });

    it("returns structured label with colorName", () => {
      const result = nameColorCluster("#1d4ed8", "BUS");
      expect(result.label).toContain("Bus");
      expect(result.colorName).toBeDefined();
      expect(typeof result.colorName).toBe("string");
    });

    it("returns black colorName for very dark colors", () => {
      const dark = nameColorCluster("#000000", "BUS");
      expect(dark.colorName).toBe("black");
    });
  });

  describe("sub-mode entries structured fields", () => {
    it("sole cluster: labelMode set, labelColor intentionally undefined", () => {
      const routes = [route("r1", "1", "BUS", "#ff0000")];
      const result = clusterRouteColors(routes);
      expect(result.subModes).toHaveLength(1);
      const sm = result.subModes[0];
      expect(sm.labelMode).toBe("BUS");
      expect(sm.labelColor).toBeUndefined();
    });

    it("per-cluster entries carry matching labelMode and a labelColor token", () => {
      const routes = [
        route("r1", "1", "BUS", "#ff0000"),
        route("r2", "2", "BUS", "#ff1111"),
        route("r3", "3", "BUS", "#00ff00"),
        route("r4", "4", "BUS", "#00ee00"),
      ];
      const result = clusterRouteColors(routes);
      expect(result.subModes).toHaveLength(2);
      for (const sm of result.subModes) {
        expect(sm.labelMode).toBe("BUS");
        expect(sm.labelColor).toBeDefined();
      }
      const colorNames = result.subModes.map((sm) => sm.labelColor).sort();
      expect(colorNames).toEqual(["green", "red"]);
    });

    it("default-color entry (few colorless routes): labelMode set, labelColor undefined", () => {
      const routes = [
        route("r1", "1", "BUS"),
        route("r2", "2", "BUS"),
        route("r3", "3", "BUS"),
      ];
      const result = clusterRouteColors(routes);
      expect(result.subModes).toHaveLength(1);
      expect(result.subModes[0].labelMode).toBe("BUS");
      expect(result.subModes[0].labelColor).toBeUndefined();
    });

    it("synthetic-cluster entries (many colorless routes): every entry has labelMode and a labelColor token", () => {
      const routes = Array.from({ length: 10 }, (_, i) =>
        route(`r${i}`, String(i + 1), "BUS"),
      );
      const result = clusterRouteColors(routes);
      expect(result.subModes.length).toBeGreaterThan(1);
      for (const sm of result.subModes) {
        expect(sm.labelMode).toBe("BUS");
        expect(sm.labelColor).toBeDefined();
      }
    });

    it("labelMode matches parentMode across mixed modes", () => {
      const routes = [
        route("b1", "B1", "BUS", "#ff0000"),
        route("t1", "T1", "TRAM", "#16a34a"),
      ];
      const result = clusterRouteColors(routes);
      for (const sm of result.subModes) {
        expect(sm.labelMode).toBe(sm.parentMode);
      }
    });
  });
});
