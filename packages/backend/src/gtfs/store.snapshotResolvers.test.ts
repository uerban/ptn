import { describe, it, expect } from "vitest";
import { GtfsStore } from "./store.js";

describe("GtfsStore.snapshotRouteResolvers (copy semantics)", () => {
  it("is immune to a later color-map replacement (what computeColorConfig does on swap)", () => {
    const store = new GtfsStore();
    (store as any).routeSubModeMap = new Map([["R1", "EXPRESS"]]);
    (store as any).subModeById = new Map([["EXPRESS", { color: "#111111" }]]);
    const snap = store.snapshotRouteResolvers();
    expect(snap.resolveRouteColor("R1")).toBe("#111111");
    expect(snap.resolveRouteSubMode("R1")).toBe("EXPRESS");
    (store as any).routeSubModeMap = new Map([["R1", "LOCAL"]]);
    (store as any).subModeById = new Map([["LOCAL", { color: "#222222" }]]);
    expect(snap.resolveRouteColor("R1")).toBe("#111111"); // frozen
    expect(snap.resolveRouteSubMode("R1")).toBe("EXPRESS");
  });
});
