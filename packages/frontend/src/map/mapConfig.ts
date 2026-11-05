/**
 * Map-loading policy tunables.
 *
 * The rationale for every value here — product motto, user-experience tradeoffs,
 * deployment-profile implications — lives in the meta map offline notes.
 * Read that doc before adjusting a number; the numbers look arbitrary without it.
 */

export const BASEMAP_FETCH_TIMEOUT_MS = {
  default: 4_000,
  adaptive: {
    "4g": 2_000,
    "3g": 4_000,
    "2g": 8_000,
    "slow-2g": 8_000,
  },
} as const;

export type MapLabelsMode = "inline" | "network" | "none";

export const MAP_LABELS_MODE: MapLabelsMode =
  (import.meta.env.VITE_MAP_LABELS_MODE as MapLabelsMode | undefined) ?? "inline";

export const BASEMAP_RETRY_ON_ONLINE = true;

export const LOCAL_GLYPHS_URL = "/glyphs/{fontstack}/{range}.pbf";

/**
 * The one font bundled under public/glyphs. Local glyph requests for any stack
 * load it (see localGlyphRequest); ranges it lacks 404 and MapLibre draws those
 * glyphs with the system font.
 */
export const LOCAL_GLYPHS_FONT = "Open Sans Regular";

/**
 * Open Sans has no Georgian glyphs, and a glyph server answers its own empty
 * range for them, so names in those scripts render blank. The second font
 * fills the gaps on servers that combine stacks (Carto does).
 */
export const LOCAL_LABEL_FONTSTACK = ["Open Sans Regular", "Noto Sans Regular"] as const;

interface NetworkInformationHint {
  effectiveType?: keyof typeof BASEMAP_FETCH_TIMEOUT_MS.adaptive;
}

export function resolveBasemapTimeoutMs(): number {
  const conn = (navigator as Navigator & { connection?: NetworkInformationHint }).connection;
  const type = conn?.effectiveType;
  if (type && type in BASEMAP_FETCH_TIMEOUT_MS.adaptive) {
    return BASEMAP_FETCH_TIMEOUT_MS.adaptive[type];
  }
  return BASEMAP_FETCH_TIMEOUT_MS.default;
}
