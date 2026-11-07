import type {
  GeocoderAdapter,
  GeocoderCandidate,
  GeocoderProviderId,
  LatLon,
  PrivacyTier,
  ProtectionPolicy,
} from "@pt/shared";
import { coarsen, type CoarsenedRequest } from "../coordPrivacy.ts";
import { fetchThirdPartyGeocoder, formatCoord } from "./fetchThirdParty.ts";
import {
  getProvider,
  type ProviderConfig,
  type ThirdPartyProviderId,
} from "../../config/geocoderProviders.ts";
import { dedupKey } from "./dedupKey.ts";
import { readDedupEntry, writeDedupEntry } from "./dedupCache.ts";
import { reportError } from "../errorReporter.ts";
import { canUse } from "../../privacy/canUse.ts";

const PROVIDER_IDS: Record<ThirdPartyProviderId, GeocoderProviderId> = {
  mapbox: "third-party-mapbox",
  nominatim: "third-party-nominatim",
  photon: "third-party-photon",
};

export interface ThirdPartyGeocoderConfig {
  provider: ThirdPartyProviderId;
  endpoint: string;
  apiKey?: string;
}

export function configFromAllowlist(
  providerId: ThirdPartyProviderId,
  apiKey?: string,
): ThirdPartyGeocoderConfig {
  const provider = getProvider(providerId);
  return {
    provider: providerId,
    endpoint: provider.endpoint,
    apiKey,
  };
}

type PolicySlice = Pick<ProtectionPolicy, "m10CoarsenGridDefaultMeters">;

const RESULT_LIMIT = 5;
export const DEFAULT_GRID_METERS = 500;

export class ThirdPartyGeocoderAdapter implements GeocoderAdapter {
  readonly id: GeocoderProviderId;
  readonly privacyTier = "third-party" as const;
  private readonly providerMeta: Readonly<ProviderConfig>;
  private readonly getApiKey: () => string | undefined;
  private readonly isAllowed: () => boolean;

  /**
   * `isAllowed` resolves `external.place-search` for this provider; it is read
   * on every availability check, so a revocation applies to the next query.
   */
  constructor(
    private readonly config: ThirdPartyGeocoderConfig,
    private readonly getPolicy: () => PolicySlice,
    getApiKey?: () => string | undefined,
    isAllowed?: () => boolean,
  ) {
    this.id = PROVIDER_IDS[config.provider];
    this.providerMeta = getProvider(config.provider);
    this.getApiKey = getApiKey ?? (() => config.apiKey);
    this.isAllowed =
      isAllowed ?? (() => canUse("external.place-search", config.provider));
  }

  get unavailableReason(): string | null {
    if (!this.isAllowed()) {
      return `third-party geocoding with ${this.providerMeta.name} is disabled until it is allowed`;
    }
    if (this.providerMeta.apiKeyFormat && !this.getApiKey()) {
      return `${this.providerMeta.name} requires an API key`;
    }
    return null;
  }

  isAvailable(): boolean {
    return this.unavailableReason === null;
  }

  private gridMeters(): number {
    const grid = this.getPolicy().m10CoarsenGridDefaultMeters;
    return grid > 0 ? grid : DEFAULT_GRID_METERS;
  }

  private resolvedConfig(): ThirdPartyGeocoderConfig {
    return { ...this.config, apiKey: this.getApiKey() };
  }

