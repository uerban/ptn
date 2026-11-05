import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { routeTypeToMode } from "../ptbToBundleWire.js";

const golden = readFileSync(
  new URL("../__fixtures__/route-type-mode.golden.txt", import.meta.url),
  "utf8",
);

describe("routeTypeToMode (committed golden parity with pt-core)", () => {
  it("matches the exhaustive golden table", () => {
    const rows = golden.trimEnd().split("\n");
    expect(rows.length).toBe(1803);
    for (const row of rows) {
      const [rt, mode] = row.split(" ");
      expect(routeTypeToMode(Number(rt))).toBe(mode);
    }
  });

  it("pins the flip cases", () => {
    expect(routeTypeToMode(5)).toBe("CABLE_TRAM");
    expect(routeTypeToMode(6)).toBe("AERIAL");
    expect(routeTypeToMode(12)).toBe("METRO");
    expect(routeTypeToMode(1008)).toBe("FERRY");
    expect(routeTypeToMode(1700)).toBe("OTHER");
  });
});
