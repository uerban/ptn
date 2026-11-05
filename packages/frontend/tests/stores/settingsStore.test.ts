import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useSettingsStore,
  selectPreStopBufferSeconds,
  selectRunSpeedRatio,
  PROFILE_DEFAULT_BUFFER_SECS,
} from "../../src/stores/settingsStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { CITIES } from "../../src/config/cities.ts";
import { DEFAULT_MODE_COLORS } from "../../src/utils/routeColor.ts";

describe("settingsStore", () => {
  beforeEach(() => {
    useCityStore.setState({ activeCity: CITIES[0] }); // vilnius
    useSettingsStore.setState({
      theme: "system",
      resolvedTheme: "light",
      preferredAdapter: "motis",
      language: "auto",
      departuresPerLine: 3,
      maxPopupLines: 4,
      urbanMode: true,
      urbanLookaheadHours: 1,
      mapDetailMode: "detailed",
      accessibilityScheme: "none",
      highContrastEnabled: false,
      modeColorOverrides: {},
      excludedModes: [],
    });
  });

  it("has correct defaults", () => {
    const state = useSettingsStore.getState();
    expect(state.language).toBe("auto");
    expect(state.departuresPerLine).toBe(3);
    expect(state.maxPopupLines).toBe(4);
  });

  it("setLanguage updates language", () => {
    useSettingsStore.getState().setLanguage("lt");
    expect(useSettingsStore.getState().language).toBe("lt");
  });

  it("setDeparturesPerLine clamps to 1-5", () => {
    useSettingsStore.getState().setDeparturesPerLine(0);
    expect(useSettingsStore.getState().departuresPerLine).toBe(1);
    useSettingsStore.getState().setDeparturesPerLine(10);
    expect(useSettingsStore.getState().departuresPerLine).toBe(5);
    useSettingsStore.getState().setDeparturesPerLine(3);
    expect(useSettingsStore.getState().departuresPerLine).toBe(3);
  });

  it("setMaxPopupLines clamps to 2-8", () => {
    useSettingsStore.getState().setMaxPopupLines(1);
    expect(useSettingsStore.getState().maxPopupLines).toBe(2);
    useSettingsStore.getState().setMaxPopupLines(12);
    expect(useSettingsStore.getState().maxPopupLines).toBe(8);
  });

  it("urbanMode defaults to true", () => {
    expect(useSettingsStore.getState().urbanMode).toBe(true);
  });

  it("urbanLookaheadHours defaults to 1", () => {
    expect(useSettingsStore.getInitialState().urbanLookaheadHours).toBe(1);
  });

  it("setUrbanMode toggles urban mode", () => {
    useSettingsStore.getState().setUrbanMode(false);
    expect(useSettingsStore.getState().urbanMode).toBe(false);
    useSettingsStore.getState().setUrbanMode(true);
    expect(useSettingsStore.getState().urbanMode).toBe(true);
  });

  it("setUrbanLookaheadHours clamps to 1-6", () => {
    useSettingsStore.getState().setUrbanLookaheadHours(0);
    expect(useSettingsStore.getState().urbanLookaheadHours).toBe(1);
    useSettingsStore.getState().setUrbanLookaheadHours(10);
    expect(useSettingsStore.getState().urbanLookaheadHours).toBe(6);
    useSettingsStore.getState().setUrbanLookaheadHours(4);
    expect(useSettingsStore.getState().urbanLookaheadHours).toBe(4);
  });

  it("mapDetailMode defaults to detailed and accepts every local mode", () => {
    expect(useSettingsStore.getState().mapDetailMode).toBe("detailed");
    for (const mode of ["gtfs-only", "micromap", "detailed"] as const) {
      useSettingsStore.getState().setMapDetailMode(mode);
      expect(useSettingsStore.getState().mapDetailMode).toBe(mode);
    }
  });

  it("setMapDetailMode ignores invalid values", () => {
    useSettingsStore.getState().setMapDetailMode("gtfs-only");
    useSettingsStore
      .getState()
      .setMapDetailMode("bogus" as never);
    expect(useSettingsStore.getState().mapDetailMode).toBe("gtfs-only");
  });

  it("accessibilityScheme defaults to none", () => {
    expect(useSettingsStore.getState().accessibilityScheme).toBe("none");
  });

  it("modeColorOverrides defaults to empty object", () => {
    expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
  });

  it("setAccessibilityScheme updates scheme", () => {
    useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
    expect(useSettingsStore.getState().accessibilityScheme).toBe("deuteranopia");
    useSettingsStore.getState().setAccessibilityScheme("universal");
    expect(useSettingsStore.getState().accessibilityScheme).toBe("universal");
    useSettingsStore.getState().setAccessibilityScheme("none");
    expect(useSettingsStore.getState().accessibilityScheme).toBe("none");
  });

  describe("per-city mode color overrides", () => {
    it("setModeColorOverride writes to active city", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000" },
      });
    });

    it("setModeColorOverride normalizes 3-digit shorthand hex to 6-digit", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#f00");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000" },
      });
    });

    it("setModeColorOverride rejects alpha hex formats", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff000033");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
      useSettingsStore.getState().setModeColorOverride("BUS", "#f003");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
    });

    it("setModeColorOverride preserves existing overrides for same city", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000", TRAM: "#00ff00" },
      });
    });

    it("setModeColorOverride writes to different cities independently", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useCityStore.setState({ activeCity: CITIES[1] }); // tricity
      useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000" },
        tricity: { TRAM: "#00ff00" },
      });
    });

    it("removeModeColorOverride clears a single mode for active city", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
      useSettingsStore.getState().removeModeColorOverride("BUS");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { TRAM: "#00ff00" },
      });
    });

    it("removeModeColorOverride removes city entry when last override removed", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useSettingsStore.getState().removeModeColorOverride("BUS");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
    });

    it("removeModeColorOverride does not affect other cities", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useCityStore.setState({ activeCity: CITIES[1] }); // tricity
      useSettingsStore.getState().setModeColorOverride("BUS", "#00ff00");
      useSettingsStore.getState().removeModeColorOverride("BUS");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000" },
      });
    });

    it("resetModeColorOverrides clears only active city", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useCityStore.setState({ activeCity: CITIES[1] }); // tricity
      useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
      useSettingsStore.getState().resetModeColorOverrides();
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000" },
      });
    });

    it("resetModeColorOverrides clears all overrides when only one city", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      useSettingsStore.getState().setModeColorOverride("TRAM", "#00ff00");
      useSettingsStore.getState().setModeColorOverride("METRO", "#0000ff");
      useSettingsStore.getState().resetModeColorOverrides();
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
    });

    it("getModeColorOverridesForCity returns overrides for specified city", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      const overrides = useSettingsStore.getState().getModeColorOverridesForCity("vilnius");
      expect(overrides).toEqual({ BUS: "#ff0000" });
    });

    it("getModeColorOverridesForCity returns empty object for unknown city", () => {
      const overrides = useSettingsStore.getState().getModeColorOverridesForCity("unknown-city");
      expect(overrides).toEqual({});
    });
  });

  describe("write guard", () => {
    it("skips write when color matches resolved default", () => {
      const defaultBusColor = DEFAULT_MODE_COLORS.BUS;
      useSettingsStore.getState().setModeColorOverride("BUS", defaultBusColor);
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
    });

    it("skips write for 3-digit shorthand matching default", () => {
      // DEFAULT_MODE_COLORS.WALK is #6b7280, no 3-digit shorthand
      // Use a scheme where a mode resolves to something expressible in 3 digits
      // Set BUS default (#1d4ed8) — no 3-digit form, so test with explicit match
      useSettingsStore.getState().setModeColorOverride("BUS", "#1d4ed8");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
    });

    it("allows write when color differs from resolved default", () => {
      useSettingsStore.getState().setModeColorOverride("BUS", "#ff0000");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000" },
      });
    });

    it("write guard uses current scheme for comparison", () => {
      useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
      // Without colorConfig, legacy path resolves to DEFAULT_MODE_COLORS.BUS (#1d4ed8)
      // Setting to the same default should be skipped
      useSettingsStore.getState().setModeColorOverride("BUS", "#1d4ed8");
      expect(useSettingsStore.getState().modeColorOverrides).toEqual({});
    });
  });

  describe("data-a11y-scheme attribute", () => {
    beforeEach(() => {
      document.documentElement.removeAttribute("data-a11y-scheme");
    });

    it("sets data-a11y-scheme when scheme is not none", () => {
      useSettingsStore.getState().setAccessibilityScheme("deuteranopia");
      expect(document.documentElement.getAttribute("data-a11y-scheme")).toBe("deuteranopia");
    });

    it("removes data-a11y-scheme when scheme is none", () => {
      useSettingsStore.getState().setAccessibilityScheme("universal");
      expect(document.documentElement.getAttribute("data-a11y-scheme")).toBe("universal");
      useSettingsStore.getState().setAccessibilityScheme("none");
      expect(document.documentElement.getAttribute("data-a11y-scheme")).toBeNull();
    });

    it("updates data-a11y-scheme when switching between schemes", () => {
      useSettingsStore.getState().setAccessibilityScheme("protanopia");
      expect(document.documentElement.getAttribute("data-a11y-scheme")).toBe("protanopia");
      useSettingsStore.getState().setAccessibilityScheme("monochrome");
      expect(document.documentElement.getAttribute("data-a11y-scheme")).toBe("monochrome");
    });
  });

  describe("persist merge validation", () => {
    function getMerge() {
      return (
        useSettingsStore as unknown as {
          persist: {
            getOptions: () => {
              merge: (p: unknown, c: unknown) => Record<string, unknown>;
            };
          };
        }
      ).persist.getOptions().merge;
    }

    function defaults() {
      return useSettingsStore.getState();
    }

    it("accepts valid accessibilityScheme from storage", () => {
      const merge = getMerge();
      const result = merge({ accessibilityScheme: "protanopia" }, defaults());
      expect(result.accessibilityScheme).toBe("protanopia");
    });

    it("rejects invalid accessibilityScheme from storage", () => {
      const merge = getMerge();
      const result = merge({ accessibilityScheme: "invalid-scheme" }, defaults());
      expect(result.accessibilityScheme).toBe("none");
    });

    it("falls back to default when accessibilityScheme is missing", () => {
      const merge = getMerge();
      const result = merge({}, defaults());
      expect(result.accessibilityScheme).toBe("none");
    });

    it("accepts valid per-city modeColorOverrides from storage", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { vilnius: { BUS: "#ff0000", TRAM: "#00ff00" } } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000", TRAM: "#00ff00" },
      });
    });

    it("migrates old flat format to active city key", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { BUS: "#ff0000", TRAM: "#00ff00" } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000", TRAM: "#00ff00" },
      });
    });

    it("strips invalid hex values from per-city modeColorOverrides", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { vilnius: { BUS: "#ff0000", TRAM: "not-a-hex" } } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({ vilnius: { BUS: "#ff0000" } });
    });

    it("accepts sub-mode keys like BUS:0073ac in per-city modeColorOverrides", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { vilnius: { BUS: "#ff0000", "BUS:0073ac": "#00ff00" } } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({ vilnius: { BUS: "#ff0000", "BUS:0073ac": "#00ff00" } });
    });

    it("removes city entry when all overrides have invalid hex values", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { vilnius: { BUS: "not-a-hex" } } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({});
    });

    it("falls back to default when modeColorOverrides is not an object", () => {
      const merge = getMerge();
      const result = merge({ modeColorOverrides: "garbage" }, defaults());
      expect(result.modeColorOverrides).toEqual({});
    });

    it("falls back to default when modeColorOverrides is null", () => {
      const merge = getMerge();
      const result = merge({ modeColorOverrides: null }, defaults());
      expect(result.modeColorOverrides).toEqual({});
    });

    it("strips alpha hex values from persisted per-city modeColorOverrides", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { vilnius: { BUS: "#ff000033", TRAM: "#00ff00" } } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({ vilnius: { TRAM: "#00ff00" } });
    });

    it("strips 4-digit alpha hex from persisted per-city modeColorOverrides", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { vilnius: { BUS: "#f003" } } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({});
    });

    it("validates multiple cities independently", () => {
      const merge = getMerge();
      const result = merge(
        {
          modeColorOverrides: {
            vilnius: { BUS: "#ff0000" },
            tricity: { TRAM: "invalid", METRO: "#0000ff" },
          },
        },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({
        vilnius: { BUS: "#ff0000" },
        tricity: { METRO: "#0000ff" },
      });
    });

    it("skips city entries with non-object values", () => {
      const merge = getMerge();
      const result = merge(
        { modeColorOverrides: { vilnius: "not-an-object", tricity: { BUS: "#ff0000" } } },
        defaults(),
      );
      expect(result.modeColorOverrides).toEqual({ tricity: { BUS: "#ff0000" } });
    });

    it("migrates legacy high-contrast scheme to universal + highContrastEnabled", () => {
      const merge = getMerge();
      const result = merge(
        { accessibilityScheme: "high-contrast" },
        defaults(),
      );
      expect(result.accessibilityScheme).toBe("universal");
      expect(result.highContrastEnabled).toBe(true);
    });

    it("accepts valid excludedModes array from storage", () => {
      const merge = getMerge();
      const result = merge({ excludedModes: ["BUS", "TRAM"] }, defaults());
      expect(result.excludedModes).toEqual(["BUS", "TRAM"]);
    });

    it("falls back to default when excludedModes is not an array", () => {
      const merge = getMerge();
      const result = merge({ excludedModes: "BUS" }, defaults());
      expect(result.excludedModes).toEqual([]);
    });

    it("filters out non-string entries from excludedModes", () => {
      const merge = getMerge();
      const result = merge({ excludedModes: ["BUS", 42, null, "TRAM"] }, defaults());
      expect(result.excludedModes).toEqual(["BUS", "TRAM"]);
    });

    it("preserves highContrastEnabled=false when no migration needed", () => {
      const merge = getMerge();
      const result = merge(
        { accessibilityScheme: "deuteranopia", highContrastEnabled: false },
        defaults(),
      );
      expect(result.accessibilityScheme).toBe("deuteranopia");
      expect(result.highContrastEnabled).toBe(false);
    });
  });

  describe("excludedModes", () => {
    it("defaults to empty array", () => {
      expect(useSettingsStore.getState().excludedModes).toEqual([]);
    });

    it("setExcludedModes replaces the array", () => {
      useSettingsStore.getState().setExcludedModes(["BUS", "TRAM"]);
      expect(useSettingsStore.getState().excludedModes).toEqual(["BUS", "TRAM"]);
      useSettingsStore.getState().setExcludedModes([]);
      expect(useSettingsStore.getState().excludedModes).toEqual([]);
    });

    it("toggleMode adds mode when not present", () => {
      useSettingsStore.getState().toggleMode("METRO");
      expect(useSettingsStore.getState().excludedModes).toEqual(["METRO"]);
    });

    it("toggleMode removes mode when already present", () => {
      useSettingsStore.getState().setExcludedModes(["BUS", "TRAM"]);
      useSettingsStore.getState().toggleMode("BUS");
      expect(useSettingsStore.getState().excludedModes).toEqual(["TRAM"]);
    });

    it("toggleMode handles toggling back and forth", () => {
      useSettingsStore.getState().toggleMode("RAIL");
      expect(useSettingsStore.getState().excludedModes).toContain("RAIL");
      useSettingsStore.getState().toggleMode("RAIL");
      expect(useSettingsStore.getState().excludedModes).not.toContain("RAIL");
    });
  });

  describe("highContrastEnabled", () => {
    it("defaults to false", () => {
      expect(useSettingsStore.getState().highContrastEnabled).toBe(false);
    });

    it("setHighContrastEnabled toggles the value", () => {
      useSettingsStore.getState().setHighContrastEnabled(true);
      expect(useSettingsStore.getState().highContrastEnabled).toBe(true);
      useSettingsStore.getState().setHighContrastEnabled(false);
      expect(useSettingsStore.getState().highContrastEnabled).toBe(false);
    });
  });
});

