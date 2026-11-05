import { beforeEach, describe, it, expect } from "vitest";
import { useSettingsStore } from "./settingsStore.ts";

beforeEach(() => {
  globalThis.localStorage?.removeItem("ptn-settings");
  useSettingsStore.getState().setExcludedModes([]);
});

// `applyCityModeDefaults` seeds a city's default-excluded modes once per
// session. The session tracker is module-scoped (not resettable from a test),
// so each case uses a distinct cityId to start from an un-seeded state; the
// idempotency case calls twice with the same id within the one test.
describe("settingsStore — applyCityModeDefaults", () => {
  it("seeds the city's default-excluded modes into excludedModes", () => {
    useSettingsStore.getState().applyCityModeDefaults("seed-city-a", ["FERRY"]);
    expect(useSettingsStore.getState().excludedModes).toEqual(["FERRY"]);
  });

  it("is a no-op when the city declares no defaults", () => {
    useSettingsStore.getState().applyCityModeDefaults("seed-city-b", []);
    expect(useSettingsStore.getState().excludedModes).toEqual([]);
  });

  it("preserves pre-existing exclusions and does not duplicate", () => {
    useSettingsStore.getState().setExcludedModes(["TRAM", "FERRY"]);
    useSettingsStore.getState().applyCityModeDefaults("seed-city-c", ["FERRY"]);
    expect(useSettingsStore.getState().excludedModes).toEqual(["TRAM", "FERRY"]);
  });

  it("only seeds once per city per session — a later opt-in is not undone", () => {
    useSettingsStore.getState().applyCityModeDefaults("seed-city-d", ["FERRY"]);
    expect(useSettingsStore.getState().excludedModes).toEqual(["FERRY"]);

    // User opts back in (toggles ferry on), then the seeding effect re-runs
    // for the same city (e.g. navigating back to Search). The default must
    // NOT be re-applied — the opt-in stands for the rest of the session.
    useSettingsStore.getState().toggleMode("FERRY");
    expect(useSettingsStore.getState().excludedModes).toEqual([]);

    useSettingsStore.getState().applyCityModeDefaults("seed-city-d", ["FERRY"]);
    expect(useSettingsStore.getState().excludedModes).toEqual([]);
  });

  it("seeds distinct cities independently", () => {
    useSettingsStore.getState().applyCityModeDefaults("seed-city-e", ["FERRY"]);
    useSettingsStore.getState().applyCityModeDefaults("seed-city-f", ["METRO"]);
    expect(useSettingsStore.getState().excludedModes).toEqual(["FERRY", "METRO"]);
  });
});

describe("poiFetchModeOverride", () => {
  it("defaults to undefined and round-trips a set value", () => {
    expect(useSettingsStore.getState().poiFetchModeOverride).toBeUndefined();
    useSettingsStore.getState().setPoiFetchModeOverride("lazy-tile");
    expect(useSettingsStore.getState().poiFetchModeOverride).toBe("lazy-tile");
    useSettingsStore.getState().setPoiFetchModeOverride(undefined);
    expect(useSettingsStore.getState().poiFetchModeOverride).toBeUndefined();
  });
});

describe("poiFetchModeOverride persistence — server-side round-trip (AC-1)", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.getState().setPoiFetchModeOverride(undefined);
  });

  it("setPoiFetchModeOverride('server-side') survives serialize → merge → rehydrate", () => {
    useSettingsStore.getState().setPoiFetchModeOverride("server-side");
    const raw = localStorage.getItem("ptn-settings");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    // zustand persist nests the snapshot under `state`.
    const stored = parsed.state ?? parsed;
    // The production `merge(persistedState, currentState)` is defined inline in
    // the persist() options — invoke the SAME function so the real validator
    // (isPoiFetchMode over POI_FETCH_MODES) runs. The persisted arg is the inner
    // state object (the field-by-field merge reads `stored?.poiFetchModeOverride`).
    const merge = useSettingsStore.persist.getOptions().merge!;
    const merged = merge(stored, useSettingsStore.getState()) as { poiFetchModeOverride?: string };
    expect(merged.poiFetchModeOverride).toBe("server-side");
  });

  it("a persisted garbage poiFetchModeOverride rehydrates to undefined (validator contract)", () => {
    const merge = useSettingsStore.persist.getOptions().merge!;
    const merged = merge({ poiFetchModeOverride: "bogus" }, useSettingsStore.getState()) as { poiFetchModeOverride?: string };
    expect(merged.poiFetchModeOverride).toBeUndefined();
  });
});


describe("settingsStore — ordinary destinations by default", () => {
  const merge = useSettingsStore.persist.getOptions().merge!;

  it("includes extended POIs on fresh installs", () => {
    expect(useSettingsStore.getInitialState().poiIncludeLooseTier).toBe(true);
  });

  it.each([undefined, {}, { poiIncludeLooseTier: false }, { poiIncludeLooseTier: true }])(
    "migrates legacy settings %j to include extended POIs",
    (stored) => {
      const state = merge(stored, useSettingsStore.getInitialState());
      expect(state.poiIncludeLooseTier).toBe(true);
      expect(state.poiIncludeLooseTierUserSet).toBe(false);
    },
  );

  it.each([false, true])("preserves an explicit choice (%s) across persistence", (enabled) => {
    useSettingsStore.getState().setPoiIncludeLooseTier(enabled);
    const stored = JSON.parse(localStorage.getItem("ptn-settings")!).state;
    const state = merge(stored, useSettingsStore.getInitialState());
    expect(state.poiIncludeLooseTier).toBe(enabled);
    expect(state.poiIncludeLooseTierUserSet).toBe(true);
  });

  it("does not interpret a malformed marker as an explicit opt-out", () => {
    const state = merge(
      { poiIncludeLooseTier: false, poiIncludeLooseTierUserSet: "true" },
      useSettingsStore.getInitialState(),
    );
    expect(state.poiIncludeLooseTier).toBe(true);
  });
});


describe("loose POI category preferences", () => {
  const merge = useSettingsStore.persist.getOptions().merge!;
  it.each([false, true])("migrates the explicit legacy toggle (%s)", (enabled) => {
    const migrated = merge({ poiIncludeLooseTier: enabled, poiIncludeLooseTierUserSet: true }, useSettingsStore.getInitialState());
    expect(migrated.poiLooseCategories).toEqual(enabled
      ? ["school", "kindergarten", "retail", "tourism", "named_bus_stop"] : []);
  });
  it("preserves a partial selection across persistence", () => {
    useSettingsStore.getState().setPoiLooseCategories(["kindergarten", "retail"]);
    const stored = JSON.parse(localStorage.getItem("ptn-settings")!).state;
    const migrated = merge(stored, useSettingsStore.getInitialState());
    expect(migrated.poiLooseCategories).toEqual(["kindergarten", "retail"]);
    expect(migrated.poiIncludeLooseTier).toBe(true);
    expect(migrated.poiIncludeLooseTierUserSet).toBe(true);
  });
  it("preserves an empty selection and rejects unknown/duplicate categories", () => {
    const migrated = merge({ poiLooseCategories: ["unknown", "school", null, "school"] }, useSettingsStore.getInitialState());
    expect(migrated.poiLooseCategories).toEqual(["school"]);
    useSettingsStore.getState().setPoiLooseCategories([]);
    const stored = JSON.parse(localStorage.getItem("ptn-settings")!).state;
    const rehydrated = merge(stored, useSettingsStore.getInitialState());
    expect(rehydrated.poiLooseCategories).toEqual([]);
    expect(rehydrated.poiIncludeLooseTier).toBe(false);
  });
});
