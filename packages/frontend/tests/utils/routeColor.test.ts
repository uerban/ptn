import { describe, it, expect } from "vitest";
import {
  resolveRouteColor,
  resolveRouteStyle,
  contrastTextColor,
  DEFAULT_MODE_COLORS,
  ACCESSIBILITY_SCHEME_VALUES,
  MONOCHROME_PATTERNS,
  type AccessibilityScheme,
  type RouteStyle,
} from "../../src/utils/routeColor.ts";
import type { ColorConfig } from "@pt/shared";

describe("resolveRouteColor", () => {
  it("returns user override when set, ignoring GTFS color", () => {
    const result = resolveRouteColor("e53935", "BUS", { BUS: "#ff00ff" }, "none");
    expect(result).toBe("#ff00ff");
  });

  it("returns user override when set, ignoring active scheme", () => {
    const result = resolveRouteColor(undefined, "BUS", { BUS: "#ff00ff" }, "deuteranopia");
    expect(result).toBe("#ff00ff");
  });

  it("returns GTFS color when no user override", () => {
    const result = resolveRouteColor("e53935", "BUS", {}, "none");
    expect(result).toBe("#e53935");
  });

  it("returns GTFS color over active scheme", () => {
    const result = resolveRouteColor("e53935", "BUS", {}, "deuteranopia");
    expect(result).toBe("#e53935");
  });

  it("returns default mode color in legacy path when scheme active but no colorConfig", () => {
    const result = resolveRouteColor(undefined, "BUS", {}, "deuteranopia");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("returns default mode color as last resort", () => {
    const result = resolveRouteColor(undefined, "BUS", {}, "none");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("normalizes GTFS color without hash prefix", () => {
    const result = resolveRouteColor("1d4ed8", "BUS", {}, "none");
    expect(result).toBe("#1d4ed8");
  });

  it("normalizes GTFS color with hash prefix", () => {
    const result = resolveRouteColor("#1d4ed8", "BUS", {}, "none");
    expect(result).toBe("#1d4ed8");
  });

  it("normalizes user override without hash prefix", () => {
    const result = resolveRouteColor(undefined, "TRAM", { TRAM: "abcdef" }, "none");
    expect(result).toBe("#abcdef");
  });

  it("strips alpha channel from 8-digit GTFS color", () => {
    const result = resolveRouteColor("1d4ed8ff", "BUS", {}, "none");
    expect(result).toBe("#1d4ed8");
  });

  it("strips alpha channel from 4-digit shorthand GTFS color", () => {
    const result = resolveRouteColor("#f0fa", "BUS", {}, "none");
    expect(result).toBe("#ff00ff");
  });

  it("expands 3-digit shorthand GTFS color to 6-digit", () => {
    const result = resolveRouteColor("f00", "BUS", {}, "none");
    expect(result).toBe("#ff0000");
  });

  it("treats empty GTFS color as absent", () => {
    const result = resolveRouteColor("", "TRAM", {}, "none");
    expect(result).toBe(DEFAULT_MODE_COLORS.TRAM);
  });

  it("treats whitespace-only GTFS color as absent", () => {
    const result = resolveRouteColor("   ", "TRAM", {}, "none");
    expect(result).toBe(DEFAULT_MODE_COLORS.TRAM);
  });

  it("falls through invalid GTFS hex to default in legacy path", () => {
    const result = resolveRouteColor("GGGGGG", "BUS", {}, "deuteranopia");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("falls through invalid GTFS hex to default color", () => {
    const result = resolveRouteColor("GGGGGG", "BUS", {}, "none");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("falls through wrong-length GTFS hex to default color", () => {
    const result = resolveRouteColor("12345", "BUS", {}, "none");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("falls through invalid user override to GTFS color", () => {
    const result = resolveRouteColor("e53935", "BUS", { BUS: "notahex" }, "none");
    expect(result).toBe("#e53935");
  });

  it("monochrome resolveRouteColor returns solid hex for modes with hex backgrounds", () => {
    // RAIL has a solid hex background in MONOCHROME_PATTERNS
    const resultLight = resolveRouteColor(undefined, "RAIL", {}, "monochrome", "light");
    expect(resultLight).toBe(MONOCHROME_PATTERNS.RAIL.light.background);

    const resultDark = resolveRouteColor(undefined, "RAIL", {}, "monochrome", "dark");
    expect(resultDark).toBe(MONOCHROME_PATTERNS.RAIL.dark.background);
  });

  it("monochrome resolveRouteColor falls back to default for patterned modes", () => {
    // BUS has a gradient background, so resolveRouteColor falls back to DEFAULT_MODE_COLORS
    const result = resolveRouteColor(undefined, "BUS", {}, "monochrome", "light");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("GTFS color takes priority over monochrome pattern", () => {
    const result = resolveRouteColor("e53935", "BUS", {}, "monochrome", "dark");
    expect(result).toBe("#e53935");
  });

  it("monochrome falls back to default when theme is omitted for patterned mode", () => {
    const result = resolveRouteColor(undefined, "BUS", {}, "monochrome");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("legacy path returns default color when scheme active and no GTFS color (dark)", () => {
    const result = resolveRouteColor(undefined, "BUS", {}, "deuteranopia", "dark");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("legacy path returns default color when scheme active and no GTFS color (light)", () => {
    const result = resolveRouteColor(undefined, "BUS", {}, "deuteranopia", "light");
    expect(result).toBe(DEFAULT_MODE_COLORS.BUS);
  });

  it("resolves correctly for all modes with each scheme", () => {
    for (const scheme of ACCESSIBILITY_SCHEME_VALUES) {
      const result = resolveRouteColor(undefined, "FERRY", {}, scheme);
      expect(result).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("DEFAULT_MODE_COLORS", () => {
  it("has entries for all transport modes", () => {
    const expectedModes = [
      "BUS", "TRAM", "METRO", "RAIL", "FERRY", "CABLE_TRAM", "AERIAL", "OTHER",
      "FUNICULAR", "WALK", "BIKE", "BIKE_SHARE", "SCOOTER", "CAR",
    ];
    for (const mode of expectedModes) {
      expect(DEFAULT_MODE_COLORS[mode as keyof typeof DEFAULT_MODE_COLORS]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});


describe("contrastTextColor", () => {
  it("returns black for white background", () => {
    expect(contrastTextColor("#ffffff")).toBe("#000000");
  });

  it("returns white for black background", () => {
    expect(contrastTextColor("#000000")).toBe("#ffffff");
  });

  it("returns black for light background", () => {
    expect(contrastTextColor("#f0f0f0")).toBe("#000000");
  });

  it("returns white for dark background", () => {
    expect(contrastTextColor("#1a1a1a")).toBe("#ffffff");
  });

  it("handles shorthand hex", () => {
    expect(contrastTextColor("#fff")).toBe("#000000");
    expect(contrastTextColor("#000")).toBe("#ffffff");
  });

  it("strips alpha before computing contrast", () => {
    // #000000ff is opaque black - should return white
    expect(contrastTextColor("#000000ff")).toBe("#ffffff");
    // #ffffff80 - alpha stripped, treated as white - should return black
    expect(contrastTextColor("#ffffff80")).toBe("#000000");
  });
});

describe("MONOCHROME_PATTERNS", () => {
  const modes = Object.keys(DEFAULT_MODE_COLORS) as Array<keyof typeof DEFAULT_MODE_COLORS>;

  it("has entries for all transport modes", () => {
    for (const mode of modes) {
      expect(MONOCHROME_PATTERNS[mode]).toBeDefined();
      expect(MONOCHROME_PATTERNS[mode].light).toBeDefined();
      expect(MONOCHROME_PATTERNS[mode].dark).toBeDefined();
    }
  });

  it("each entry has background and color properties", () => {
    for (const mode of modes) {
      for (const theme of ["light", "dark"] as const) {
        const style = MONOCHROME_PATTERNS[mode][theme];
        expect(style.background, `${mode}.${theme}.background`).toBeTruthy();
        expect(style.color, `${mode}.${theme}.color`).toBeTruthy();
      }
    }
  });

  it("patterned modes have textStroke and paintOrder", () => {
    const patternedModes = ["BUS", "TRAM", "METRO", "FERRY", "CABLE_TRAM"] as const;
    for (const mode of patternedModes) {
      for (const theme of ["light", "dark"] as const) {
        const style = MONOCHROME_PATTERNS[mode][theme];
        expect(style.textStroke, `${mode}.${theme}.textStroke`).toBeTruthy();
        expect(style.paintOrder, `${mode}.${theme}.paintOrder`).toBe("stroke fill");
      }
    }
  });

  it("solid modes have no textStroke or paintOrder", () => {
    const solidModes = ["RAIL", "AERIAL", "OTHER", "FUNICULAR", "WALK", "BIKE", "BIKE_SHARE", "SCOOTER", "CAR"] as const;
    for (const mode of solidModes) {
      for (const theme of ["light", "dark"] as const) {
        const style = MONOCHROME_PATTERNS[mode][theme];
        expect(style.textStroke, `${mode}.${theme}.textStroke`).toBeUndefined();
        expect(style.paintOrder, `${mode}.${theme}.paintOrder`).toBeUndefined();
      }
    }
  });

  it("each mode has a distinct pattern type", () => {
    // BUS: diagonal (45deg), TRAM: dots (radial), METRO: horizontal (180deg),
    // FERRY: crosshatch (-45deg), CABLE_TRAM: vertical (90deg)
    const lightBg = (mode: keyof typeof MONOCHROME_PATTERNS) =>
      MONOCHROME_PATTERNS[mode].light.background;
    expect(lightBg("BUS")).toContain("45deg");
    expect(lightBg("TRAM")).toContain("radial-gradient");
    expect(lightBg("METRO")).toContain("180deg");
    expect(lightBg("FERRY")).toContain("-45deg");
    expect(lightBg("CABLE_TRAM")).toContain("90deg");
  });
});

describe("resolveRouteStyle", () => {
  it("returns pattern style for monochrome light theme", () => {
    const style = resolveRouteStyle(undefined, "BUS", {}, "monochrome", "light");
    expect(style).toEqual(MONOCHROME_PATTERNS.BUS.light);
    expect(style.textStroke).toBeDefined();
    expect(style.paintOrder).toBe("stroke fill");
  });

  it("returns pattern style for monochrome dark theme", () => {
    const style = resolveRouteStyle(undefined, "BUS", {}, "monochrome", "dark");
    expect(style).toEqual(MONOCHROME_PATTERNS.BUS.dark);
  });

  it("defaults to light monochrome pattern when theme is omitted", () => {
    const style = resolveRouteStyle(undefined, "TRAM", {}, "monochrome");
    expect(style).toEqual(MONOCHROME_PATTERNS.TRAM.light);
  });

  it("returns hex-based style for non-monochrome schemes", () => {
    const style = resolveRouteStyle(undefined, "BUS", {}, "deuteranopia", "light");
    expect(style.background).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(style.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(style.textStroke).toBeUndefined();
    expect(style.paintOrder).toBeUndefined();
  });

  it("returns hex-based style for 'none' scheme", () => {
    const style = resolveRouteStyle("e53935", "BUS", {}, "none");
    expect(style.background).toBe("#e53935");
    expect(style.color).toBe(contrastTextColor("#e53935"));
  });

  it("uses GTFS color for non-monochrome schemes", () => {
    const style = resolveRouteStyle("00ff00", "TRAM", {}, "deuteranopia");
    expect(style.background).toBe("#00ff00");
    expect(style.color).toBe(contrastTextColor("#00ff00"));
  });

  it("uses user override for non-monochrome schemes", () => {
    const style = resolveRouteStyle("e53935", "BUS", { BUS: "#abcdef" }, "none");
    expect(style.background).toBe("#abcdef");
  });

  it("monochrome ignores GTFS color and user override", () => {
    const style = resolveRouteStyle("e53935", "BUS", { BUS: "#abcdef" }, "monochrome", "light");
    expect(style).toEqual(MONOCHROME_PATTERNS.BUS.light);
  });

  it("returns correct style for each mode in monochrome", () => {
    const modes = Object.keys(DEFAULT_MODE_COLORS) as Array<keyof typeof DEFAULT_MODE_COLORS>;
    for (const mode of modes) {
      const lightStyle = resolveRouteStyle(undefined, mode, {}, "monochrome", "light");
      expect(lightStyle, `light ${mode}`).toEqual(MONOCHROME_PATTERNS[mode].light);
      const darkStyle = resolveRouteStyle(undefined, mode, {}, "monochrome", "dark");
      expect(darkStyle, `dark ${mode}`).toEqual(MONOCHROME_PATTERNS[mode].dark);
    }
  });

  it("resolves correctly for all modes with each non-monochrome scheme", () => {
    const schemes = ACCESSIBILITY_SCHEME_VALUES.filter((s) => s !== "monochrome");
    for (const scheme of schemes) {
      const style = resolveRouteStyle(undefined, "FERRY", {}, scheme);
      expect(style.background, `${scheme} background`).toBeTruthy();
      expect(style.color, `${scheme} color`).toBeTruthy();
    }
  });
});

const mockColorConfig: ColorConfig = {
  modes: [
    { id: "BUS", label: "Bus (blue)", parentMode: "BUS", color: "#0073AC", routeCount: 35, sampleRoutes: ["1", "2", "3"] },
    { id: "BUS:night", label: "Bus (black)", parentMode: "BUS", color: "#111111", routeCount: 5, sampleRoutes: ["N1", "N2"] },
  ],
  palettes: {
    light: {
      universal: { BUS: "#2B7AB5", "BUS:night": "#3A3A5C" },
      deuteranopia: { BUS: "#3366CC", "BUS:night": "#444466" },
      protanopia: { BUS: "#2255BB", "BUS:night": "#3D3D5A" },
      tritanopia: { BUS: "#0073AC", "BUS:night": "#2A1A1A" },
      highContrast: { BUS: "#0055FF", "BUS:night": "#FF5500" },
    },
    dark: {
      universal: { BUS: "#5BA8D9", "BUS:night": "#7A7AAC" },
      deuteranopia: { BUS: "#66AAFF", "BUS:night": "#8888AA" },
      protanopia: { BUS: "#5599DD", "BUS:night": "#7D7DAA" },
      tritanopia: { BUS: "#33AADD", "BUS:night": "#6A3A3A" },
      highContrast: { BUS: "#55AAFF", "BUS:night": "#FF8844" },
    },
  },
  universalLimited: false,
};

describe("resolveRouteColor with colorConfig (new pipeline)", () => {
  it("user override wins over everything", () => {
    const result = resolveRouteColor(
      "#0073AC", "BUS", { BUS: "#ff0000" },
      "deuteranopia", "light",
      "BUS", false, mockColorConfig,
    );
    expect(result).toBe("#ff0000");
  });

  it("uses palette color when scheme is active", () => {
    const result = resolveRouteColor(
      "#111111", "BUS", {},
      "deuteranopia", "light",
      "BUS:night", false, mockColorConfig,
    );
    expect(result).toBe("#444466");
  });

  it("uses dark palette for dark theme", () => {
    const result = resolveRouteColor(
      "#0073AC", "BUS", {},
      "deuteranopia", "dark",
      "BUS", false, mockColorConfig,
    );
    expect(result).toBe("#66AAFF");
  });

  it("uses highContrast palette when toggle enabled", () => {
    const result = resolveRouteColor(
      "#0073AC", "BUS", {},
      "deuteranopia", "light",
      "BUS", true, mockColorConfig,
    );
    expect(result).toBe("#0055FF");
  });

  it("falls back to cluster color when no scheme and no feed color", () => {
    const result = resolveRouteColor(
      undefined, "BUS", {},
      "none", "light",
      "BUS:night", false, mockColorConfig,
    );
    expect(result).toBe("#111111");
  });

  it("falls back to default when no colorConfig", () => {
    const result = resolveRouteColor(
      undefined, "BUS", {},
      "none", "light",
      undefined, false, null,
    );
    expect(result).toBe("#1d4ed8");
  });

  it("existing call sites without new params still work", () => {
    const result = resolveRouteColor(
      "#0073AC", "BUS", {}, "none", "light",
    );
    expect(result).toBe("#0073AC");
  });

  it("legacy BUS override resolves via resolveRouteColor when subMode is BUS", () => {
    const result = resolveRouteColor(
      "#0073AC", "BUS", { BUS: "#ff0000" },
      "none", "light",
      "BUS", false, mockColorConfig,
    );
    expect(result).toBe("#ff0000");
  });

  // Bug #1: when the GTFS feed supplies a per-route color and no accessibility
  // scheme is active, the feed color wins over the cluster centroid. Prior to
  // the 2026-04-20 fix, the new colorConfig pipeline ignored gtfsColor entirely,
  // causing Vilnius feed-coloured routes to all share the cluster centroid.
  describe("per-route GTFS color (scheme=none)", () => {
    it("honors feed route_color when it differs from cluster centroid", () => {
      const result = resolveRouteColor(
        "#ff8800", "BUS", {},
        "none", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result).toBe("#ff8800");
    });

    it("honors feed route_color with leading hash", () => {
      const result = resolveRouteColor(
        "#AABBCC", "BUS", {},
        "none", "light",
        "BUS", false, mockColorConfig,
      );
      // normalizeHex preserves case; consumer applies contrast math on any casing
      expect(result.toLowerCase()).toBe("#aabbcc");
    });

    it("honors feed route_color without leading hash", () => {
      const result = resolveRouteColor(
        "aabbcc", "BUS", {},
        "none", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result.toLowerCase()).toBe("#aabbcc");
    });

    it("falls back to cluster color when feed color is empty string", () => {
      const result = resolveRouteColor(
        "", "BUS", {},
        "none", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result).toBe("#0073AC");
    });

    it("falls back to cluster color when feed color is undefined", () => {
      const result = resolveRouteColor(
        undefined, "BUS", {},
        "none", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result).toBe("#0073AC");
    });

    it("falls back to cluster color when feed color is invalid hex", () => {
      const result = resolveRouteColor(
        "not-a-color", "BUS", {},
        "none", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result).toBe("#0073AC");
    });

    it("user override still wins over feed color", () => {
      const result = resolveRouteColor(
        "#ff8800", "BUS", { BUS: "#112233" },
        "none", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result).toBe("#112233");
    });

    it("active accessibility scheme still wins over feed color", () => {
      const result = resolveRouteColor(
        "#ff8800", "BUS", {},
        "deuteranopia", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result).toBe("#3366CC");
    });
  });

  // When the backend flags the city's universal palette as "limited"
  // (minimal-shift collapsed under all three CVD simulations), the resolver
  // auto-routes Universal through the high-contrast palette — users who
  // picked Universal get distinct colors instead of the near-identical
  // teal collapse (observed on Vilnius: BUS green #008000 → #0089b7,
  // TROLLEYBUS red #dc3131 → #00a8bf, both visually same as BUS blue).
  describe("universal scheme with universalLimited fallback to high-contrast", () => {
    const limitedConfig: ColorConfig = { ...mockColorConfig, universalLimited: true };

    it("universal uses highContrast palette when universalLimited is true", () => {
      const result = resolveRouteColor(
        undefined, "BUS", {},
        "universal", "light",
        "BUS", false, limitedConfig,
      );
      expect(result).toBe("#0055FF");
    });

    it("universal uses universal palette when universalLimited is false", () => {
      const result = resolveRouteColor(
        undefined, "BUS", {},
        "universal", "light",
        "BUS", false, mockColorConfig,
      );
      expect(result).toBe("#2B7AB5");
    });

    it("deuteranopia is unaffected by universalLimited flag", () => {
      const result = resolveRouteColor(
        undefined, "BUS", {},
        "deuteranopia", "light",
        "BUS", false, limitedConfig,
      );
      expect(result).toBe("#3366CC");
    });

    it("explicit highContrast toggle still wins (idempotent when already routed)", () => {
      const result = resolveRouteColor(
        undefined, "BUS", {},
        "universal", "light",
        "BUS", true, limitedConfig,
      );
      expect(result).toBe("#0055FF");
    });
  });
});