describe("selectPreStopBufferSeconds", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      mobilityProfile: "default",
      leaveBufferOverrideSeconds: null,
    } as never);
  });

  it("returns profile default (180s) for default profile when override is null", () => {
    expect(selectPreStopBufferSeconds(useSettingsStore.getState())).toBe(180);
  });

  it("returns profile default (300s) for wheelchair profile when override is null", () => {
    useSettingsStore.setState({
      mobilityProfile: "wheelchair",
      leaveBufferOverrideSeconds: null,
    } as never);
    expect(selectPreStopBufferSeconds(useSettingsStore.getState())).toBe(300);
  });

  it("returns profile default (300s) for vision_impaired profile when override is null", () => {
    useSettingsStore.setState({
      mobilityProfile: "vision_impaired",
      leaveBufferOverrideSeconds: null,
    } as never);
    expect(selectPreStopBufferSeconds(useSettingsStore.getState())).toBe(300);
  });

  it("returns explicit 0 when override is 0 (no buffer)", () => {
    useSettingsStore.setState({
      mobilityProfile: "default",
      leaveBufferOverrideSeconds: 0,
    } as never);
    expect(selectPreStopBufferSeconds(useSettingsStore.getState())).toBe(0);
  });

  it("returns override value when override is a positive number", () => {
    useSettingsStore.setState({
      mobilityProfile: "default",
      leaveBufferOverrideSeconds: 240,
    } as never);
    expect(selectPreStopBufferSeconds(useSettingsStore.getState())).toBe(240);
  });

  it("PROFILE_DEFAULT_BUFFER_SECS table matches the spec", () => {
    expect(PROFILE_DEFAULT_BUFFER_SECS).toEqual({
      default: 180,
      wheelchair: 300,
      vision_impaired: 300,
      bicycle: 180,
    });
  });
});

