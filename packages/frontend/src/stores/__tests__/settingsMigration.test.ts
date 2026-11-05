import { describe, it, expect } from "vitest";
import {
  migrateExcludedModes,
  migrateModeColorOverrideKeys,
  sanitizePerCityOverrides,
} from "../settingsStore";
import { useCityStore } from "../cityStore";

describe("settings migration: CABLE_CAR split", () => {
  it("remaps a persisted CABLE_CAR exclusion to CABLE_TRAM + AERIAL", () => {
    expect(new Set(migrateExcludedModes(["CABLE_CAR", "BUS"]))).toEqual(
      new Set(["CABLE_TRAM", "AERIAL", "BUS"]),
    );
  });
  it("drops unknown strings (tolerant)", () => {
    expect(migrateExcludedModes(["FOO", "BUS"])).toEqual(["BUS"]);
  });
  it("remaps a CABLE_CAR colour-override key to CABLE_TRAM (best-effort)", () => {
    expect(migrateModeColorOverrideKeys({ CABLE_CAR: "#111" })).toEqual({ CABLE_TRAM: "#111" });
    // does not clobber an existing CABLE_TRAM key
    expect(migrateModeColorOverrideKeys({ CABLE_CAR: "#111", CABLE_TRAM: "#222" }))
      .toEqual({ CABLE_TRAM: "#222" });
  });
  it("returns [] for an empty stored array", () => {
    expect(migrateExcludedModes([])).toEqual([]);
  });
  it("dedups when CABLE_CAR and AERIAL are both already present", () => {
    expect(new Set(migrateExcludedModes(["CABLE_CAR", "AERIAL"]))).toEqual(
      new Set(["CABLE_TRAM", "AERIAL"]),
    );
  });
  it("drops non-string entries (storage corruption)", () => {
    expect(migrateExcludedModes([null, 42, "BUS"] as unknown[])).toEqual(["BUS"]);
  });
  it("migrateModeColorOverrideKeys is a no-op (copy) when no CABLE_CAR key", () => {
    const input = { BUS: "#111" };
    const out = migrateModeColorOverrideKeys(input);
    expect(out).toEqual({ BUS: "#111" });
    expect(out).not.toBe(input); // returns a copy, not the same reference
  });

  it("rehydrates a legacy-FLAT CABLE_CAR colour override → CABLE_TRAM (not dropped)", () => {
    // Old persisted FLAT shape (pre per-city) containing the legacy CABLE_CAR
    // key. The detection predicate must recognise it as the old-flat shape
    // (despite CABLE_CAR no longer being in VALID_TRANSPORT_MODES) so it is
    // routed through sanitizeModeColorOverrides → migrateModeColorOverrideKeys.
    const cityId = useCityStore.getState().activeCity.id;
    const result = sanitizePerCityOverrides({ CABLE_CAR: "#111" }, {});
    // sanitizeModeColorOverrides expands the 3-digit hex to 6 digits.
    expect(result).toEqual({ [cityId]: { CABLE_TRAM: "#111111" } });
  });

  it("rehydrates legacy-FLAT mix of valid + legacy CABLE_CAR keys", () => {
    const cityId = useCityStore.getState().activeCity.id;
    const result = sanitizePerCityOverrides({ BUS: "#222", CABLE_CAR: "#333" }, {});
    expect(result).toEqual({ [cityId]: { BUS: "#222222", CABLE_TRAM: "#333333" } });
  });
});
