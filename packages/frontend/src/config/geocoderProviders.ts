import type {
  PrivacyDataFlowId,
  PrivacyRequestField,
} from "@pt/shared";

export type ThirdPartyProviderId = "mapbox" | "nominatim" | "photon";

export interface ProviderConfig {
  readonly id: ThirdPartyProviderId;
  readonly name: string;
  readonly endpoint: string;
  readonly apiKeyFormat?: string;
  readonly tosUrl: string;
  readonly rateLimit: number;
  readonly flowId: PrivacyDataFlowId;
  readonly requestFields: readonly PrivacyRequestField[];
}

const GEOCODER_REQUEST_FIELDS = Object.freeze([
  "query",
  "coarsenedLocation",
] as const satisfies readonly PrivacyRequestField[]);

const providers: Record<ThirdPartyProviderId, ProviderConfig> = {
  mapbox: Object.freeze({
    id: "mapbox",
    name: "Mapbox",
    endpoint: "https://api.mapbox.com",
    apiKeyFormat: "pk.*",
    tosUrl: "https://www.mapbox.com/tos",
    rateLimit: 600,
    flowId: "external.place-search",
    requestFields: GEOCODER_REQUEST_FIELDS,
  }),
  nominatim: Object.freeze({
    id: "nominatim",
    name: "Nominatim (OSM)",
    endpoint: "https://nominatim.openstreetmap.org",
    tosUrl: "https://operations.osmfoundation.org/policies/nominatim/",
    rateLimit: 1,
    flowId: "external.place-search",
    requestFields: GEOCODER_REQUEST_FIELDS,
  }),
  photon: Object.freeze({
    id: "photon",
    name: "Photon (Komoot)",
    endpoint: "https://photon.komoot.io",
    tosUrl: "https://photon.komoot.io/",
    rateLimit: 2,
    flowId: "external.place-search",
    requestFields: GEOCODER_REQUEST_FIELDS,
  }),
};

export const GEOCODER_PROVIDERS: Readonly<
  Record<ThirdPartyProviderId, Readonly<ProviderConfig>>
> = Object.freeze(providers);

export function getProvider(id: ThirdPartyProviderId): Readonly<ProviderConfig> {
  return GEOCODER_PROVIDERS[id];
}

export function assertAllowlisted(id: string): asserts id is ThirdPartyProviderId {
  if (!Object.hasOwn(GEOCODER_PROVIDERS, id)) {
    throw new Error(`Provider "${id}" is not in the curated allowlist`);
  }
}
