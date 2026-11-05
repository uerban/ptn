import type {
  GeocoderAdapter,
  GeocoderCandidate,
  LatLon,
  PrivacyPolicy,
  SelfHostedGeocoderConfig,
} from "@pt/shared";
import type { AddressSearchResponse } from "@pt/shared/address-search";
import { coarsen } from "../coordPrivacy.ts";
import { assertNoPrecisionLeak, formatCoord } from "./fetchThirdParty.ts";

type PolicySlice = Pick<PrivacyPolicy, "m9SelfHosted" | "m10CoarsenGridDefaultMeters">;

function resolveUrl(path: string): URL {
  if (/^https?:\/\//.test(path)) return new URL(path);
  return new URL(path, globalThis.location.origin);
}

const DEFAULT_COARSEN_METERS = 50;
const RESULT_LIMIT = 5;

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

export class SelfHostedGeocoderAdapter implements GeocoderAdapter {
  readonly id = "self-hosted" as const;
  readonly privacyTier = "self-hosted" as const;

  constructor(
    private readonly config: SelfHostedGeocoderConfig,
    private readonly getPolicy: () => PolicySlice,
  ) {}

  isAvailable(): boolean {
    return this.getPolicy().m9SelfHosted !== "disabled";
  }

  async forward(
    query: string,
    hint: LatLon | null,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate[]> {
    const coarsenedHint = hint ? this.maybeCoarsen(hint) : null;
    const url = this.buildForwardUrl(query, coarsenedHint);
    const res = await this.doFetch(url, signal);
    const body = await res.json();
    if (this.config.flavor === "nominatim") return this.parseNominatimForward(body);
    if (this.config.flavor === "ptn-fst") return this.parsePtnFstForward(body);
    return this.parsePhotonForward(body);
  }

  async reverse(
    coord: LatLon,
    signal: AbortSignal,
  ): Promise<GeocoderCandidate | null> {
    if (this.config.flavor === "ptn-fst") return null;
    const sent = this.maybeCoarsen(coord);
    const url = this.buildReverseUrl(sent);
    const res = await this.doFetch(url, signal);
    const body = await res.json();
    return this.config.flavor === "nominatim"
      ? this.parseNominatimReverse(body)
      : this.parsePhotonReverse(body);
  }

  private shouldCoarsen(): boolean {
    const policy = this.getPolicy();
    if (policy.m9SelfHosted === "always-coarsen") return true;
    if (this.config.multiTenant) return true;
    return false;
  }

  private coarsenMeters(): number {
    const grid = this.getPolicy().m10CoarsenGridDefaultMeters;
    return grid > 0 ? grid : DEFAULT_COARSEN_METERS;
  }

  private maybeCoarsen(coord: LatLon): LatLon {
    if (!this.shouldCoarsen()) return coord;
    return coarsen(coord, this.coarsenMeters()).snappedCoord;
  }

  private fmtCoord(value: number): string {
    if (!this.shouldCoarsen()) return String(value);
    return formatCoord(value, this.coarsenMeters());
  }

  private buildForwardUrl(query: string, hint: LatLon | null): string {
    const base = this.config.endpoint.replace(/\/+$/, "");
    if (this.config.flavor === "ptn-fst") {
      const url = resolveUrl(base);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(RESULT_LIMIT));
      if (hint) {
        url.searchParams.set("lat", this.fmtCoord(hint.lat));
        url.searchParams.set("lon", this.fmtCoord(hint.lon));
      }
      return url.toString();
    }
    if (this.config.flavor === "nominatim") {
      const url = resolveUrl(`${base}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", String(RESULT_LIMIT));
      if (hint) {
        const d = 0.1;
        url.searchParams.set(
          "viewbox",
          `${this.fmtCoord(hint.lon - d)},${this.fmtCoord(hint.lat + d)},${this.fmtCoord(hint.lon + d)},${this.fmtCoord(hint.lat - d)}`,
        );
        url.searchParams.set("bounded", "0");
      }
      return url.toString();
    }
    const url = resolveUrl(`${base}/api`);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(RESULT_LIMIT));
    if (hint) {
      url.searchParams.set("lat", this.fmtCoord(hint.lat));
      url.searchParams.set("lon", this.fmtCoord(hint.lon));
    }
    return url.toString();
  }

  private buildReverseUrl(coord: LatLon): string {
    const base = this.config.endpoint.replace(/\/+$/, "");
    if (this.config.flavor === "nominatim") {
      const url = resolveUrl(`${base}/reverse`);
      url.searchParams.set("lat", this.fmtCoord(coord.lat));
      url.searchParams.set("lon", this.fmtCoord(coord.lon));
      url.searchParams.set("format", "jsonv2");
      return url.toString();
    }
    const url = resolveUrl(`${base}/reverse`);
    url.searchParams.set("lat", this.fmtCoord(coord.lat));
    url.searchParams.set("lon", this.fmtCoord(coord.lon));
    return url.toString();
  }

  private async doFetch(url: string, signal: AbortSignal): Promise<Response> {
    if (this.shouldCoarsen()) {
      assertNoPrecisionLeak(url, null, this.coarsenMeters());
    }
    const res = await fetch(url, {
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
    return res;
  }

  private parseNominatimForward(body: unknown): GeocoderCandidate[] {
    if (!Array.isArray(body)) return [];
    return body
      .map((item) => ({
        label: item.display_name ?? "Unknown",
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
        confidence: clampImportance(item.importance),
        provider: this.id,
        privacyTier: this.privacyTier,
      }))
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  }

  private parsePhotonForward(body: unknown): GeocoderCandidate[] {
    const fc = body as { features?: Array<{ geometry: { coordinates: number[] }; properties: Record<string, unknown> }> };
    if (!fc.features?.length) return [];
    const results: GeocoderCandidate[] = [];
    for (const f of fc.features) {
      const lat = f.geometry.coordinates[1];
      const lon = f.geometry.coordinates[0];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      results.push({
        label: buildLabel(f.properties as { name?: string; city?: string; country?: string }),
        lat,
        lon,
        confidence: clampImportance(f.properties.importance as number | undefined),
        provider: this.id,
        privacyTier: this.privacyTier,
      });
    }
    return results;
  }

  private parsePtnFstForward(body: unknown): GeocoderCandidate[] {
    const response = body as Partial<AddressSearchResponse>;
    if (!Array.isArray(response.data)) return [];
    const results: GeocoderCandidate[] = [];
    for (const item of response.data) {
      if (typeof item.label !== "string") continue;
      if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
      results.push({
        label: item.label,
        lat: item.lat,
        lon: item.lon,
        confidence: clampImportance(item.confidence),
        provider: this.id,
        privacyTier: this.privacyTier,
      });
    }
    return results;
  }

  private parseNominatimReverse(body: unknown): GeocoderCandidate | null {
    const item = body as Record<string, unknown>;
    if (item.error || !item.display_name) return null;
    const lat = parseFloat(item.lat as string);
    const lon = parseFloat(item.lon as string);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      label: item.display_name as string,
      lat,
      lon,
      confidence: clampImportance(item.importance as number | undefined),
      provider: this.id,
      privacyTier: this.privacyTier,
    };
  }

  private parsePhotonReverse(body: unknown): GeocoderCandidate | null {
    const fc = body as { features?: Array<{ geometry: { coordinates: number[] }; properties: Record<string, unknown> }> };
    if (!fc.features?.length) return null;
    const f = fc.features[0]!;
    const lat = f.geometry.coordinates[1];
    const lon = f.geometry.coordinates[0];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      label: buildLabel(f.properties as { name?: string; city?: string; country?: string }),
      lat,
      lon,
      confidence: clampImportance(f.properties.importance as number | undefined),
      provider: this.id,
      privacyTier: this.privacyTier,
    };
  }
}

function clampImportance(v: number | undefined): number {
  if (v == null || !Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}