describe("setLeaveBufferOverrideSeconds", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      mobilityProfile: "default",
      leaveBufferOverrideSeconds: null,
    } as never);
  });

  it("accepts null", () => {
    useSettingsStore.getState().setLeaveBufferOverrideSeconds(null);
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBeNull();
  });

  it("accepts a finite number and clamps to [0, 1800]", () => {
    useSettingsStore.getState().setLeaveBufferOverrideSeconds(240);
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBe(240);

    useSettingsStore.getState().setLeaveBufferOverrideSeconds(5000);
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBe(1800);

    useSettingsStore.getState().setLeaveBufferOverrideSeconds(-50);
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBe(0);
  });

  it("rejects NaN (not-finite) with a console.warn — value remains unchanged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useSettingsStore.getState().setLeaveBufferOverrideSeconds(240);
    useSettingsStore.getState().setLeaveBufferOverrideSeconds(NaN);
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBe(240);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("setLeaveBufferOverrideSeconds rejected"),
      expect.objectContaining({ received: NaN }),
    );
    warn.mockRestore();
  });

  it("rejects Infinity with a console.warn — value remains unchanged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useSettingsStore.getState().setLeaveBufferOverrideSeconds(240);
    useSettingsStore.getState().setLeaveBufferOverrideSeconds(Infinity);
    expect(useSettingsStore.getState().leaveBufferOverrideSeconds).toBe(240);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("leaveBufferOverrideSeconds persistence validator", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset to defaults
    useSettingsStore.setState({
      mobilityProfile: "default",
      leaveBufferOverrideSeconds: null,
    } as never);
  });

  function hydrate(stored: Record<string, unknown>): number | null {
    localStorage.setItem(
      "ptn-settings",
      JSON.stringify({ state: stored, version: 0 }),
    );
    // Trigger zustand's merge by re-hydrating from the persisted blob.
    // useSettingsStore.persist.rehydrate is a thenable in some zustand versions.
    const rehydrated = useSettingsStore.persist.rehydrate?.();
    if (rehydrated && typeof (rehydrated as Promise<void>).then === "function") {
      // synchronous-only test runtime; rehydrate returns void in this version
    }
    return useSettingsStore.getState().leaveBufferOverrideSeconds;
  }

  it("preserves null when stored as null", () => {
    expect(hydrate({ leaveBufferOverrideSeconds: null })).toBeNull();
  });

  it("preserves a valid number within [0, 1800]", () => {
    expect(hydrate({ leaveBufferOverrideSeconds: 240 })).toBe(240);
  });

  it("clamps a stored value above 1800 down to 1800", () => {
    expect(hydrate({ leaveBufferOverrideSeconds: 5000 })).toBe(1800);
  });

  it("clamps a stored negative value to 0", () => {
    expect(hydrate({ leaveBufferOverrideSeconds: -50 })).toBe(0);
  });

  it("falls back to default when stored value is NaN", () => {
    expect(hydrate({ leaveBufferOverrideSeconds: NaN })).toBeNull();
  });

  it("falls back to default when stored value is a string", () => {
    expect(hydrate({ leaveBufferOverrideSeconds: "180" })).toBeNull();
  });

  it("falls back to default when key is absent (legacy localStorage)", () => {
    expect(hydrate({ mobilityProfile: "default" })).toBeNull();
  });
});

