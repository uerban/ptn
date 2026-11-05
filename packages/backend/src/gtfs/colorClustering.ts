import { parse, formatHex, converter, differenceCiede2000 } from "culori";
import type { Lab, Oklch } from "culori";
import type { TransportMode } from "@pt/shared";
import type { SubModeEntry } from "@pt/shared";

const toLab = converter("lab");
const toOklch = converter("oklch");
const toRgb = converter("rgb");

/** Wrapper to parse hex -> Lab, using culori's converter directly. */
function hexToLab(hex: string): Lab {
  const h = hex.startsWith("#") ? hex : `#${hex}`;
  const lab = toLab(h);
  if (!lab) {
    console.warn(`[colorClustering] failed to parse "${hex}" to Lab, treating as black`);
    return { mode: "lab", l: 0, a: 0, b: 0 };
  }
  return lab;
}

const ciede2000Diff = differenceCiede2000();

export function ciede2000(hex1: string, hex2: string): number {
  const h1 = hex1.startsWith("#") ? hex1 : `#${hex1}`;
  const h2 = hex2.startsWith("#") ? hex2 : `#${hex2}`;
  const c1 = parse(h1);
  const c2 = parse(h2);
  if (!c1 || !c2) return Infinity;
  return ciede2000Diff(c1, c2);
}

interface RouteColorInput {
  id: string;
  shortName: string;
  color: string;
  mode: TransportMode;
}

// Thresholds calibrated for transit GTFS feeds:
// - MERGE_THRESHOLD (deltaE<10): visually indistinguishable colors merge into one cluster
// - OUTLIER_THRESHOLD (deltaE>25): a single route is far enough to be its own sub-mode
const MERGE_THRESHOLD = 10;
const OUTLIER_THRESHOLD = 25;

/**
 * Minimum number of colorless routes before we generate a varied palette
 * instead of assigning them all the same default color.
 */
const NO_COLOR_PALETTE_THRESHOLD = 4;

/**
 * OKLCH hue ranges per mode for generating varied route colors.
 * Each mode gets a ~80-degree hue arc so generated colors stay
 * within the mode's visual family.
 */
const MODE_HUE_RANGES: Record<string, { hueStart: number; hueEnd: number; lightness: number; chroma: number }> = {
  BUS:       { hueStart: 250, hueEnd: 310, lightness: 0.55, chroma: 0.16 }, // blue-purple
  TRAM:      { hueStart: 110, hueEnd: 150, lightness: 0.55, chroma: 0.14 }, // green
  TROLLEYBUS:{ hueStart: 170, hueEnd: 200, lightness: 0.50, chroma: 0.13 }, // teal
  METRO:     { hueStart: 10,  hueEnd: 60,  lightness: 0.55, chroma: 0.18 }, // red -> orange
  RAIL:      { hueStart: 60,  hueEnd: 105, lightness: 0.55, chroma: 0.15 }, // yellow-green
  FERRY:     { hueStart: 205, hueEnd: 240, lightness: 0.55, chroma: 0.13 }, // cyan-blue
  CABLE_TRAM: { hueStart: 290, hueEnd: 320, lightness: 0.55, chroma: 0.15 },
  AERIAL:     { hueStart: 320, hueEnd: 350, lightness: 0.55, chroma: 0.15 },
  OTHER:      { hueStart: 250, hueEnd: 290, lightness: 0.45, chroma: 0.04 },
  FUNICULAR: { hueStart: 290, hueEnd: 350, lightness: 0.55, chroma: 0.15 }, // purple -> magenta
};

/**
 * Simple deterministic hash of a string to a number in [0, 1).
 * Uses FNV-1a-inspired multiply-xor approach.
 */
export function hashStringToUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to [0, 1) using unsigned right shift
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Generate a deterministic hex color for a colorless route within the mode's hue range.
 * Uses the route's shortName as a seed so colors are stable across data refreshes.
 */
export function generateRouteColor(shortName: string, mode: TransportMode): string {
  const range = MODE_HUE_RANGES[mode];
  if (!range) {
    const h = hashStringToUnit(shortName) * 360;
    const oklch: Oklch = { mode: "oklch", l: 0.55, c: 0.14, h };
    const hex = formatHex(toRgb(oklch));
    if (!hex) console.warn(`[colorClustering] out-of-gamut OKLCH for "${shortName}" (${mode}), using gray`);
    return hex ?? "#6b7280";
  }

  const t = hashStringToUnit(shortName);
  const hue = range.hueStart + t * (range.hueEnd - range.hueStart);
  const lightnessOffset = (hashStringToUnit(shortName + "_l") - 0.5) * 0.16;
  const oklch: Oklch = {
    mode: "oklch",
    l: Math.max(0.35, Math.min(0.75, range.lightness + lightnessOffset)),
    c: range.chroma,
    h: hue,
  };
  const hex = formatHex(toRgb(oklch));
  if (!hex) console.warn(`[colorClustering] out-of-gamut OKLCH for "${shortName}" (${mode}), using gray`);
  return hex ?? "#6b7280";
}

