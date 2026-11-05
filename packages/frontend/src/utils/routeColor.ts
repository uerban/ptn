import type { TransportMode, ColorConfig, PaletteMap } from "@pt/shared";

export interface RouteStyle {
  background: string;
  color: string;
  textStroke?: string;
  paintOrder?: string;
}

export type AccessibilityScheme =
  | "none"
  | "universal"
  | "deuteranopia"
  | "protanopia"
  | "tritanopia"
  | "monochrome";

export const ACCESSIBILITY_SCHEME_VALUES: AccessibilityScheme[] = [
  "none",
  "universal",
  "deuteranopia",
  "protanopia",
  "tritanopia",
  "monochrome",
];

export const DEFAULT_MODE_COLORS: Record<TransportMode, string> = {
  BUS: "#1d4ed8",
  TRAM: "#16a34a",
  TROLLEYBUS: "#0d9488",
  METRO: "#dc2626",
  RAIL: "#ea580c",
  FERRY: "#0891b2",
  CABLE_TRAM: "#9333ea",
  AERIAL: "#c026d3",
  OTHER: "#64748b",
  FUNICULAR: "#7c3aed",
  WALK: "#6b7280",
  BIKE: "#65a30d",
  BIKE_SHARE: "#65a30d",
  SCOOTER: "#d97706",
  CAR: "#4b5563",
};

/**
 * B&W CSS-pattern styles for monochrome accessibility scheme.
 * Each transport mode maps to a distinct visual pattern in both light and dark themes.
 */
export const MONOCHROME_PATTERNS: Record<
  TransportMode,
  { light: RouteStyle; dark: RouteStyle }
> = {
  BUS: {
    light: {
      background:
        "repeating-linear-gradient(45deg, #222 0 2px, #fff 2px 6px)",
      color: "#000",
      textStroke: "1px #fff",
      paintOrder: "stroke fill",
    },
    dark: {
      background:
        "repeating-linear-gradient(45deg, #ddd 0 2px, #222 2px 6px)",
      color: "#fff",
      textStroke: "1px #222",
      paintOrder: "stroke fill",
    },
  },
  TRAM: {
    light: {
      background:
        "radial-gradient(circle 1.5px, #222 100%, #fff 0) 0 0 / 6px 6px",
      color: "#000",
      textStroke: "1px #fff",
      paintOrder: "stroke fill",
    },
    dark: {
      background:
        "radial-gradient(circle 1.5px, #ddd 100%, #222 0) 0 0 / 6px 6px",
      color: "#fff",
      textStroke: "1px #222",
      paintOrder: "stroke fill",
    },
  },
  TROLLEYBUS: {
    light: {
      background:
        "repeating-linear-gradient(135deg, #222 0 2px, #fff 2px 6px)",
      color: "#000",
      textStroke: "1px #fff",
      paintOrder: "stroke fill",
    },
    dark: {
      background:
        "repeating-linear-gradient(135deg, #ddd 0 2px, #222 2px 6px)",
      color: "#fff",
      textStroke: "1px #222",
      paintOrder: "stroke fill",
    },
  },
  METRO: {
    light: {
      background:
        "repeating-linear-gradient(180deg, #222 0 2px, #fff 2px 6px)",
      color: "#000",
      textStroke: "1px #fff",
      paintOrder: "stroke fill",
    },
    dark: {
      background:
        "repeating-linear-gradient(180deg, #ddd 0 2px, #222 2px 6px)",
      color: "#fff",
      textStroke: "1px #222",
      paintOrder: "stroke fill",
    },
  },
  RAIL: {
    light: { background: "#333333", color: "#ffffff" },
    dark: { background: "#c0c0c0", color: "#000000" },
  },
  FERRY: {
    light: {
      background:
        "repeating-linear-gradient(45deg, #222 0 1px, transparent 1px 5px), repeating-linear-gradient(-45deg, #222 0 1px, transparent 1px 5px), #fff",
      color: "#000",
      textStroke: "1px #fff",
      paintOrder: "stroke fill",
    },
    dark: {
      background:
        "repeating-linear-gradient(45deg, #ddd 0 1px, transparent 1px 5px), repeating-linear-gradient(-45deg, #ddd 0 1px, transparent 1px 5px), #222",
      color: "#fff",
      textStroke: "1px #222",
      paintOrder: "stroke fill",
    },
  },
  // CABLE_TRAM uses a 90deg monochrome pattern (cable family).
  CABLE_TRAM: {
    light: {
      background:
        "repeating-linear-gradient(90deg, #222 0 2px, #fff 2px 6px)",
      color: "#000",
      textStroke: "1px #fff",
      paintOrder: "stroke fill",
    },
    dark: {
      background:
        "repeating-linear-gradient(90deg, #ddd 0 2px, #222 2px 6px)",
      color: "#fff",
      textStroke: "1px #222",
      paintOrder: "stroke fill",
    },
  },
  AERIAL: {
    light: { background: "#666666", color: "#ffffff" },
    dark: { background: "#b0b0b0", color: "#000000" },
  },
  OTHER: {
    light: { background: "#777777", color: "#ffffff" },
    dark: { background: "#aaaaaa", color: "#000000" },
  },
  FUNICULAR: {
    light: { background: "#555555", color: "#ffffff" },
    dark: { background: "#a8a8a8", color: "#000000" },
  },
  WALK: {
    light: { background: "#999999", color: "#000000" },
    dark: { background: "#888888", color: "#000000" },
  },
  BIKE: {
    light: { background: "#999999", color: "#000000" },
    dark: { background: "#888888", color: "#000000" },
  },
  BIKE_SHARE: {
    light: { background: "#999999", color: "#000000" },
    dark: { background: "#888888", color: "#000000" },
  },
  SCOOTER: {
    light: { background: "#555555", color: "#ffffff" },
    dark: { background: "#999999", color: "#000000" },
  },
  CAR: {
    light: { background: "#555555", color: "#ffffff" },
    dark: { background: "#999999", color: "#000000" },
  },
};

