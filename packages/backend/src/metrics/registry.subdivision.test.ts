import { describe, it, expect } from "vitest";
import { createMetricsRegistry } from "./registry.js";

describe("schedule-tile subdivision gauges + counter", () => {
  it("registers the three subdivision gauges + the cumulative oversized-leaf counter, all with a city label", async () => {
    const reg = createMetricsRegistry();
    reg.scheduleTileOversizedLeaves.set({ city: "paris" }, 2);
    reg.scheduleTileMaxLeafBytes.set({ city: "paris" }, 3_600_000);
    reg.scheduleTileLeavesPerBundle.set({ city: "paris" }, 17);
    reg.scheduleTileOversizedLeafTotal.inc({ city: "paris" }, 2);

    const json = await reg.registry.getMetricsAsJSON();
    const names = json.map((m) => m.name);
    expect(names).toContain("pt_schedule_tile_oversized_leaves");
    expect(names).toContain("pt_schedule_tile_max_leaf_bytes");
    expect(names).toContain("pt_schedule_tile_leaves_per_bundle");
    expect(names).toContain("pt_schedule_tile_oversized_leaf_total");

    const oversized = json.find((m) => m.name === "pt_schedule_tile_oversized_leaves");
    expect(oversized!.values[0]!.labels).toEqual({ city: "paris" });
    expect(oversized!.values[0]!.value).toBe(2);

    const total = json.find((m) => m.name === "pt_schedule_tile_oversized_leaf_total");
    expect(total!.values[0]!.labels).toEqual({ city: "paris" });
    expect(total!.values[0]!.value).toBe(2);
  });
});
