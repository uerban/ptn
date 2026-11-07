import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { mapViewportItem, isSealedValue } from "../../src/services/sealedLocalStorage.ts";
import { resetPersonalStorage } from "../../src/test-helpers/personalStorage.ts";
import { usePrivacyChoicesStore } from "../../src/stores/privacyChoicesStore.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import {
  MAP_VIEWPORT_STORAGE_KEY,
  loadViewport,
  saveViewport,
  type SavedViewport,
} from "../../src/utils/mapViewport.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "../../src/services/privacyDataMigrationState.ts";

const base: SavedViewport = {
  cityId: "vilnius",
  lat: 54.68,
  lon: 25.28,
  zoom: 14,
  bearing: 30,
  pitch: 20,
};

describe("mapViewport", () => {
  // The stored area is sealed; `mapViewportItem` is its decrypted view.
  const stored = () => mapViewportItem.get();
  const store = (raw: string) => mapViewportItem.set(raw);

  beforeEach(async () => {
    localStorage.clear();
    await resetPersonalStorage();
    mapViewportItem.remove();
    await mapViewportItem.load();
    usePrivacyChoicesStore.getState().reset();
    usePrivacyStore.getState().reset();
    usePrivacyStore.setState({ level: "baseline", overrides: {} });
    localStorage.setItem(
      PRIVACY_DATA_MIGRATION_KEY,
      PRIVACY_DATA_MIGRATION_VERSION,
    );
    usePrivacyChoicesStore.getState().setChoice("viewport", "enabled");
  });

  it("round-trips an opted-in raw viewport at Baseline", () => {
    expect(saveViewport(base)).toBe(true);
    expect(loadViewport()).toEqual(base);
  });

  it("does not write or restore before opt-in", () => {
    usePrivacyChoicesStore.getState().setChoice("viewport", "unset");
    expect(saveViewport(base)).toBe(false);
    expect(stored()).toBeNull();
    store(JSON.stringify(base));
    expect(loadViewport()).toBeNull();
    expect(stored()).toBeNull();
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("Standard stores the nearest cached stop centroid, not the exact center", () => {
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    const stops = [
      { location: { lat: 54.7, lon: 25.3 } },
      { location: { lat: 55, lon: 26 } },
    ];
    expect(saveViewport(base, stops)).toBe(true);
    const raw = JSON.parse(stored()!);
    expect({ lat: raw.lat, lon: raw.lon }).toEqual(stops[0]!.location);
    expect(raw.privacyMode).toBe("snap-centroid");
  });

  it("Standard writes nothing when no cached stop centroid is available", () => {
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    expect(saveViewport(base, [])).toBe(false);
    expect(stored()).toBeNull();
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("Hardened and Strict store 50 m and 100 m grid representations", () => {
    usePrivacyStore.setState({ level: "hardened", overrides: {} });
    expect(saveViewport(base)).toBe(true);
    const fifty = JSON.parse(stored()!);
    expect(fifty.privacyMode).toBe("rounded-50m");
    expect({ lat: fifty.lat, lon: fifty.lon }).not.toEqual({
      lat: base.lat,
      lon: base.lon,
    });

    usePrivacyStore.setState({ level: "strict", overrides: {} });
    expect(saveViewport(base)).toBe(true);
    const hundred = JSON.parse(stored()!);
    expect(hundred.privacyMode).toBe("rounded-100m");
  });

  it("a stricter privacy level immediately deletes a prohibited representation", async () => {
    expect(saveViewport(base)).toBe(true);
    await vi.waitFor(() =>
      expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).not.toBeNull(),
    );
    usePrivacyStore.setState({ level: "hardened", overrides: {} });
    expect(stored()).toBeNull();
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(loadViewport()).toBeNull();
  });

  it("removes malformed JSON", () => {
    store("{not json");
    expect(loadViewport()).toBeNull();
    expect(stored()).toBeNull();
  });

  it("rejects a viewport missing or with an empty cityId", () => {
    const { cityId: _omit, ...noCity } = base;
    store(JSON.stringify(noCity));
    expect(loadViewport()).toBeNull();
    store(JSON.stringify({ ...base, cityId: "" }));
    expect(loadViewport()).toBeNull();
  });

  it("rejects out-of-range lat/lon/zoom", () => {
    for (const bad of [
      { ...base, lat: 91 },
      { ...base, lon: -181 },
      { ...base, zoom: -1 },
      { ...base, zoom: 9e9 },
      { ...base, zoom: Number.NaN },
    ]) {
      store(JSON.stringify(bad));
      expect(loadViewport()).toBeNull();
    }
  });

  it("clamps pitch and normalizes bearing", () => {
    store(JSON.stringify({ ...base, pitch: 120, bearing: 400 }));
    expect(loadViewport()?.pitch).toBe(60);
    expect(loadViewport()?.bearing).toBe(40);
  });

  it("keeps the stored area sealed and restores it after a reload", async () => {
    const exact = { ...base, lat: 54.681234, lon: 25.281234 };
    expect(saveViewport(exact)).toBe(true);
    await vi.waitFor(() =>
      expect(isSealedValue(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY))).toBe(true),
    );
    const raw = localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)!;
    for (const leak of ["54.681234", "25.281234", "vilnius", "privacyMode"]) {
      expect(raw).not.toContain(leak);
    }

    await mapViewportItem.load();
    expect(loadViewport()).toEqual(exact);
  });
});
