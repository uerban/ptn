import { beforeEach, describe, it, expect } from "vitest";
import { useCityStore } from "./cityStore.ts";
import { effectiveExcludedModes, useSettingsStore } from "./settingsStore.ts";

beforeEach(() => {
  globalThis.localStorage?.removeItem("ptn-settings");
  useSettingsStore.getState().setExcludedModes([]);
});

describe("global mode choices and city defaults", () => {
  it("derives city defaults without persisting them into global exclusions", () => {
    useSettingsStore.setState({excludedModes: ["TRAM"], enabledModes: []});
    expect(effectiveExcludedModes(useSettingsStore.getState(), ["FERRY"])).toEqual(["TRAM", "FERRY"]);
    expect(effectiveExcludedModes(useSettingsStore.getState(), [])).toEqual(["TRAM"]);
    expect(useSettingsStore.getState().excludedModes).toEqual(["TRAM"]);
  });
  it("keeps explicit opt-ins and disabled modes global through city switches and rehydration", () => {
    const original = useCityStore.getState().activeCity;
    try {
      useSettingsStore.setState({excludedModes: ["TRAM"], enabledModes: []});
      useCityStore.setState({activeCity: {...original, id: "a", defaultExcludedModes: ["FERRY"]}});
      useSettingsStore.getState().toggleMode("FERRY");
      expect(useSettingsStore.getState().excludedModes).toEqual(["TRAM"]);
      expect(effectiveExcludedModes(useSettingsStore.getState(), ["FERRY"])).toEqual(["TRAM"]);
      useCityStore.setState({activeCity: {...original, id: "b", defaultExcludedModes: ["FERRY"]}});
      expect(effectiveExcludedModes(useSettingsStore.getState(), ["FERRY"])).toEqual(["TRAM"]);
      const stored = JSON.parse(localStorage.getItem("ptn-settings")!).state;
      const merged = useSettingsStore.persist.getOptions().merge!(stored, useSettingsStore.getInitialState());
      expect(effectiveExcludedModes(merged, ["FERRY"])).toEqual(["TRAM"]);
      useSettingsStore.getState().toggleMode("FERRY");
      expect(useSettingsStore.getState().excludedModes).toEqual(["TRAM", "FERRY"]);
      expect(effectiveExcludedModes(useSettingsStore.getState(), [])).toEqual(["TRAM", "FERRY"]);
    } finally { useCityStore.setState({activeCity: original}); }
  });
  it("preserves historical global exclusions without guessing their origin", () => {
    const merged = useSettingsStore.persist.getOptions().merge!({excludedModes: ["FERRY", "TRAM"]}, useSettingsStore.getInitialState());
    expect(merged.excludedModes).toEqual(["FERRY", "TRAM"]);
    expect(merged.enabledModes).toEqual([]);
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


it("migrates city aliases in colour/group maps while preserving current and unavailable-city choices", () => {
  const merged = useSettingsStore.persist.getOptions().merge!({
    modeColorOverrides: {gdansk: {BUS: "#112233", TRAM: "#223344"}, tricity: {BUS: "#445566"}, unavailable: {BUS: "#778899"}},
    excludedRouteGroupsByCity: {gdansk: ["old"], tricity: ["new"], unavailable: ["kept"]},
    excludedModes: ["METRO"],
  }, useSettingsStore.getInitialState());
  expect(merged.modeColorOverrides.tricity).toEqual({BUS: "#445566", TRAM: "#223344"});
  expect(merged.modeColorOverrides.unavailable).toEqual({BUS: "#778899"});
  expect(merged.excludedRouteGroupsByCity.tricity).toEqual(["old", "new"]);
  expect(merged.excludedRouteGroupsByCity.unavailable).toEqual(["kept"]);
  expect(merged.excludedModes).toEqual(["METRO"]);
});
