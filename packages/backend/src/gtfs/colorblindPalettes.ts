import {
  parse, formatHex, converter, differenceCiede2000,
  filterDeficiencyDeuter, filterDeficiencyProt, filterDeficiencyTrit,
} from "culori";
import type { Color } from "culori";
import type { ThemePalettes, PaletteMap } from "@pt/shared";

const toOklch = converter("oklch");
const ciede2000Diff = differenceCiede2000();

export type CvdType = "deuteranopia" | "protanopia" | "tritanopia";

// -----------------------------------------------------------------------
// CVD Simulation — uses culori's built-in Machado et al. (2009) model.
// This is more accurate than the older Viénot (1999) matrices and supports
// variable severity (0–1). We use severity=1 for full simulation.
// Reference: https://www.inf.ufrgs.br/~oliveira/pubs_files/CVD_Simulation/
// -----------------------------------------------------------------------

const CVD_FILTERS: Record<CvdType, <C extends Color>(color: C) => C> = {
  deuteranopia: filterDeficiencyDeuter(1),
  protanopia: filterDeficiencyProt(1),
  tritanopia: filterDeficiencyTrit(1),
};

/**
 * Simulate how a hex color appears under a CVD type.
 * Uses culori's Machado et al. (2009) physiologically-based model.
 */
export function simulateCvd(hex: string, type: CvdType): string {
  const h = hex.startsWith("#") ? hex : `#${hex}`;
  const parsed = parse(h);
  if (!parsed) return h;
  const simulated = CVD_FILTERS[type](parsed);
  return formatHex(simulated) ?? h;
}

// -----------------------------------------------------------------------
// Palette Optimization
// -----------------------------------------------------------------------

const MIN_DISTANCE = 15; // Minimum ΔE between any pair in simulated space

function minPairwiseDistance(colors: string[]): number {
  let min = Infinity;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const c1 = parse(colors[i]);
      const c2 = parse(colors[j]);
      if (c1 && c2) {
        const d = ciede2000Diff(c1, c2);
        if (d < min) min = d;
      }
    }
  }
  return min;
}

/**
 * Minimal-shift: nudge colors in OKLCH to improve simulated distinction.
 */
function minimalShiftPalette(
  baseColors: Record<string, string>,
  cvdTypes: CvdType[],
): PaletteMap {
  const ids = Object.keys(baseColors);
  const adjusted = { ...baseColors };

  // Pre-compute simulated parsed colors per CVD type. On each iteration only
  // the nudged color is re-simulated, avoiding O(n × cvdTypes) parse() calls.
  const simCache = new Map<CvdType, (Color | undefined)[]>();
  for (const cvd of cvdTypes) {
    simCache.set(cvd, ids.map((id) => {
      const hex = simulateCvd(adjusted[id], cvd);
      return parse(hex.startsWith("#") ? hex : `#${hex}`);
    }));
  }

  for (let iter = 0; iter < 15; iter++) {
    let worstPairDist = Infinity;
    let worstI = 0;
    let worstJ = 1;

    for (const cvd of cvdTypes) {
      const parsed = simCache.get(cvd)!;
      for (let i = 0; i < ids.length; i++) {
        const c1 = parsed[i];
        if (!c1) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const c2 = parsed[j];
          if (!c2) continue;
          const d = ciede2000Diff(c1, c2);
          if (d < worstPairDist) {
            worstPairDist = d;
            worstI = i;
            worstJ = j;
          }
        }
      }
    }

    if (worstPairDist >= MIN_DISTANCE) break;

    const nudgeIdx = worstJ;
    const oklch = toOklch(adjusted[ids[nudgeIdx]]);
    if (!oklch) break;

    oklch.h = ((oklch.h ?? 0) + 25) % 360;
    oklch.c = Math.min((oklch.c ?? 0.1) + 0.02, 0.3);
    const newHex = formatHex(oklch);
    if (!newHex) break;
    adjusted[ids[nudgeIdx]] = newHex;

    // Only re-simulate the nudged color in the cache
    for (const cvd of cvdTypes) {
      const hex = simulateCvd(newHex, cvd);
      simCache.get(cvd)![nudgeIdx] = parse(hex.startsWith("#") ? hex : `#${hex}`);
    }
  }

  return adjusted;
}

