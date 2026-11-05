import type { PrivacyPolicy } from "./privacy.js";

export const PRIVACY_DATA_FLOW_IDS = [
  "operator.transit-data",
  "operator.realtime",
  "operator.nearby-stop-centroid",
  "external.detailed-basemap",
  "operator.place-search",
  "external.place-search",
  "external.stop-search",
  "operator.remote-routing",
  "external.remote-routing",
  "operator.client-report",
] as const;

export type PrivacyDataFlowId = (typeof PRIVACY_DATA_FLOW_IDS)[number];
export type PrivacyDestinationKind = "device" | "operator" | "external";
export type PrivacyFlowTrigger =
  | "automatic"
  | "contextual-choice"
  | "standing-choice"
  | "explicit-action";
export type PrivacyFlowStatus = "active" | "not-shared" | "unavailable";
export type PrivacyProviderKind = "basemap" | "geocoder" | "routing";
export type PrivacyNetworkPath =
  | "none"
  | "operator"
  | "direct-external"
  | "operator-proxied-external";
export type PrivacyDataRecipient =
  | "device"
  | "operator"
  | "provider"
  | "operator-and-provider";

export type PrivacyDataCategory =
  | "network-address"
  | "standard-request-metadata"
  | "transit-resource"
  | "requested-stop"
  | "public-stop-centroid"
  | "viewed-map-area"
  | "search-query"
  | "trip-endpoints"
  | "trip-time"
  | "routing-requirement"
  | "diagnostic";

export type PrivacyDataPrecision =
  | "network"
  | "standard"
  | "public-id"
  | "public-centroid"
  | "tile-area"
  | "text"
  | "exact-coordinate"
  | "coarsened-coordinate"
  | "enumerated";

export interface PrivacyDataItem {
  readonly category: PrivacyDataCategory;
  readonly precision: PrivacyDataPrecision;
  readonly recipient: PrivacyDataRecipient;
}

/** Semantic fields passed to a governed integration. Provider adapters map
 * these to their own URL/query syntax. Internal identity labels such as
 * `mobilityProfile` are deliberately absent. */
export type PrivacyRequestField =
  | "city"
  | "resource"
  | "stopId"
  | "routeId"
  | "stopCentroid"
  | "radiusMeters"
  | "tileCoordinates"
  | "query"
  | "coarsenedLocation"
  | "from"
  | "to"
  | "departAt"
  | "arriveBy"
  | "routingRequirements"
  | "reportKind"
  | "appVersion";

export type RoutingRequirement =
  | "step-free"
  | "max-walk-seconds"
  | "walking-speed"
  | "allowed-modes";

/** Functional constraints understood at a remote-routing boundary. These
 * describe the requested journey, never why a rider needs it. A provider may
 * serialize only keys listed in its `supportedRoutingRequirements`. */
export interface RoutingRequirements {
  readonly stepFree?: boolean;
  readonly maxWalkSeconds?: number;
  readonly walkingSpeedMps?: number;
  readonly allowedModes?: readonly string[];
}

export type PrivacyRetentionReference =
  | "none"
  | "effective-policy"
  | "operator-manifest"
  | "provider-policy";

export interface PrivacyFlowControl {
  readonly policyAxes: readonly (keyof PrivacyPolicy)[];
  readonly settingKeys: readonly string[];
}

export interface PrivacyFlowRetention {
  readonly device: PrivacyRetentionReference;
  readonly operator: PrivacyRetentionReference;
  readonly provider: PrivacyRetentionReference;
}

export interface PrivacyDataFlowDescriptor {
  readonly id: PrivacyDataFlowId;
  readonly nameKey: string;
  readonly purposeKey: string;
  readonly destination: PrivacyDestinationKind;
  readonly networkPath: PrivacyNetworkPath;
  readonly trigger: PrivacyFlowTrigger;
  readonly data: readonly PrivacyDataItem[];
  readonly requestFields: readonly PrivacyRequestField[];
  readonly controls: PrivacyFlowControl;
  readonly retention: PrivacyFlowRetention;
  readonly providerKind?: PrivacyProviderKind;
  /** Disabled flows stay visible in the Privacy Center under this status. */
  readonly inactiveStatus: "not-shared";
}

export interface ResolvedPrivacyDataFlow {
  readonly descriptor: Readonly<PrivacyDataFlowDescriptor>;
  readonly status: PrivacyFlowStatus;
  readonly providerId?: string;
  readonly reason?: string;
}

/** Common structural contract implemented by curated provider configs. */
export interface ProviderFlowDeclaration {
  readonly id: string;
  readonly flowId: PrivacyDataFlowId;
  readonly requestFields: readonly PrivacyRequestField[];
}