  async forward(
    query: string,
    hint: LatLon | null,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate[]> {
    if (!this.isAvailable()) {
      throw new Error(`Adapter ${this.id} is not available: ${this.unavailableReason}`);
    }
    const grid = this.gridMeters();
    const coarsenedHint = hint ? coarsen(hint, grid) : null;

    // Dedup cache requires a coarsened coord (per spec: "same coarsened coord
    // + same query + same provider"). Hintless calls always hit the network.
    const key = coarsenedHint
      ? await dedupKey(query, coarsenedHint, this.id)
      : null;
    if (key) {
      const cached = await readDedupEntry(key).catch((e: unknown) => {
        reportError(e instanceof Error ? e : new Error(String(e)), {
          context: { source: "dedupCacheRead", provider: this.id },
        });
        return null;
      });
      if (cached) return cached;
    }

    const url = buildForwardUrl(this.resolvedConfig(), query, coarsenedHint, grid);
    const res = await fetchThirdPartyGeocoder(url, null, grid, signal);
    const body = await res.json();
    const candidates = this.parseForward(body);
    // Only cache successful responses — a 4xx/5xx that parses to [] would
    // otherwise poison the cache for the full TTL.
    if (key && res.ok) {
      await writeDedupEntry(key, candidates, this.id, grid).catch(
        (e: unknown) => {
          reportError(e instanceof Error ? e : new Error(String(e)), {
            context: { source: "dedupCacheWrite", provider: this.id },
          });
        },
      );
    }
    return candidates;
  }

  async reverse(
    coord: LatLon,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate | null> {
    if (!this.isAvailable()) {
      throw new Error(`Adapter ${this.id} is not available: ${this.unavailableReason}`);
    }
    const grid = this.gridMeters();
    const coarsened = coarsen(coord, grid);
    const url = buildReverseUrl(this.resolvedConfig(), coarsened, grid);
    const res = await fetchThirdPartyGeocoder(url, null, grid, signal);
    const body = await res.json();
    return this.parseReverse(body);
  }

  private parseForward(body: unknown): GeocoderCandidate[] {
    switch (this.config.provider) {
      case "mapbox":
        return parseMapboxForward(body, this.id, this.privacyTier);
      case "nominatim":
        return parseNominatimForward(body, this.id, this.privacyTier);
      case "photon":
        return parsePhotonForward(body, this.id, this.privacyTier);
    }
  }

  private parseReverse(body: unknown): GeocoderCandidate | null {
    switch (this.config.provider) {
      case "mapbox":
        return parseMapboxReverse(body, this.id, this.privacyTier);
      case "nominatim":
        return parseNominatimReverse(body, this.id, this.privacyTier);
      case "photon":
        return parsePhotonReverse(body, this.id, this.privacyTier);
    }
  }
}

export function buildForwardUrl(
  config: ThirdPartyGeocoderConfig,
  query: string,
  hint: CoarsenedRequest | null,
  gridMeters: number,
): string {
  const base = config.endpoint.replace(/\/+$/, "");
  const fmt = (v: number) => formatCoord(v, gridMeters);

  switch (config.provider) {
    case "mapbox": {
      const url = new URL(
        `${base}/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`,
      );
      if (config.apiKey) url.searchParams.set("access_token", config.apiKey);
      url.searchParams.set("limit", String(RESULT_LIMIT));
      if (hint) {
        url.searchParams.set(
          "proximity",
          `${fmt(hint.snappedCoord.lon)},${fmt(hint.snappedCoord.lat)}`,
        );
      }
      return url.toString();
    }
    case "nominatim": {
      const url = new URL(`${base}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", String(RESULT_LIMIT));
      if (hint) {
        const d = 0.1;
        url.searchParams.set(
          "viewbox",
          `${fmt(hint.snappedCoord.lon - d)},${fmt(hint.snappedCoord.lat + d)},${fmt(hint.snappedCoord.lon + d)},${fmt(hint.snappedCoord.lat - d)}`,
        );
        url.searchParams.set("bounded", "0");
      }
      return url.toString();
    }
    case "photon": {
      const url = new URL(`${base}/api`);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(RESULT_LIMIT));
      if (hint) {
        url.searchParams.set("lat", fmt(hint.snappedCoord.lat));
        url.searchParams.set("lon", fmt(hint.snappedCoord.lon));
      }
      return url.toString();
    }
  }
}

export function buildReverseUrl(
  config: ThirdPartyGeocoderConfig,
  coarsened: CoarsenedRequest,
  gridMeters: number,
): string {
  const base = config.endpoint.replace(/\/+$/, "");
  const fmt = (v: number) => formatCoord(v, gridMeters);

  switch (config.provider) {
    case "mapbox": {
      const url = new URL(
        `${base}/geocoding/v5/mapbox.places/${fmt(coarsened.snappedCoord.lon)},${fmt(coarsened.snappedCoord.lat)}.json`,
      );
      if (config.apiKey) url.searchParams.set("access_token", config.apiKey);
      url.searchParams.set("limit", "1");
      return url.toString();
    }
    case "nominatim": {
      const url = new URL(`${base}/reverse`);
      url.searchParams.set("lat", fmt(coarsened.snappedCoord.lat));
      url.searchParams.set("lon", fmt(coarsened.snappedCoord.lon));
      url.searchParams.set("format", "jsonv2");
      return url.toString();
    }
    case "photon": {
      const url = new URL(`${base}/reverse`);
      url.searchParams.set("lat", fmt(coarsened.snappedCoord.lat));
      url.searchParams.set("lon", fmt(coarsened.snappedCoord.lon));
      return url.toString();
    }
  }
}

function clampConfidence(v: number | undefined): number {
  if (v == null || !Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function buildLabel(props: {
  name?: string;
  display_name?: string;
  city?: string;
  country?: string;
}): string {
  if (props.display_name) return props.display_name;
  const parts = [props.name, props.city, props.country].filter(Boolean);
  return parts.join(", ") || "Unknown";
}

function parseMapboxForward(
  body: unknown,
  provider: GeocoderProviderId,
  tier: PrivacyTier,
): GeocoderCandidate[] {
  const fc = body as {
    features?: Array<{
      place_name: string;
      center: [number, number];
      relevance: number;
    }>;
  };
  if (!fc.features?.length) return [];
  return fc.features.slice(0, RESULT_LIMIT).map((f) => ({
    label: f.place_name ?? "Unknown",
    lon: f.center[0]!,
    lat: f.center[1]!,
    confidence: clampConfidence(f.relevance),
    provider,
    privacyTier: tier,
  }));
}

function parseMapboxReverse(
  body: unknown,
  provider: GeocoderProviderId,
  tier: PrivacyTier,
): GeocoderCandidate | null {
  const fc = body as {
    features?: Array<{
      place_name: string;
      center: [number, number];
      relevance: number;
    }>;
  };
  if (!fc.features?.length) return null;
  const f = fc.features[0]!;
  return {
    label: f.place_name ?? "Unknown",
    lon: f.center[0]!,
    lat: f.center[1]!,
    confidence: clampConfidence(f.relevance),
    provider,
    privacyTier: tier,
  };
}

function parseNominatimForward(
  body: unknown,
  provider: GeocoderProviderId,
  tier: PrivacyTier,
): GeocoderCandidate[] {
  if (!Array.isArray(body)) return [];
  return body.slice(0, RESULT_LIMIT).map((item) => ({
    label: item.display_name ?? "Unknown",
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
    confidence: clampConfidence(item.importance),
    provider,
    privacyTier: tier,
  }));
}

function parseNominatimReverse(
  body: unknown,
  provider: GeocoderProviderId,
  tier: PrivacyTier,
): GeocoderCandidate | null {
  const item = body as Record<string, unknown>;
  if (item.error || !item.display_name) return null;
  return {
    label: item.display_name as string,
    lat: parseFloat(item.lat as string),
    lon: parseFloat(item.lon as string),
    confidence: clampConfidence(item.importance as number | undefined),
    provider,
    privacyTier: tier,
  };
}

function parsePhotonForward(
  body: unknown,
  provider: GeocoderProviderId,
  tier: PrivacyTier,
): GeocoderCandidate[] {
  const fc = body as {
    features?: Array<{
      geometry: { coordinates: number[] };
      properties: Record<string, unknown>;
    }>;
  };
  if (!fc.features?.length) return [];
  return fc.features.slice(0, RESULT_LIMIT).map((f) => ({
    label: buildLabel(
      f.properties as {
        name?: string;
        city?: string;
        country?: string;
      },
    ),
    lat: f.geometry.coordinates[1]!,
    lon: f.geometry.coordinates[0]!,
    confidence: clampConfidence(
      f.properties.importance as number | undefined,
    ),
    provider,
    privacyTier: tier,
  }));
}

function parsePhotonReverse(
  body: unknown,
  provider: GeocoderProviderId,
  tier: PrivacyTier,
): GeocoderCandidate | null {
  const fc = body as {
    features?: Array<{
      geometry: { coordinates: number[] };
      properties: Record<string, unknown>;
    }>;
  };
  if (!fc.features?.length) return null;
  const f = fc.features[0]!;
  return {
    label: buildLabel(
      f.properties as {
        name?: string;
        city?: string;
        country?: string;
      },
    ),
    lat: f.geometry.coordinates[1]!,
    lon: f.geometry.coordinates[0]!,
    confidence: clampConfidence(
      f.properties.importance as number | undefined,
    ),
    provider,
    privacyTier: tier,
  };
}