const MODE_LABELS: Record<string, string> = {
  BUS: "Bus", TRAM: "Tram", TROLLEYBUS: "Trolleybus",
  METRO: "Metro", RAIL: "Rail",
  FERRY: "Ferry", CABLE_TRAM: "Cable tram", AERIAL: "Aerial", OTHER: "Other",
  FUNICULAR: "Funicular",
  WALK: "Walk", BIKE: "Bike", BIKE_SHARE: "Bike share",
  SCOOTER: "Scooter", CAR: "Car",
};

export interface ColorClusterLabel {
  /** Human-readable label in English: "Bus (blue)", kept for backward compat. */
  label: string;
  /** Structured color token ("blue", "red", ...), undefined when OKLCH parsing fails. */
  colorName?: string;
}

/**
 * Name a color using simple hue-based labels.
 * Returns both the formatted label and the structured color token for i18n.
 */
export function nameColorCluster(hex: string, mode: TransportMode): ColorClusterLabel {
  const modeLabel = MODE_LABELS[mode] ?? mode;
  const oklch = toOklch(hex.startsWith("#") ? hex : `#${hex}`);
  if (!oklch || oklch.c === undefined || oklch.l === undefined) {
    return { label: modeLabel };
  }

  const l = oklch.l;
  const c = oklch.c;
  const h = oklch.h ?? 0;

  let colorName: string;
  if (l < 0.2) colorName = "black";
  else if (l > 0.93) colorName = "white";
  else if (c < 0.03) colorName = "gray";
  else if (h >= 0 && h < 40) colorName = "red";
  else if (h >= 40 && h < 80) colorName = "orange";
  else if (h >= 80 && h < 110) colorName = "yellow";
  else if (h >= 110 && h < 170) colorName = "green";
  else if (h >= 170 && h < 220) colorName = "cyan";
  else if (h >= 220 && h < 280) colorName = "blue";
  else if (h >= 280 && h < 330) colorName = "purple";
  else colorName = "red";

  return { label: `${modeLabel} (${colorName})`, colorName };
}

interface ColorCluster {
  centroidHex: string;
  centroidLab: Lab;
  routeIds: string[];
  routeShortNames: string[];
}

/**
 * Cluster route colors within a single mode.
 */
