import type { TransportMode } from "@pt/shared";

interface RingInput {
  mode: TransportMode;
  color?: string;
}

export const MODE_DEFAULT_COLORS: Partial<Record<TransportMode, string>> = {
  BUS: "#4caf50",
  TRAM: "#ff9800",
  TROLLEYBUS: "#0d9488",
  METRO: "#f44336",
  RAIL: "#9c27b0",
  FERRY: "#00bcd4",
  CABLE_TRAM: "#9333ea",
  AERIAL: "#c026d3",
  OTHER: "#64748b",
  FUNICULAR: "#607d8b",
};

const FALLBACK_COLOR = "#9e9e9e";

/** Get distinct ring segment colors from line data. */
export function generateRingColors(lines: RingInput[]): string[] {
  const seen = new Set<string>();
  const colors: string[] = [];

  for (const line of lines) {
    const color = line.color
      ? `#${line.color.replace(/^#/, "")}`
      : MODE_DEFAULT_COLORS[line.mode] ?? FALLBACK_COLOR;
    if (!seen.has(color)) {
      seen.add(color);
      colors.push(color);
    }
  }

  return colors;
}

/**
 * Build a conic-gradient CSS string for a stacked ring.
 * Each color gets an equal segment.
 */
export function ringGradient(colors: string[]): string {
  if (colors.length <= 1) return colors[0] ?? FALLBACK_COLOR;
  const step = 360 / colors.length;
  const stops = colors.map(
    (c, i) => `${c} ${i * step}deg ${(i + 1) * step}deg`
  );
  return `conic-gradient(${stops.join(", ")})`;
}
