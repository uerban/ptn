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

/** Resolve host-owned city metadata before any stores or services initialize.
 * Schema 2 accepts full definitions, so the web archive is city-independent.
 * Legacy schema 1 ID allowlists continue to use built-in metadata. */
export function runtimeCityConfigs(value: unknown, defaults: readonly import("./cities.ts").CityConfig[]): import("./cities.ts").CityConfig[] | null {
  if (value === undefined || value === null) return null;
  const config = value as {schemaVersion?: unknown; cities?: unknown};
  if (config.schemaVersion !== 2) {
    const ids = usableCityIds(value, defaults.map(city => city.id));
    return ids?.map(id => ({...defaults.find(city => city.id === id)!, available: true})) ?? null;
  }
  if (!Array.isArray(config.cities) || config.cities.length === 0) throw new Error("Invalid PTN runtime city catalog");
  const seen = new Set<string>();
  return config.cities.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid PTN runtime city definition");
    const city = entry as Record<string, unknown>;
    const center = city.center as Record<string, unknown> | undefined;
    const bbox = city.bbox as Record<string, unknown> | undefined;
    const number = (value: unknown, min: number, max: number): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
    if (typeof city.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(city.id) || seen.has(city.id) ||
        typeof city.name !== "string" || !city.name.trim() || typeof city.tz !== "string" ||
        !center || !bbox || !number(center.lat, -90, 90) || !number(center.lon, -180, 180) ||
        !number(bbox.minLat, -90, 90) || !number(bbox.maxLat, -90, 90) ||
        !number(bbox.minLon, -180, 180) || !number(bbox.maxLon, -180, 180) ||
        bbox.minLat >= bbox.maxLat || bbox.minLon >= bbox.maxLon ||
        center.lat < bbox.minLat || center.lat > bbox.maxLat || center.lon < bbox.minLon || center.lon > bbox.maxLon) {
      throw new Error("Invalid PTN runtime city metadata");
    }
    try { new Intl.DateTimeFormat("en", {timeZone: city.tz}); }
    catch { throw new Error("Invalid PTN runtime city timezone"); }
    if (city.poiFetchMode !== undefined && !["eager-bundle", "lazy-tile", "server-side"].includes(city.poiFetchMode as string)) {
      throw new Error("Invalid PTN runtime city POI mode");
    }
    seen.add(city.id);
    return {
      ...defaults.find(known => known.id === city.id),
      id: city.id, name: city.name, tz: city.tz, available: true,
      center: {lat: center.lat, lon: center.lon},
      bbox: {minLat: bbox.minLat, minLon: bbox.minLon, maxLat: bbox.maxLat, maxLon: bbox.maxLon},
      ...(city.poiFetchMode === undefined ? {} : {poiFetchMode: city.poiFetchMode as "eager-bundle" | "lazy-tile" | "server-side"}),
    };
  });
}

export function deploymentCityConfigs(defaults: readonly import("./cities.ts").CityConfig[]): import("./cities.ts").CityConfig[] | null {
  let value = globalThis.__PTN_DEPLOYMENT__;
  if (value === undefined) {
    try {
      const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (stored) value = JSON.parse(stored);
    } catch { /* Storage is optional. */ }
  }
  const cities = runtimeCityConfigs(value, defaults);
  if (globalThis.__PTN_DEPLOYMENT__ !== undefined) {
    try {
      if (cities) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
      else globalThis.localStorage?.removeItem(STORAGE_KEY);
    } catch { /* Private browsing may deny storage. */ }
  }
  return cities;
}