/**
 * Aggressive remap: spread colors evenly in perceivable hue range.
 * Note: This ignores mode identity — two BUS sub-modes may end up with
 * colors that look like TRAM or METRO. This is intentional per the spec:
 * high-contrast mode prioritizes maximum distinction over original
 * resemblance. The sub-mode labels and swatches in the settings UI
 * provide the primary identity cue instead of color.
 */
function aggressiveRemapPalette(
  baseColors: Record<string, string>,
): PaletteMap {
  const ids = Object.keys(baseColors);
  const n = ids.length;
  const result: PaletteMap = {};

  for (let i = 0; i < n; i++) {
    const hue = (i * 360) / n;
    const oklch = toOklch(baseColors[ids[i]]);
    const l = oklch?.l ?? 0.6;
    const hex = formatHex({ mode: "oklch", l: Math.max(0.4, Math.min(0.8, l)), c: 0.2, h: hue });
    result[ids[i]] = hex ?? baseColors[ids[i]];
  }

  return result;
}

/**
 * Compute WCAG 2.1 relative luminance from a hex color.
 */
function relativeLuminance(hex: string): number {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Compute WCAG contrast ratio between two hex colors.
 * Returns ratio >= 1 (e.g., 4.5 for AA text, 3.0 for large text/UI).
 */
function wcagContrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const MIN_DARK_CONTRAST = 3.0; // WCAG AA for large text and UI components

/**
 * Adjust palette colors to meet WCAG 3:1 contrast against dark background.
 * Uses actual WCAG contrast ratio (not perceptual ΔE) to ensure accessibility
 * compliance. The 3:1 ratio is the WCAG AA requirement for UI components and
 * large text, which is appropriate for route badges.
 */
function adjustForDarkTheme(palette: PaletteMap): PaletteMap {
  const darkSurface = "#1f2937";
  const result: PaletteMap = {};

  for (const [id, hex] of Object.entries(palette)) {
    const oklch = toOklch(hex);
    if (!oklch) { result[id] = hex; continue; }

    // Increase lightness until WCAG contrast ratio >= 3.0 against dark surface
    let attempts = 0;
    while (attempts < 20) {
      const candidate = formatHex(oklch);
      if (!candidate) break;
      if (wcagContrastRatio(candidate, darkSurface) >= MIN_DARK_CONTRAST) {
        result[id] = candidate;
        break;
      }
      oklch.l = Math.min((oklch.l ?? 0.5) + 0.04, 0.95);
      attempts++;
    }
    if (!result[id]) result[id] = hex;
  }

  return result;
}

/**
 * Compute all palettes for a set of base mode colors.
 */
export function computePalettes(
  baseColors: Record<string, string>,
): { light: ThemePalettes; dark: ThemePalettes; universalLimited: boolean } {
  const cvdTypes: CvdType[] = ["deuteranopia", "protanopia", "tritanopia"];

  // Per-CVD palettes (minimal shift)
  const deuteranopia = minimalShiftPalette(baseColors, ["deuteranopia"]);
  const protanopia = minimalShiftPalette(baseColors, ["protanopia"]);
  const tritanopia = minimalShiftPalette(baseColors, ["tritanopia"]);

  // Universal (minimal shift, must pass all 3)
  const universal = minimalShiftPalette(baseColors, cvdTypes);

  // Check if universal achieved target distance
  let universalLimited = false;
  for (const cvd of cvdTypes) {
    const simulated = Object.values(universal).map((c) => simulateCvd(c, cvd));
    if (minPairwiseDistance(simulated) < MIN_DISTANCE) {
      universalLimited = true;
      break;
    }
  }

  // High contrast (aggressive remap)
  const highContrast = aggressiveRemapPalette(baseColors);

  const light: ThemePalettes = {
    universal, deuteranopia, protanopia, tritanopia, highContrast,
  };

  const dark: ThemePalettes = {
    universal: adjustForDarkTheme(universal),
    deuteranopia: adjustForDarkTheme(deuteranopia),
    protanopia: adjustForDarkTheme(protanopia),
    tritanopia: adjustForDarkTheme(tritanopia),
    highContrast: adjustForDarkTheme(highContrast),
  };

  return { light, dark, universalLimited };
}
