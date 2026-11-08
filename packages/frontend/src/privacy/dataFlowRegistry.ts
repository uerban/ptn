import type {
  PrivacyDataFlowDescriptor,
  PrivacyDataFlowId,
  PrivacyRequestField,
  ProviderFlowDeclaration,
} from "@pt/shared";
import { AXIS_STRICTNESS_ORDER } from "@pt/shared/privacy";

const OPERATOR_NETWORK_METADATA = [
  {
    category: "network-address",
    precision: "network",
    recipient: "operator",
  },
  {
    category: "standard-request-metadata",
    precision: "standard",
    recipient: "operator",
  },
] as const;

const PROVIDER_NETWORK_METADATA = [
  {
    category: "network-address",
    precision: "network",
    recipient: "provider",
  },
  {
    category: "standard-request-metadata",
    precision: "standard",
    recipient: "provider",
  },
] as const;

const RAW_DATA_FLOW_REGISTRY: PrivacyDataFlowDescriptor[] = [
  {
    id: "operator.transit-data",
    nameKey: "privacy.flow.operator.transitData.name",
    purposeKey: "privacy.flow.operator.transitData.purpose",
    destination: "operator",
    networkPath: "operator",
    trigger: "automatic",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      {
        category: "transit-resource",
        precision: "public-id",
        recipient: "operator",
      },
    ],
    requestFields: ["city", "resource"],
    controls: { policyAxes: [], settingKeys: [] },
    retention: {
      device: "none",
      operator: "operator-manifest",
      provider: "none",
    },
    inactiveStatus: "not-shared",
  },
  {
    id: "operator.realtime",
    nameKey: "privacy.flow.operator.realtime.name",
    purposeKey: "privacy.flow.operator.realtime.purpose",
    destination: "operator",
    networkPath: "operator",
    trigger: "automatic",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      {
        category: "requested-stop",
        precision: "public-id",
        recipient: "operator",
      },
      // Live delays per route (/rt/<routeId>): the first ride of each route
      // result, every ride of a guided trip, and the line of an open trip
      // sheet (a tapped ETA pill on the map).
      {
        category: "transit-resource",
        precision: "public-id",
        recipient: "operator",
      },
    ],
    requestFields: ["city", "stopId", "routeId"],
    controls: { policyAxes: ["realTimePolling"], settingKeys: [] },
    retention: {
      device: "none",
      operator: "operator-manifest",
      provider: "none",
    },
    inactiveStatus: "not-shared",
  },
  {
    // City-wide service alerts (/api/<city>/alerts). The request names only
    // the city; which stops, lines or trips concern the rider is worked out
    // on the device.
    id: "operator.service-alerts",
    nameKey: "privacy.flow.operator.serviceAlerts.name",
    purposeKey: "privacy.flow.operator.serviceAlerts.purpose",
    destination: "operator",
    networkPath: "operator",
    trigger: "automatic",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      {
        category: "transit-resource",
        precision: "public-id",
        recipient: "operator",
      },
    ],
    requestFields: ["city"],
    controls: { policyAxes: [], settingKeys: [] },
    retention: {
      device: "none",
      operator: "operator-manifest",
      provider: "none",
    },
    inactiveStatus: "not-shared",
  },
  {
    id: "operator.nearby-stop-centroid",
    nameKey: "privacy.flow.operator.nearbyStopCentroid.name",
    purposeKey: "privacy.flow.operator.nearbyStopCentroid.purpose",
    destination: "operator",
    networkPath: "operator",
    trigger: "automatic",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      {
        category: "public-stop-centroid",
        precision: "public-centroid",
        recipient: "operator",
      },
    ],
    requestFields: ["stopCentroid", "radiusMeters"],
    controls: { policyAxes: ["nearbyStopLookup"], settingKeys: [] },
    retention: {
      device: "none",
      operator: "operator-manifest",
      provider: "none",
    },
    inactiveStatus: "not-shared",
  },
  {
    id: "external.detailed-basemap",
    nameKey: "privacy.flow.external.detailedBasemap.name",
    purposeKey: "privacy.flow.external.detailedBasemap.purpose",
    destination: "external",
    networkPath: "direct-external",
    trigger: "automatic",
    data: [
      ...PROVIDER_NETWORK_METADATA,
      {
        category: "viewed-map-area",
        precision: "tile-area",
        recipient: "provider",
      },
    ],
    requestFields: ["tileCoordinates"],
    controls: { policyAxes: ["basemapMode"], settingKeys: ["mapDetailMode"] },
    retention: {
      device: "effective-policy",
      operator: "none",
      provider: "provider-policy",
    },
    providerKind: "basemap",
    inactiveStatus: "not-shared",
  },
  {
    id: "operator.place-search",
    nameKey: "privacy.flow.operator.placeSearch.name",
    purposeKey: "privacy.flow.operator.placeSearch.purpose",
    destination: "operator",
    networkPath: "operator",
    trigger: "standing-choice",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      { category: "search-query", precision: "text", recipient: "operator" },
      {
        category: "viewed-map-area",
        precision: "coarsened-coordinate",
        recipient: "operator",
      },
    ],
    requestFields: ["query", "coarsenedLocation"],
    controls: {
      policyAxes: ["m9SelfHosted", "poiResidency"],
      settingKeys: ["searchProvider"],
    },
    retention: {
      device: "effective-policy",
      operator: "operator-manifest",
      provider: "none",
    },
    providerKind: "geocoder",
    inactiveStatus: "not-shared",
  },
  {
    id: "external.place-search",
    nameKey: "privacy.flow.external.placeSearch.name",
    purposeKey: "privacy.flow.external.placeSearch.purpose",
    destination: "external",
    networkPath: "direct-external",
    trigger: "standing-choice",
    data: [
      ...PROVIDER_NETWORK_METADATA,
      { category: "search-query", precision: "text", recipient: "provider" },
      {
        category: "viewed-map-area",
        precision: "coarsened-coordinate",
        recipient: "provider",
      },
    ],
    requestFields: ["query", "coarsenedLocation"],
    controls: {
      policyAxes: ["m10ThirdPartyEnabled"],
      settingKeys: ["thirdPartyProvider"],
    },
    retention: {
      device: "effective-policy",
      operator: "none",
      provider: "provider-policy",
    },
    providerKind: "geocoder",
    inactiveStatus: "not-shared",
  },
  {
    // Remote STOP search. Distinct from the two place-search flows above: those
    // are the operator's own geocoder and the curated third-party geocoders,
    // neither of which is transitous. This one is the `searchProvider: "remote"`
    // path (services/searchSuggestions.ts), which reaches transitous through the
    // PTN backend proxy — the same upstream and the same proxied shape as
    // `external.remote-routing`, so it is modelled identically: the network
    // address stops at the operator, the query itself does not.
    id: "external.stop-search",
    nameKey: "privacy.flow.external.stopSearch.name",
    purposeKey: "privacy.flow.external.stopSearch.purpose",
    destination: "external",
    networkPath: "operator-proxied-external",
    trigger: "standing-choice",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      {
        category: "search-query",
        precision: "text",
        recipient: "operator-and-provider",
      },
    ],
    requestFields: ["query"],
    controls: {
      // Both axes, because the gate is `isTransitousAllowed`
      // (services/transitousAvailability.ts) — transitous is third-party egress
      // AND sits above the remote-residency ceiling, and the operator hop does
      // not exempt it from either.
      policyAxes: ["routingAdapter", "m10ThirdPartyEnabled"],
      settingKeys: ["searchProvider"],
    },
    retention: {
      device: "none",
      operator: "operator-manifest",
      provider: "provider-policy",
    },
    providerKind: "routing",
    inactiveStatus: "not-shared",
  },
  {
    id: "operator.remote-routing",
    nameKey: "privacy.flow.operator.remoteRouting.name",
    purposeKey: "privacy.flow.operator.remoteRouting.purpose",
    destination: "operator",
    networkPath: "operator",
    trigger: "standing-choice",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      {
        category: "trip-endpoints",
        precision: "exact-coordinate",
        recipient: "operator",
      },
      { category: "trip-time", precision: "standard", recipient: "operator" },
      {
        category: "routing-requirement",
        precision: "enumerated",
        recipient: "operator",
      },
    ],
    requestFields: [
      "from",
      "to",
      "departAt",
      "arriveBy",
      "routingRequirements",
    ],
    controls: {
      policyAxes: ["routingAdapter"],
      settingKeys: ["routingMode"],
    },
    retention: {
      device: "none",
      operator: "operator-manifest",
      provider: "none",
    },
    providerKind: "routing",
    inactiveStatus: "not-shared",
  },
  {
    id: "external.remote-routing",
    nameKey: "privacy.flow.external.remoteRouting.name",
    purposeKey: "privacy.flow.external.remoteRouting.purpose",
    destination: "external",
    networkPath: "operator-proxied-external",
    trigger: "standing-choice",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      {
        category: "trip-endpoints",
        precision: "exact-coordinate",
        recipient: "operator-and-provider",
      },
      {
        category: "trip-time",
        precision: "standard",
        recipient: "operator-and-provider",
      },
      {
        category: "routing-requirement",
        precision: "enumerated",
        recipient: "operator-and-provider",
      },
    ],
    requestFields: [
      "from",
      "to",
      "departAt",
      "arriveBy",
      "routingRequirements",
    ],
    controls: {
      policyAxes: ["routingAdapter", "m10ThirdPartyEnabled"],
      settingKeys: ["routingMode", "routingProvider"],
    },
    retention: {
      device: "none",
      operator: "operator-manifest",
      provider: "provider-policy",
    },
    providerKind: "routing",
    inactiveStatus: "not-shared",
  },
  {
    id: "operator.client-report",
    nameKey: "privacy.flow.operator.clientReport.name",
    purposeKey: "privacy.flow.operator.clientReport.purpose",
    destination: "operator",
    networkPath: "operator",
    trigger: "explicit-action",
    data: [
      ...OPERATOR_NETWORK_METADATA,
      { category: "diagnostic", precision: "enumerated", recipient: "operator" },
    ],
    requestFields: ["reportKind", "appVersion"],
    controls: { policyAxes: ["errorReporting"], settingKeys: [] },
    retention: {
      device: "effective-policy",
      operator: "operator-manifest",
      provider: "none",
    },
    inactiveStatus: "not-shared",
  },
  {
    // Live bike-share stations (GBFS), fetched straight from the city's
    // bike-share operator. Not a stored decision: the Bikes button on the map
    // turns it on for the current visit only, and nothing is requested until
    // it is pressed. The requests name the operator's public feeds; the
    // viewer's position is never sent.
    id: "external.bike-share",
    nameKey: "privacy.flow.external.bikeShare.name",
    purposeKey: "privacy.flow.external.bikeShare.purpose",
    destination: "external",
    networkPath: "direct-external",
    trigger: "explicit-action",
    data: [
      ...PROVIDER_NETWORK_METADATA,
      {
        category: "transit-resource",
        precision: "public-id",
        recipient: "provider",
      },
    ],
    requestFields: ["resource"],
    controls: { policyAxes: [], settingKeys: [] },
    retention: {
      device: "none",
      operator: "none",
      provider: "provider-policy",
    },
    providerKind: "bike-share",
    inactiveStatus: "not-shared",
  },
];