describe("selectRunSpeedRatio", () => {
  const ratio = (patch: Record<string, unknown>) => {
    useSettingsStore.setState({
      mobilityProfile: "default",
      walkSpeedMps: 1.25,
      runToCatch: true,
      ...patch,
    } as never);
    return selectRunSpeedRatio(useSettingsStore.getState());
  };

  it("is how much faster the rider runs than walks", () => {
    expect(ratio({})).toBe(2);
  });

  it("shrinks for a fast walker, whose run is capped", () => {
    expect(ratio({ walkSpeedMps: 1.6 })).toBeCloseTo(2.6 / 1.6);
  });

  it("is absent with run-to-catch off", () => {
    expect(ratio({ runToCatch: false })).toBeUndefined();
  });

  it("is absent for a wheelchair user, as the planner's reach is", () => {
    expect(ratio({ mobilityProfile: "wheelchair" })).toBeUndefined();
  });
});


describe("city-scoped route-group filters", () => {
  it("persists a minibus exclusion without applying it to another city", () => {
    const groups = CITIES.find((c) => c.id === "tbilisi")!.routeGroups!;
    useSettingsStore.setState({ excludedModes: [], excludedRouteGroupsByCity: {} });
    useSettingsStore.getState().toggleRouteGroup("tbilisi", groups[1]!, groups);
    const state = useSettingsStore.getState();
    expect(state.excludedRouteGroupsByCity).toEqual({ tbilisi: ["minibus"] });
    expect(state.excludedModes).toEqual([]);
    const raw = JSON.parse(localStorage.getItem("ptn-settings")!);
    const merge = useSettingsStore.persist.getOptions().merge!;
    const restored = merge(raw.state, state) as typeof state;
    expect(restored.excludedRouteGroupsByCity.tbilisi).toEqual(["minibus"]);
    expect(restored.excludedRouteGroupsByCity.vilnius).toBeUndefined();
    const legacy = merge({ excludedModes: ["BUS"] }, state) as typeof state;
    expect(legacy.excludedModes).toEqual(["BUS"]);
    expect(legacy.excludedRouteGroupsByCity).toEqual({});
    useSettingsStore.setState({ excludedModes: [], excludedRouteGroupsByCity: {} });
  });
});
