import { describe, it, expect } from "vitest";
import { generateRingColors } from "../../src/utils/stackedRing.ts";

describe("generateRingColors", () => {
  it("returns single color for one mode", () => {
    const colors = generateRingColors([{ mode: "BUS", color: "e53935" }]);
    expect(colors).toEqual(["#e53935"]);
  });

  it("returns distinct colors for multiple modes", () => {
    const colors = generateRingColors([
      { mode: "BUS", color: "e53935" },
      { mode: "TRAM", color: "1e88e5" },
    ]);
    expect(colors).toHaveLength(2);
    expect(colors[0]).toBe("#e53935");
    expect(colors[1]).toBe("#1e88e5");
  });

  it("deduplicates by color", () => {
    const colors = generateRingColors([
      { mode: "BUS", color: "e53935" },
      { mode: "BUS", color: "e53935" },
    ]);
    expect(colors).toHaveLength(1);
  });

  it("uses default color when no route color available", () => {
    const colors = generateRingColors([{ mode: "BUS" }]);
    expect(colors).toHaveLength(1);
    expect(colors[0]).toMatch(/^#/);
  });
});
