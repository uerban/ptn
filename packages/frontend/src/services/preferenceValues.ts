/**
 * Allowed values of preferences that are validated both by their store and by
 * code that must not import stores (the onboarding record is read before any
 * store module loads).
 */

/**
 * What the map canvas draws underneath the transit overlays. One choice, three
 * rungs of decreasing external dependence:
 *   - detailed : external street basemap (only when the privacy policy allows)
 *   - micromap : the on-device city micromap artifact (water, major roads,
 *                green areas, district labels) — no network at all
 *   - gtfs-only: nothing but GTFS-derived transit corridors
 * `src/map/mapMode.ts` owns the mapping between this setting and the
 * `basemapMode` privacy axis; the two used to be separate controls.
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
