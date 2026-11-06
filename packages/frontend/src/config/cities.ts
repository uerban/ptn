import presets from "../../../../examples/native/city-presets.json";
import {deploymentCityConfigs} from "./deployment.ts";
import type { RouteGroup } from "../services/routeGroups.ts";
import type { PoiFetchMode, SelfHostedGeocoderConfig, TransportMode } from "@pt/shared";

/**
 * One shared-mobility (GBFS) operator serving a city. The client speaks the
 * GBFS standard (2.x and 3.0 discovery shapes) — this entry is ALL the
 * operator-specific configuration there is; adding an operator/city is one
 * more entry, no code. `gbfsDiscoveryUrl` must be https: the PWA fetches it
 * directly from the operator (no PTN backend proxy).
 */
export interface SharedMobilitySystem {
  /** Stable operator id, part of the Dexie cache key ("<cityId>:<id>"). */
  readonly id: string;
  /** Operator display name for the station tap sheet ("Cyclocity Vilnius"). */
  readonly name: string;
  /**
   * GBFS auto-discovery (gbfs.json) URL; https only (feed URLs the
   * document resolves to are held to the same floor by the client).
   */
  readonly gbfsDiscoveryUrl: string;
}

export interface CityConfig {
  readonly id: string;
  readonly name: string;
  readonly center: { readonly lat: number; readonly lon: number };
  readonly bbox: { readonly minLat: number; readonly minLon: number; readonly maxLat: number; readonly maxLon: number };
  readonly available: boolean;
  /** Schedule-source credits shown in Settings for the active city. */
  readonly transitSources?: readonly { readonly name: string; readonly url: string }[];
  /**
   * IANA timezone of the city's feed (its GTFS `agency_timezone`). The
   * source-of-truth mirror of the bundle's `meta.cityTzIana`; threaded into the
   * query (feed-tz service-day + seconds) and display (feed-tz time labels) so a
   * device whose tz differs from the feed still routes and renders in the city's
   * local time. Cross-checked at load against `meta.cityTzIana` (drift guard).
   *
   * REQUIRED (Stage-B-aligned): this is the exact field `feat/paris-schedule-tile-
   * ui-cutover` J1/J2 consume via `activeCity.tz`. Every city MUST set it;
   * `cities.tz.test.ts` gates the value + IANA validity.
   */
  readonly tz: string;
  /**
 * Per-city self-hosted geocoder endpoint. When set, it registers the SelfHostedGeocoderAdapter
 * for this city; POI fetch residency is still governed by poiFetchMode/user/privacy policy.
 * READ by services/geocoder/registerSelfHosted.ts (resolveSelfHostedConfig) — it OVERRIDES the
 * runtime /geocoder-config.json. Default-off: ship no value to keep address augmentation inert.
 * A frontend CLIENT concern; never confused with the backend CityProfile.geocoder
 * (build/harness).
 */
  readonly geocoder?: SelfHostedGeocoderConfig;
  /**
   * Modes that start excluded from routing for this city (the filter chip
   * still shows, so the user can opt in for the session). For services that
   * exist in the feed but are unreliable enough that defaulting them out is
   * the safer behaviour. Seeded once per session by
   * `settingsStore.applyCityModeDefaults`.
   */
  readonly routeGroups?: readonly RouteGroup[];
  readonly defaultExcludedModes?: readonly TransportMode[];
  /**
   * Per-city OPERATOR default POI fetch mode (the per-city activation switch —
   * the GLOBAL VITE_PT_POI_FETCH_MODE flips ALL cities at once and is
   * unsuitable for a single-city rollout). Validated at COMPILE TIME only (the
   * `PoiFetchMode` union); see the asymmetry note in poiFetchMode.ts. This is
   * rung 3 in resolvePoiFetchMode's precedence ladder — that JSDoc
   * (poiFetchMode.ts) is the SINGLE SOURCE of the full ordering; do not re-list
   * the rungs here. Default-off: ship no value to keep the city on the global
   * default (today's eager-bundle).
   */
  readonly poiFetchMode?: PoiFetchMode;
  /** Artifact city IDs for a multi-area deployment; defaults to this city ID. */
  readonly poiCityIds?: readonly string[];
  /**
   * Shared-mobility (GBFS) operators whose live station availability the map
   * can overlay as an opt-in bike layer. When set, the bike toggle chip shows
   * for the city; it starts OFF and its state is session-only. PRIVACY: no
   * request leaves for the operator until the user turns the layer on — that
   * first toggle tap is explicit opt-in to third-party contact (operator sees
   * client IP; fetches are full-city, never position-parameterised). READ by
   * `stores/bikeShareStore`. Default-off: ship no value and the city has no
   * bike layer at all — behaviour is byte-for-byte unchanged.
   *
   * SCOPE: only the FIRST entry is live — the store drives one operator per
   * city (multi-system needs station namespacing + per-system degradation;
   * see the shared mobility gbfs notes). Keep the array length 1.
   */
  readonly sharedMobility?: readonly SharedMobilitySystem[];
}

const BUILTIN_CITIES: readonly CityConfig[] = (presets as readonly CityConfig[]).map(city => ({
  ...city, available: city.id === "tbilisi" ? import.meta.env.VITE_PT_TBILISI_ENABLED === "1" : city.available,
}));

// All consumers (including timezone and geocoder lookup) share the runtime catalog.
let deploymentCities = deploymentCityConfigs(BUILTIN_CITIES);
export let CITIES: readonly CityConfig[] = deploymentCities ?? BUILTIN_CITIES;

/** Explicitly install discovery results even when bundler shared chunks have
 * evaluated catalog consumers before the asynchronous bootstrap completes. */
export function installCityCatalog(cities: readonly CityConfig[]): void {
  if (!cities.length) throw new Error("Host serves no cities");
  deploymentCities = [...cities];
  CITIES = deploymentCities;
}

/** Cities enabled by the host, or source defaults when no host config exists. */
export function getAvailableCities(): CityConfig[] {
  return CITIES.filter(city => city.available);
}

/** Find nearest available city to a lat/lon coordinate. */
export function findNearestCity(lat: number, lon: number): CityConfig {
  const available = getAvailableCities();
  let nearest = available[0];
  let minDist = Infinity;
  for (const city of available) {
    const dlat = lat - city.center.lat;
    const dlon = lon - city.center.lon;
    const dist = dlat * dlat + dlon * dlon;
    if (dist < minDist) {
      minDist = dist;
      nearest = city;
    }
  }
  return nearest;
}

/** Find which city's bbox contains a lat/lon, or null */
export function findCityByLocation(lat: number, lon: number): CityConfig | null {
  return (deploymentCities ? getAvailableCities() : CITIES).find((c) =>
    lat >= c.bbox.minLat && lat <= c.bbox.maxLat &&
    lon >= c.bbox.minLon && lon <= c.bbox.maxLon
  ) ?? null;
}