export function validateDataFlowRegistry(
  flows: readonly PrivacyDataFlowDescriptor[],
): void {
  const ids = new Set<string>();
  for (const flow of flows) {
    if (ids.has(flow.id)) {
      throw new Error(`Privacy data-flow registry has duplicate ID ${flow.id}`);
    }
    ids.add(flow.id);
    if (!flow.nameKey) throw new Error(`Flow ${flow.id} has no nameKey`);
    if (!flow.purposeKey) throw new Error(`Flow ${flow.id} has no purposeKey`);

    const fields = new Set<string>();
    for (const field of flow.requestFields) {
      if (fields.has(field)) {
        throw new Error(`Flow ${flow.id} declares request field ${field} twice`);
      }
      fields.add(field);
    }
    for (const axis of flow.controls.policyAxes) {
      if (!(axis in AXIS_STRICTNESS_ORDER)) {
        throw new Error(`Flow ${flow.id} references unknown policy axis ${axis}`);
      }
    }
    if (flow.destination === "external" && !flow.providerKind) {
      throw new Error(`External flow ${flow.id} has no providerKind`);
    }
    if (
      flow.destination === "external" &&
      flow.networkPath !== "direct-external" &&
      flow.networkPath !== "operator-proxied-external"
    ) {
      throw new Error(`External flow ${flow.id} has invalid networkPath`);
    }
  }
}

