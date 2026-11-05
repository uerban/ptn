import type {
  PrivacyDataFlowId,
  PrivacyRequestField,
  RoutingRequirement,
} from "@pt/shared";

// Mirrors config/geocoderProviders.ts: a frozen, curated allowlist of remote
// routing providers. Phase 2a ships one third-party entry (transitous, served
// by the backend's `motis` adapter). The standing Settings selection, exact
// field disclosure, and serializer all resolve through this descriptor.
export type RoutingProviderId = "transitous";

export interface RoutingProviderConfig {
  readonly id: RoutingProviderId;
  readonly name: string;
  /** The backend `?adapter=` value this provider routes through. */
  readonly adapter: string;
  readonly tosUrl: string;
  readonly flowId: PrivacyDataFlowId;
  readonly requestFields: readonly PrivacyRequestField[];
  readonly supportedRoutingRequirements: readonly RoutingRequirement[];
}

const TRANSITOUS_REQUEST_FIELDS = Object.freeze([
  "from",
  "to",
  "departAt",
] as const satisfies readonly PrivacyRequestField[]);
const TRANSITOUS_REQUIREMENTS = Object.freeze(
  [] as const satisfies readonly RoutingRequirement[],
);

const providers: Record<RoutingProviderId, RoutingProviderConfig> = {
  transitous: Object.freeze({
    id: "transitous",
    name: "transitous",
    adapter: "motis",
    tosUrl: "https://transitous.org/",
    flowId: "external.remote-routing",
    requestFields: TRANSITOUS_REQUEST_FIELDS,
    supportedRoutingRequirements: TRANSITOUS_REQUIREMENTS,
  }),
};

export const ROUTING_PROVIDERS: Readonly<
  Record<RoutingProviderId, Readonly<RoutingProviderConfig>>
> = Object.freeze(providers);

export function getRoutingProvider(
  id: RoutingProviderId,
): Readonly<RoutingProviderConfig> {
  return ROUTING_PROVIDERS[id];
}
