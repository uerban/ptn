import type { SelfHostedGeocoderConfig } from "@pt/shared";
import { getPolicy } from "../../stores/privacyStore.ts";
import { SelfHostedGeocoderAdapter } from "./SelfHostedGeocoderAdapter.ts";
import { geocoderRegistry } from "./instance.ts";
import { CITIES } from "../../config/cities.ts";

let currentConfig: SelfHostedGeocoderConfig | null = null;
let cachedJsonConfig: SelfHostedGeocoderConfig | null = null;

const PTN_FST_RUNTIME_ENDPOINT = "/geocoder/ptn-fst";

export function normalizeSelfHostedConfigForCity(
  config: SelfHostedGeocoderConfig,
  cityId: string,
): SelfHostedGeocoderConfig {
  if (config.flavor !== "ptn-fst" || config.endpoint !== PTN_FST_RUNTIME_ENDPOINT) {
    return config;
  }
  return {
    ...config,
    endpoint: `/api/${cityId}/address-search`,
  };
}

export function registerSelfHostedGeocoder(
  config: SelfHostedGeocoderConfig,
): void {
  if (
    currentConfig &&
    currentConfig.endpoint === config.endpoint &&
    currentConfig.flavor === config.flavor &&
    currentConfig.multiTenant === config.multiTenant
  ) {
    return;
  }
  if (currentConfig) {
    geocoderRegistry.unregister("self-hosted");
  }
  currentConfig = config;
  geocoderRegistry.register(
    new SelfHostedGeocoderAdapter(config, () => ({
      m9SelfHosted: getPolicy().m9SelfHosted,
      m10CoarsenGridDefaultMeters: getPolicy().m10CoarsenGridDefaultMeters,
    })),
  );
}

export function unregisterSelfHostedGeocoder(): void {
  if (currentConfig) {
    geocoderRegistry.unregister("self-hosted");
    currentConfig = null;
  }
}

/** Cache the runtime /geocoder-config.json so the synchronous
 *  hasServerSideGeocoder read (called from resolvePoiFetchMode) can consult it
 *  without re-fetching. Set once by main.tsx after the JSON fetch settles. */
export function setRuntimeGeocoderConfig(json: SelfHostedGeocoderConfig | null): void {
  cachedJsonConfig = json;
}

/** Test-only reset of the module-level cache. Mirrors poiLoader's
 *  __resetPoiLoadStatusForTests idiom. Stateful-read suites MUST call this in
 *  beforeEach — jsdom module state persists across `it`. */
export function __resetRuntimeGeocoderConfigForTests(): void {
  cachedJsonConfig = null;
}

/**
 * Resolve the self-hosted geocoder config for a city. Precedence: per-city CityConfig.geocoder
 * OVERRIDES the runtime /geocoder-config.json; absence falls back to the JSON; null when
 * neither is configured. Pure — no fetch, no registry mutation. The cities list is injected
 * (defaulted to CITIES) so this stays unit-testable with zero module mocking. A present
 * per-city geocoder of ANY kind suppresses the JSON fallback (it is the explicit per-city
 * override); no kind guard.
 */
export function resolveSelfHostedConfig(
  cityId: string,
  jsonConfig: SelfHostedGeocoderConfig | null,
  cities: readonly { id: string; geocoder?: SelfHostedGeocoderConfig }[] = CITIES,
): SelfHostedGeocoderConfig | null {
  const city = cities.find((c) => c.id === cityId);
  if (city?.geocoder) return city.geocoder;
  return jsonConfig;
}

/** True iff a self-hosted geocoder resolves for this city (per-city override OR
 * the module-cached JSON). Consumed by resolvePoiFetchMode. Pure sync
 *  read — no fetch. */
export function hasServerSideGeocoder(cityId: string): boolean {
  return resolveSelfHostedConfig(cityId, cachedJsonConfig) !== null;
}

/**
 * Resolve-and-register the self-hosted geocoder for a city. Called from bootPoi.ts's syncPoi
 * prologue (ABOVE the lastMode guard) and from loadGeocoderConfig. Registers the resolved
 * config (per-city override beats JSON), or unregisters when nothing resolves. The cities list
 * is injected (defaulted to CITIES, mirroring resolveSelfHostedConfig) so the
 * per-CityConfig.geocoder branch is unit-testable without mutating CITIES (Should-fix 10).
 */
export function syncSelfHostedRegistration(
  cityId: string,
  cities: readonly { id: string; geocoder?: SelfHostedGeocoderConfig }[] = CITIES,
): void {
  const resolved = resolveSelfHostedConfig(cityId, cachedJsonConfig, cities);
  if (resolved) registerSelfHostedGeocoder(normalizeSelfHostedConfigForCity(resolved, cityId));
  else unregisterSelfHostedGeocoder();
}
