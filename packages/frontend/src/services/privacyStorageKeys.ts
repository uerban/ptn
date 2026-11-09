export const MAP_VIEWPORT_STORAGE_KEY = "ptn-map-viewport";
export const DELAY_REPORTS_STORAGE_KEY = "ptn-delay-reports";
/** Favorites as earlier versions stored them in localStorage. */
export const LEGACY_FAVORITES_KEY = "ptn-favorites";

/** localStorage values holding personal state, sealed by the storage
 * migration. */
export const SEALED_LOCAL_STORAGE_KEYS: readonly string[] = [
  LEGACY_FAVORITES_KEY,
  DELAY_REPORTS_STORAGE_KEY,
  MAP_VIEWPORT_STORAGE_KEY,
];
