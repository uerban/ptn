import { describe, it, expect, beforeEach } from "vitest";
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
  beforeEach(() => {
    localStorage.clear();
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
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
    localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, JSON.stringify(base));
    expect(loadViewport()).toBeNull();
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("Standard stores the nearest cached stop centroid, not the exact center", () => {
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    const stops = [
      { location: { lat: 54.7, lon: 25.3 } },
      { location: { lat: 55, lon: 26 } },
    ];
    expect(saveViewport(base, stops)).toBe(true);
    const raw = JSON.parse(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)!).viewports[0];
    expect({ lat: raw.lat, lon: raw.lon }).toEqual(stops[0]!.location);
    expect(raw.privacyMode).toBe("snap-centroid");
  });

  it("Standard writes nothing when no cached stop centroid is available", () => {
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    expect(saveViewport(base, [])).toBe(false);
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("Hardened and Strict store 50 m and 100 m grid representations", () => {
    usePrivacyStore.setState({ level: "hardened", overrides: {} });
    expect(saveViewport(base)).toBe(true);
    const fifty = JSON.parse(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)!).viewports[0];
    expect(fifty.privacyMode).toBe("rounded-50m");
    expect({ lat: fifty.lat, lon: fifty.lon }).not.toEqual({
      lat: base.lat,
      lon: base.lon,
    });

    usePrivacyStore.setState({ level: "strict", overrides: {} });
    expect(saveViewport(base)).toBe(true);
    const hundred = JSON.parse(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)!).viewports[0];
    expect(hundred.privacyMode).toBe("rounded-100m");
  });

  it("a stricter privacy level immediately deletes a prohibited representation", () => {
    expect(saveViewport(base)).toBe(true);
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).not.toBeNull();
    usePrivacyStore.setState({ level: "hardened", overrides: {} });
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(loadViewport()).toBeNull();
  });

  it("removes malformed JSON", () => {
    localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, "{not json");
    expect(loadViewport()).toBeNull();
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

  it("rejects a viewport missing or with an empty cityId", () => {
    const { cityId: _omit, ...noCity } = base;
    localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, JSON.stringify(noCity));
    expect(loadViewport()).toBeNull();
    localStorage.setItem(
      MAP_VIEWPORT_STORAGE_KEY,
      JSON.stringify({ ...base, cityId: "" }),
    );
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
      localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, JSON.stringify(bad));
      expect(loadViewport()).toBeNull();
    }
  });

  it("clamps pitch and normalizes bearing", () => {
    localStorage.setItem(
      MAP_VIEWPORT_STORAGE_KEY,
      JSON.stringify({ ...base, pitch: 120, bearing: 400 }),
    );
    expect(loadViewport()?.pitch).toBe(60);
    expect(loadViewport()?.bearing).toBe(40);
  });
  it("keeps independent city positions through A → B → A and migrates a legacy viewport", () => {
    localStorage.setItem(MAP_VIEWPORT_STORAGE_KEY, JSON.stringify(base));
    const second = {...base, cityId: "krakow", lat: 50.06, lon: 19.94, zoom: 16};
    expect(saveViewport(second)).toBe(true);
    expect(loadViewport("vilnius")).toEqual(base);
    expect(loadViewport("krakow")).toEqual(second);
    expect(loadViewport("missing")).toBeNull();
    expect(loadViewport()).toEqual(second);
  });

  it("applies a stricter global floor to all cities without deleting already-compliant positions", () => {
    saveViewport(base);
    saveViewport({...base, cityId: "krakow"});
    usePrivacyStore.setState({level: "hardened", overrides: {}});
    expect(loadViewport("vilnius")).toBeNull();
    expect(loadViewport("krakow")).toBeNull();
    saveViewport(base);
    usePrivacyStore.setState({level: "baseline", overrides: {}});
    saveViewport({...base, cityId: "krakow"});
    usePrivacyStore.setState({level: "hardened", overrides: {}});
    expect(loadViewport("vilnius")).not.toBeNull();
    expect(loadViewport("krakow")).toBeNull();
  });

  it("removes every city's viewport when persistence is disabled", () => {
    saveViewport(base);
    saveViewport({...base, cityId: "krakow"});
    usePrivacyChoicesStore.getState().setChoice("viewport", "disabled");
    expect(loadViewport("vilnius")).toBeNull();
    expect(loadViewport("krakow")).toBeNull();
    expect(localStorage.getItem(MAP_VIEWPORT_STORAGE_KEY)).toBeNull();
  });

});
