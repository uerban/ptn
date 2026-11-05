/** Local search preferences. Bundle requests never include these choices. */
export const LOOSE_POI_CATEGORIES = [
  "school", "kindergarten", "retail", "tourism", "named_bus_stop",
] as const;
export type LoosePoiCategory = typeof LOOSE_POI_CATEGORIES[number];
export const LOOSE_POI_CATEGORY_LABELS: Record<LoosePoiCategory, string> = {
  school: "Schools",
  kindergarten: "Kindergartens",
  retail: "Supermarkets",
  tourism: "Tourism and accommodation",
  named_bus_stop: "Additional bus stops",
};

/** Missing category settings migrate the previous all-or-nothing switch. */
export function sanitizePoiCategories(value: unknown, legacyEnabled = false): LoosePoiCategory[] {
  if (!Array.isArray(value)) return legacyEnabled ? [...LOOSE_POI_CATEGORIES] : [];
  return LOOSE_POI_CATEGORIES.filter((category) => value.includes(category));
}
