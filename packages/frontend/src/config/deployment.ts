/** Loaded synchronously before the application module by deployment-config.js.
 * No container environment or rebuild is needed to change enabled cities. */
export function runtimeCityIds(value: unknown, knownCities: readonly string[]): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PTN deployment configuration");
  const config = value as {schemaVersion?: unknown; cities?: unknown};
  if (config.schemaVersion !== 1 || !Array.isArray(config.cities) || config.cities.length === 0 ||
      config.cities.some(city => typeof city !== "string" || !knownCities.includes(city)) ||
      new Set(config.cities).size !== config.cities.length) {
    throw new Error("Invalid PTN deployment cities");
  }
  return [...config.cities] as string[];
}
declare global {
  var __PTN_DEPLOYMENT__: unknown;
}

const STORAGE_KEY = "ptn:deployment-cities";

/** The selected cities this build knows. The config is fetched separately
 * from the cached app, so it may name a city added after this build; those
 * are skipped. A config with no usable city falls back to source defaults
 * instead of stopping the app at import. */
function usableCityIds(value: unknown, knownCities: readonly string[]): string[] | null {
  try {
    return runtimeCityIds(value, knownCities);
  } catch {
    const config = value as {schemaVersion?: unknown; cities?: unknown};
    const known = config.schemaVersion === 1 && Array.isArray(config.cities)
      ? [...new Set(config.cities.filter((city): city is string =>
        typeof city === "string" && knownCities.includes(city)))]
      : [];
    console.warn("PTN deployment config names no usable city set; using", known.length ? known : "source defaults");
    return known.length ? known : null;
  }
}

/** Capture the first online page's config before a service worker controls it.
 * Offline cold starts can then retain the selected cities even if the script
 * has not yet entered the SW runtime cache. No user location is stored. */
export function deploymentCityIds(knownCities: readonly string[]): string[] | null {
  let value = globalThis.__PTN_DEPLOYMENT__;
  if (value === undefined) {
    try {
      const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (stored) value = JSON.parse(stored);
    } catch { /* Storage may be unavailable; source defaults remain usable. */ }
  }
  const ids = usableCityIds(value, knownCities);
  if (globalThis.__PTN_DEPLOYMENT__ !== undefined) {
    try {
      if (ids) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({schemaVersion: 1, cities: ids}));
      else globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch { /* No persistent storage in some private browsing contexts. */ }
  }
  return ids;
}