function clusterColorsForMode(
  routes: RouteColorInput[],
  mode: TransportMode,
  defaultColor: string,
): { subModes: SubModeEntry[]; routeMap: Map<string, string> } {
  const routeMap = new Map<string, string>();

  const colored = routes.filter((r) => r.color && r.color.length >= 3);
  const noColor = routes.filter((r) => !r.color || r.color.length < 3);

  const clusters: ColorCluster[] = [];

  for (const route of colored) {
    const hex = route.color.startsWith("#") ? route.color : `#${route.color}`;
    const routeLab = hexToLab(hex);
    let merged = false;
    for (const cluster of clusters) {
      if (ciede2000Diff(routeLab, cluster.centroidLab) < MERGE_THRESHOLD) {
        cluster.routeIds.push(route.id);
        cluster.routeShortNames.push(route.shortName);
        const n = cluster.routeIds.length;
        const prev = cluster.centroidLab;
        cluster.centroidLab = {
          mode: "lab",
          l: prev.l + ((routeLab.l ?? 0) - prev.l) / n,
          a: (prev.a ?? 0) + (((routeLab.a ?? 0) - (prev.a ?? 0)) / n),
          b: (prev.b ?? 0) + (((routeLab.b ?? 0) - (prev.b ?? 0)) / n),
        };
        cluster.centroidHex = formatHex(cluster.centroidLab) ?? cluster.centroidHex;
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({
        centroidHex: hex,
        centroidLab: routeLab,
        routeIds: [route.id],
        routeShortNames: [route.shortName],
      });
    }
  }

  // Find dominant cluster (most routes)
  const dominant = clusters.length > 0
    ? clusters.reduce((a, b) => (a.routeIds.length >= b.routeIds.length ? a : b))
    : null;

  // Keep clusters with >=2 routes, or single-route with deltaE>25 from dominant
  const validClusters = clusters.filter((c) => {
    if (c.routeIds.length >= 2) return true;
    if (!dominant || c === dominant) return true;
    return ciede2000Diff(c.centroidLab, dominant.centroidLab) > OUTLIER_THRESHOLD;
  });

  // Merge rejected singletons into nearest valid cluster
  const rejected = clusters.filter((c) => !validClusters.includes(c));
  for (const rej of rejected) {
    let nearest = validClusters[0];
    let minDist = Infinity;
    for (const vc of validClusters) {
      const d = ciede2000Diff(rej.centroidLab, vc.centroidLab);
      if (d < minDist) { minDist = d; nearest = vc; }
    }
    if (nearest) {
      nearest.routeIds.push(...rej.routeIds);
      nearest.routeShortNames.push(...rej.routeShortNames);
    }
  }

  const results: SubModeEntry[] = [];

  // Handle routes with no color
  const defaultId = mode;
  if (noColor.length >= NO_COLOR_PALETTE_THRESHOLD && validClusters.length === 0) {
    // Many colorless routes and no real color data: generate varied colors
    // and cluster them the same way we cluster real colors.
    const syntheticClusters: ColorCluster[] = [];
    for (const route of noColor) {
      const hex = generateRouteColor(route.shortName, mode);
      let merged = false;
      for (const cluster of syntheticClusters) {
        if (ciede2000(hex, cluster.centroidHex) < MERGE_THRESHOLD) {
          cluster.routeIds.push(route.id);
          cluster.routeShortNames.push(route.shortName);
          merged = true;
          break;
        }
      }
      if (!merged) {
        syntheticClusters.push({
          centroidHex: hex,
          centroidLab: hexToLab(hex),
          routeIds: [route.id],
          routeShortNames: [route.shortName],
        });
      }
    }

    for (const cluster of syntheticClusters) {
      const id = `${mode}:${cluster.centroidHex.slice(1).toLowerCase()}`;
      const { label, colorName } = nameColorCluster(cluster.centroidHex, mode);
      results.push({
        id,
        label,
        labelMode: mode,
        labelColor: colorName,
        parentMode: mode,
        color: cluster.centroidHex,
        routeCount: cluster.routeIds.length,
        sampleRoutes: cluster.routeShortNames.slice(0, 3),
      });
      for (const routeId of cluster.routeIds) {
        routeMap.set(routeId, id);
      }
    }
  } else if (noColor.length > 0 || validClusters.length === 0) {
    // Few colorless routes or there are also colored clusters:
    // assign them all the same default color (original behavior).
    results.push({
      id: defaultId,
      label: MODE_LABELS[mode] ?? mode,
      labelMode: mode,
      parentMode: mode,
      color: defaultColor,
      routeCount: noColor.length || (validClusters.length === 0 ? routes.length : 0),
      sampleRoutes: noColor.slice(0, 3).map((r) => r.shortName),
    });
    for (const r of noColor) {
      routeMap.set(r.id, defaultId);
    }
    if (validClusters.length === 0) {
      for (const r of colored) {
        routeMap.set(r.id, defaultId);
      }
    }
  }

  // Add color clusters and build route->subMode mapping from cluster membership
  for (const cluster of validClusters) {
    const isSoleCluster = validClusters.length === 1 && noColor.length === 0;
    const id = isSoleCluster ? mode : `${mode}:${cluster.centroidHex.slice(1).toLowerCase()}`;
    let label: string;
    let colorName: string | undefined;
    if (isSoleCluster) {
      label = MODE_LABELS[mode] ?? mode;
    } else {
      const named = nameColorCluster(cluster.centroidHex, mode);
      label = named.label;
      colorName = named.colorName;
    }

    results.push({
      id,
      label,
      labelMode: mode,
      labelColor: colorName,
      parentMode: mode,
      color: cluster.centroidHex,
      routeCount: cluster.routeIds.length,
      sampleRoutes: cluster.routeShortNames.slice(0, 3),
    });

    for (const routeId of cluster.routeIds) {
      routeMap.set(routeId, id);
    }
  }

  results.sort((a, b) => b.routeCount - a.routeCount);

  return { subModes: results, routeMap };
}

const DEFAULT_MODE_COLORS: Record<string, string> = {
  BUS: "#1d4ed8", TRAM: "#16a34a", TROLLEYBUS: "#0d9488",
  METRO: "#dc2626", RAIL: "#ea580c",
  FERRY: "#0891b2", CABLE_TRAM: "#9333ea", AERIAL: "#c026d3", OTHER: "#64748b",
  FUNICULAR: "#7c3aed",
};

export interface ClusterResult {
  subModes: SubModeEntry[];
  routeSubModeMap: Map<string, string>;
}

/**
 * Cluster all route colors across all modes.
 * Returns SubModeEntry[] and a routeId->subModeId mapping built directly
 * from cluster membership.
 */
export function clusterRouteColors(
  routes: RouteColorInput[],
): ClusterResult {
  const byMode = new Map<TransportMode, RouteColorInput[]>();
  for (const r of routes) {
    const list = byMode.get(r.mode) ?? [];
    list.push(r);
    byMode.set(r.mode, list);
  }

  const allSubModes: SubModeEntry[] = [];
  const routeSubModeMap = new Map<string, string>();

  for (const [mode, modeRoutes] of byMode) {
    const defaultColor = DEFAULT_MODE_COLORS[mode] ?? "#6b7280";
    const { subModes, routeMap } = clusterColorsForMode(modeRoutes, mode, defaultColor);
    allSubModes.push(...subModes);
    for (const [routeId, subModeId] of routeMap) {
      routeSubModeMap.set(routeId, subModeId);
    }
  }

  return { subModes: allSubModes, routeSubModeMap };
}
