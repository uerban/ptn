import type { TransportMode } from "./transit.js";

export interface SubModeEntry {
  /** Unique ID: "BUS", "BUS:night", "BUS:express" */
  id: string;
  /** Human-readable label: "Bus (blue)", "Bus (black)" */
  label: string;
  /** Structured mode token (e.g. "BUS", "TRAM", "TROLLEYBUS") for i18n label construction */
  labelMode?: string;
  /** Structured color token (e.g. "white", "red", "blue"); undefined for mode-only labels */
  labelColor?: string;
  /** Parent TransportMode */
  parentMode: TransportMode;
  /** Cluster centroid hex color with # prefix */
  color: string;
  /** Number of routes in this cluster */
  routeCount: number;
  /** Sample route short names for preview badges (up to 3) */
  sampleRoutes: string[];
}

/** Maps sub-mode ID to adjusted hex color */
export type PaletteMap = Record<string, string>;

export interface ThemePalettes {
  universal: PaletteMap;
  deuteranopia: PaletteMap;
  protanopia: PaletteMap;
  tritanopia: PaletteMap;
  highContrast: PaletteMap;
}

export interface ColorConfig {
  modes: SubModeEntry[];
  palettes: {
    light: ThemePalettes;
    dark: ThemePalettes;
  };
  /** True if universal palette couldn't achieve deltaE>15 for all pairs */
  universalLimited: boolean;
}
