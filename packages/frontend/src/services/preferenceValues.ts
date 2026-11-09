/**
 * Allowed values of preferences that are validated both by their store and by
 * code that must not import stores (the onboarding record is read before any
 * store module loads).
 */

/**
 * What the map canvas draws underneath the transit overlays, a display
 * preference with three rungs of decreasing external dependence:
 *   - detailed : external street basemap, drawn only while its provider's
 *                network decision allows it
 *   - micromap : the city micromap (water, major roads, green areas, district
 *                labels), downloaded once from this app's server and then
 *                drawn on the device with no further requests
 *   - gtfs-only: nothing but GTFS-derived transit corridors
 * `src/map/mapMode.ts` resolves what is actually drawn from this preference
 * and the detailed map's network decision.
 */
export const MAP_DETAIL_MODES = ["detailed", "micromap", "gtfs-only"] as const;
export type MapDetailMode = (typeof MAP_DETAIL_MODES)[number];

export function isMapDetailMode(x: unknown): x is MapDetailMode {
  return typeof x === "string" && (MAP_DETAIL_MODES as readonly string[]).includes(x);
}

export const OPTIONAL_STORAGE_CATEGORIES = [
  "recents",
  "viewport",
  "personalization",
] as const;
export type OptionalStorageCategory = (typeof OPTIONAL_STORAGE_CATEGORIES)[number];

export const OPTIONAL_STORAGE_CHOICES = ["unset", "enabled", "disabled"] as const;
export type OptionalStorageChoice = (typeof OPTIONAL_STORAGE_CHOICES)[number];

export function isOptionalStorageChoice(value: unknown): value is OptionalStorageChoice {
  return (OPTIONAL_STORAGE_CHOICES as readonly unknown[]).includes(value);
}
