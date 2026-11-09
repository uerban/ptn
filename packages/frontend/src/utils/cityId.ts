/** Persisted name of the city store. */
export const CITY_STORAGE_KEY = "ptn-city";

/** Historical city identifiers resolve without discarding their saved data. */
export function canonicalCityId(cityId: string): string {
  return cityId === "gdansk" ? "tricity" : cityId;
}

/**
 * The selected city stored by the city store (`ptn-city`), canonical, or null
 * when none is stored or it cannot be read. Current stores keep only the id;
 * older ones kept the whole city.
 */
export function readStoredCityId(
  storage: Pick<Storage, "getItem"> | undefined,
): string | null {
  try {
    const state = (JSON.parse(storage?.getItem(CITY_STORAGE_KEY) ?? "null") as {
      state?: { currentCityId?: unknown; activeCity?: { id?: unknown } | null };
    } | null)?.state;
    const id = state?.currentCityId ?? state?.activeCity?.id;
    return typeof id === "string" && id ? canonicalCityId(id) : null;
  } catch {
    return null;
  }
}
