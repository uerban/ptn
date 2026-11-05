import type { LatLon } from "./transit.js";

export type GeocoderProviderId =
  | "address-bundle"
  | "bundled"
  | "self-hosted"
  | "third-party-mapbox"
  | "third-party-nominatim"
  | "third-party-photon"
  | "tile"
  | "legacy-favorite";

export type PrivacyTier = "local" | "self-hosted" | "third-party";

export interface GeocoderCandidate {
  label: string;
  lat: number;
  lon: number;
  confidence: number;
  provider: GeocoderProviderId;
  privacyTier: PrivacyTier;
}

export interface GeocoderAdapter {
  readonly id: GeocoderProviderId;
  readonly privacyTier: PrivacyTier;
  isAvailable(): boolean | Promise<boolean>;
  forward(query: string, hint: LatLon | null, signal: AbortSignal): Promise<GeocoderCandidate[]>;
  reverse(coord: LatLon, signal: AbortSignal): Promise<GeocoderCandidate | null>;
}