function freezeFlow(
  flow: PrivacyDataFlowDescriptor,
): Readonly<PrivacyDataFlowDescriptor> {
  const data = Object.freeze(flow.data.map((item) => Object.freeze({ ...item })));
  const requestFields = Object.freeze([...flow.requestFields]);
  const controls = Object.freeze({
    ...flow.controls,
    policyAxes: Object.freeze([...flow.controls.policyAxes]),
    settingKeys: Object.freeze([...flow.controls.settingKeys]),
  });
  const retention = Object.freeze({ ...flow.retention });
  return Object.freeze({
    ...flow,
    data,
    requestFields,
    controls,
    retention,
  });
}

validateDataFlowRegistry(RAW_DATA_FLOW_REGISTRY);

export const DATA_FLOW_REGISTRY: readonly Readonly<PrivacyDataFlowDescriptor>[] =
  Object.freeze(RAW_DATA_FLOW_REGISTRY.map(freezeFlow));

const DATA_FLOW_BY_ID = new Map(
  DATA_FLOW_REGISTRY.map((flow) => [flow.id, flow] as const),
);

export function getDataFlow(
  id: PrivacyDataFlowId,
): Readonly<PrivacyDataFlowDescriptor> {
  const flow = DATA_FLOW_BY_ID.get(id);
  if (!flow) throw new Error(`Privacy data flow ${id} is not registered`);
  return flow;
}

export function assertDeclaredRequestFields(
  flowId: PrivacyDataFlowId,
  request: Readonly<Record<string, unknown>>,
): void {
  const allowed = new Set<string>(getDataFlow(flowId).requestFields);
  for (const field of Object.keys(request)) {
    if (!allowed.has(field)) {
      throw new Error(`Request field ${field} is not declared for flow ${flowId}`);
    }
  }
}

export function validateProviderFlowDeclarations(
  providers: readonly ProviderFlowDeclaration[],
): void {
  for (const provider of providers) {
    const flow = DATA_FLOW_BY_ID.get(provider.flowId);
    if (!flow) {
      throw new Error(
        `Provider ${provider.id} flow ${provider.flowId} is not registered`,
      );
    }
    if (flow.destination !== "external") {
      throw new Error(
        `Provider ${provider.id} must reference an external privacy flow`,
      );
    }
    const allowed = new Set<PrivacyRequestField>(flow.requestFields);
    for (const field of provider.requestFields) {
      if (!allowed.has(field)) {
        throw new Error(
          `Provider ${provider.id} field ${field} is not declared for flow ${flow.id}`,
        );
      }
    }
  }
}
