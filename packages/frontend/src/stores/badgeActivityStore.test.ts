import { describe, it, expect, beforeEach } from "vitest";
import { useBadgeActivityStore } from "../stores/badgeActivityStore.ts";

beforeEach(() => useBadgeActivityStore.getState().clear());

describe("badgeActivityStore", () => {
  it("stores and reads a ready activity", () => {
    useBadgeActivityStore.getState().set("S", { state: "ready", routeIds: new Set(["R1"]) });
    const a = useBadgeActivityStore.getState().byStop.get("S");
    expect(a).toEqual({ state: "ready", routeIds: new Set(["R1"]) });
  });

  it("retains last-known entries when overwritten (no wholesale clear on update)", () => {
    const s = useBadgeActivityStore.getState();
    s.set("S", { state: "ready", routeIds: new Set(["R1"]) });
    s.set("T", { state: "loading" });
    expect(useBadgeActivityStore.getState().byStop.get("S")).toEqual({ state: "ready", routeIds: new Set(["R1"]) });
  });

  it("evicts stops not in the keep-set", () => {
    const s = useBadgeActivityStore.getState();
    s.set("S", { state: "ready", routeIds: new Set() });
    s.set("T", { state: "ready", routeIds: new Set() });
    s.evictExcept(new Set(["S"]));
    expect(useBadgeActivityStore.getState().byStop.has("S")).toBe(true);
    expect(useBadgeActivityStore.getState().byStop.has("T")).toBe(false);
  });
});
