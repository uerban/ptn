import { describe, it, expect, beforeEach, vi } from "vitest";
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


it("rejects stale city and activity-window publications, including reused stop IDs", () => {
  const store = useBadgeActivityStore.getState();
  store.activateContext("city-a/window-2");
  store.setMany([["same-stop", { state: "ready", routeIds: new Set(["a"]) }]], "city-a/window-2");
  store.activateContext("city-b/window-2");
  expect(useBadgeActivityStore.getState().byStop.size).toBe(0);
  store.setMany([["same-stop", { state: "ready", routeIds: new Set(["a"]) }]], "city-a/window-2");
  expect(useBadgeActivityStore.getState().byStop.size).toBe(0);
  store.setMany([["same-stop", { state: "ready", routeIds: new Set(["b"]) }]], "city-b/window-2");
  store.activateContext("city-b/window-4");
  store.setMany([["same-stop", { state: "unavailable" }]], "city-b/window-2");
  expect(useBadgeActivityStore.getState().byStop.size).toBe(0);
});


it("holds a recent resolved verdict on refresh failure, then expires it", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    const store = useBadgeActivityStore.getState();
    store.setMany([["S", { state: "ready", routeIds: new Set(["R"]) }]]);
    clock.mockReturnValue(1_060_000);
    store.setMany([["S", { state: "unavailable" }]]);
    expect(useBadgeActivityStore.getState().byStop.get("S")?.state).toBe("ready");
    clock.mockReturnValue(1_120_000);
    store.setMany([["S", { state: "unavailable" }]]);
    expect(useBadgeActivityStore.getState().byStop.get("S")?.state).toBe("unavailable");
  } finally { clock.mockRestore(); }
});

it("retains nearby pan history within budget and prioritizes the current viewport", () => {
  const store = useBadgeActivityStore.getState();
  store.setMany(["a", "b", "c"].map(id => [id, { state: "loading" }]));
  store.retainViewport(new Set(["a"]), 2);
  expect([...useBadgeActivityStore.getState().byStop.keys()]).toEqual(["a", "c"]);
  store.retainViewport(new Set(["c"]), 2);
  expect(useBadgeActivityStore.getState().byStop.has("a")).toBe(true);
});
