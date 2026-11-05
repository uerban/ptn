import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { db } from "../db/index.ts";
import { geocoderRegistry } from "./geocoder/instance.ts";
import { setSearchModeAccessor, __resetSearchModeAccessorForTests } from "./searchSuggestions.ts";

describe("AC-14 — saved/recent remain readable offline in server-side mode", () => {
  beforeEach(async () => {
    await db.savedLocations.clear();
    await db.recentLocations.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("seeded saved/recent rows are retrievable without consulting the geocoder registry", async () => {
    await db.savedLocations.put({
      id: "s1", label: "Home", lat: 54.35, lon: 18.6, savedAt: 1,
    } as never);
    await db.recentLocations.put({
      id: "r1", lat: 54.36, lon: 18.61, usedAt: 2,
    } as never);

    const forwardSpy = vi.spyOn(geocoderRegistry, "forward");

    const saved = await db.savedLocations.toArray();
    const recent = await db.recentLocations.toArray();

    expect(saved.map((r) => r.id)).toEqual(["s1"]);
    expect(recent.map((r) => r.id)).toEqual(["r1"]);
    // The saved-places read path does NOT go through the registry — offline-safe.
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it("AC-6: under server-side with the geocoder DOWN, saved/recents are still retrievable with no registry call for them", async () => {
    __resetSearchModeAccessorForTests();
    setSearchModeAccessor(() => "server-side");
    await db.savedLocations.put({ id: "s1", label: "Home", lat: 54.35, lon: 18.6, savedAt: 1 } as never);
    await db.recentLocations.put({ id: "r1", lat: 54.36, lon: 18.61, usedAt: 2 } as never);

    // Geocoder DOWN: forward throws. The saved/recents read path must not touch it.
    const forwardSpy = vi.spyOn(geocoderRegistry, "forward").mockRejectedValue(new Error("down"));

    const saved = await db.savedLocations.toArray();
    const recent = await db.recentLocations.toArray();

    expect(saved.map((r) => r.id)).toEqual(["s1"]);
    expect(recent.map((r) => r.id)).toEqual(["r1"]);
    expect(forwardSpy).not.toHaveBeenCalled();   // saved/recents are registry-independent
    __resetSearchModeAccessorForTests();
  });
});