const VALID_HEX6_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeHex(color: string): string | null {
  const trimmed = color.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  const normalized = `#${expandToRgbHex(withHash)}`;
  return VALID_HEX6_RE.test(normalized) ? normalized : null;
}

/**
 * Expand shorthand hex (#rgb/#rgba) to 6-digit form and strip alpha (#rrggbbaa).
 * Returns the bare hex digits (no # prefix) as a 6-character string.
 */
function expandToRgbHex(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) {
    return h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length === 8) {
    return h.substring(0, 6);
  }
  return h;
}

/**
 * Return black or white text depending on background luminance.
 * Uses WCAG relative-luminance formula to pick the higher-contrast option.
 * Handles #rgb, #rgba, #rrggbb, and #rrggbbaa inputs.
 */
export function contrastTextColor(hexBg: string): string {
  const hex = expandToRgbHex(hexBg);
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const toLinear = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const luminance =
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

/**
 * Resolve the display color for a route badge.
 *
 * When colorConfig is available (GTFS-driven pipeline):
 * 1. User per-mode override (keyed by sub-mode or mode)
 * 2. Colorblind palette color from color-config
 * 3. GTFS cluster color from color-config modes
 *
 * Legacy fallback (no colorConfig):
 * 1. User per-mode override
 * 2. GTFS route_color
 * 3. Monochrome pattern (if scheme is monochrome)
 * 4. Default mode color
 */
export function resolveRouteColor(
  gtfsColor: string | undefined,
  mode: TransportMode,
  modeOverrides: Partial<Record<string, string>>,
  scheme: AccessibilityScheme,
  theme?: "light" | "dark",
  subMode?: string,
  highContrastEnabled?: boolean,
  colorConfig?: ColorConfig | null,
): string {
  // New GTFS-driven pipeline (when colorConfig is provided)
  if (colorConfig !== undefined && colorConfig !== null) {
    // 1. User override (keyed by sub-mode or mode)
    const overrideKey = subMode ?? mode;
    const override = modeOverrides[overrideKey];
    if (override) {
      const normalized = normalizeHex(override);
      if (normalized) return normalized;
    }

    // 2. Colorblind palette color (if scheme active).
    // When the user selected Universal and the backend flagged the city's
    // universal palette as "limited" (pairwise CVD-distance below threshold
    // across all three simulations), the minimal-shift output collapses to
    // near-identical shades in normal vision — worse than the cluster
    // defaults. Route Universal through the high-contrast palette in that
    // case: user gets actually-distinct colors and the warning banner in
    // the settings UI explains why.
    if (scheme !== "none" && scheme !== "monochrome") {
      const universalDegraded = scheme === "universal" && colorConfig.universalLimited === true;
      const paletteKey = highContrastEnabled || universalDegraded ? "highContrast" : scheme;
      const themePalettes = colorConfig.palettes[theme ?? "light"];
      const palette: PaletteMap | undefined = themePalettes?.[paletteKey as keyof typeof themePalettes];
      const paletteColor = palette?.[overrideKey];
      if (paletteColor) return paletteColor;
    }

    // 3. Per-route GTFS feed color — when no accessibility scheme is active
    // and the feed supplies a distinct color for this specific route, honor
    // it. Clustering is for grouping aesthetics, not ground truth; a feed
    // publisher that sets route_color means it for that route.
    if (scheme === "none" && gtfsColor && gtfsColor.trim() !== "") {
      const normalized = normalizeHex(gtfsColor);
      if (normalized) return normalized;
    }

    // 4. GTFS cluster color (from color-config modes)
    const lookupId = subMode ?? mode;
    if (lookupId) {
      const entry = colorConfig.modes.find((m) => m.id === lookupId);
      if (entry) return entry.color;
    }

    return DEFAULT_MODE_COLORS[mode] ?? "#6b7280";
  }

  // Legacy path / degraded-mode fallback (colorConfig absent or null)
  const userOverride = modeOverrides[mode];
  if (userOverride) {
    const normalized = normalizeHex(userOverride);
    if (normalized) return normalized;
  }

  if (gtfsColor && gtfsColor.trim() !== "") {
    const normalized = normalizeHex(gtfsColor);
    if (normalized) return normalized;
  }

  if (scheme === "monochrome") {
    const bg = MONOCHROME_PATTERNS[mode][theme === "dark" ? "dark" : "light"].background;
    return VALID_HEX6_RE.test(bg) ? bg : DEFAULT_MODE_COLORS[mode];
  }

  return DEFAULT_MODE_COLORS[mode] ?? "#6b7280";
}

/**
 * Resolve the full display style for a route badge.
 *
 * For monochrome scheme: returns the CSS-pattern RouteStyle for the mode.
 * For all other schemes: resolves a hex color via resolveRouteColor and
 * returns { background, color } with appropriate contrast text.
 */
export function resolveRouteStyle(
  gtfsColor: string | undefined,
  mode: TransportMode,
  modeOverrides: Partial<Record<string, string>>,
  scheme: AccessibilityScheme,
  theme?: "light" | "dark",
  subMode?: string,
  highContrastEnabled?: boolean,
  colorConfig?: ColorConfig | null,
): RouteStyle {
  if (scheme === "monochrome") {
    const parentPattern = MONOCHROME_PATTERNS[mode]?.[theme === "dark" ? "dark" : "light"];
    if (parentPattern) return parentPattern;
    return { background: theme === "dark" ? "#555" : "#999", color: theme === "dark" ? "#fff" : "#000" };
  }

  const bg = resolveRouteColor(gtfsColor, mode, modeOverrides, scheme, theme, subMode, highContrastEnabled, colorConfig);
  return {
    background: bg,
    color: contrastTextColor(bg),
  };
}
