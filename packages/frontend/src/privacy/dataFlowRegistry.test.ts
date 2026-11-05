import { describe, expect, it } from "vitest";
import type {
  PrivacyDataFlowDescriptor,
  ProviderFlowDeclaration,
} from "@pt/shared";
import { GEOCODER_PROVIDERS } from "../config/geocoderProviders.ts";
import { ROUTING_PROVIDERS } from "../config/routingProviders.ts";
import { BASEMAP_PROVIDERS } from "../config/basemapProviders.ts";
import enPrivacy from "../i18n/privacy.json";
import {
  DATA_FLOW_REGISTRY,
  assertDeclaredRequestFields,
  getDataFlow,
  validateDataFlowRegistry,
  validateProviderFlowDeclarations,
} from "./dataFlowRegistry.ts";

describe("dataFlowRegistry", () => {
  it("registers every PR 1 governed network flow exactly once", () => {
    expect(DATA_FLOW_REGISTRY.map((flow) => flow.id)).toEqual([
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
    ]);
    expect(() => validateDataFlowRegistry(DATA_FLOW_REGISTRY)).not.toThrow();
  });

  it("rejects duplicate flow IDs", () => {
    const flow = DATA_FLOW_REGISTRY[0];
    expect(() => validateDataFlowRegistry([flow, flow])).toThrow(/duplicate/i);
  });

  it("has English localized name and purpose copy for every flow", () => {
    for (const flow of DATA_FLOW_REGISTRY) {
      expect(enPrivacy).toHaveProperty(flow.nameKey);
      expect(enPrivacy).toHaveProperty(flow.purposeKey);
    }
  });

  it("keeps inactive-flow status in the public contract vocabulary", () => {
    expect(getDataFlow("external.detailed-basemap").inactiveStatus).toBe(
      "not-shared",
    );
  });

  it("distinguishes direct provider IP exposure from operator-proxied routing", () => {
    const basemap = getDataFlow("external.detailed-basemap");
    expect(basemap.networkPath).toBe("direct-external");
    expect(
      basemap.data.find((item) => item.category === "network-address")
        ?.recipient,
    ).toBe("provider");

    const transitous = getDataFlow("external.remote-routing");
    expect(transitous.networkPath).toBe("operator-proxied-external");
    expect(
      transitous.data.find((item) => item.category === "network-address")
        ?.recipient,
    ).toBe("operator");
    expect(
      transitous.data.find((item) => item.category === "trip-endpoints")
        ?.recipient,
    ).toBe("operator-and-provider");
  });

  it("declares remote stop search as operator-proxied third-party egress", () => {
    // Regression guard for a real gap: `searchProvider: "remote"` reaches
    // transitous, but before this flow existed the only descriptor naming that
    // setting was `operator.place-search`, which declares the query as reaching
    // the operator and nothing further (`retention.provider: "none"`). The
    // onward hop was undisclosed.
    const flow = getDataFlow("external.stop-search");
    expect(flow.networkPath).toBe("operator-proxied-external");
    expect(flow.controls.settingKeys).toContain("searchProvider");
    expect(flow.controls.policyAxes).toContain("m10ThirdPartyEnabled");
    expect(flow.retention.provider).toBe("provider-policy");
    // The query reaches the provider; the network address stops at the operator
    // — that asymmetry is the whole point of proxying, and matches how
    // `external.remote-routing` models the identical upstream.
    expect(
      flow.data.find((item) => item.category === "search-query")?.recipient,
    ).toBe("operator-and-provider");
    expect(
      flow.data.find((item) => item.category === "network-address")?.recipient,
    ).toBe("operator");
  });

  it("keeps operator.place-search free of any onward provider hop", () => {
    // The operator geocoder terminates at the operator. If this ever gains a
    // provider recipient, it needs its own external flow like stop search did.
    const flow = getDataFlow("operator.place-search");
    expect(flow.networkPath).toBe("operator");
    expect(flow.retention.provider).toBe("none");
    expect(flow.data.every((item) => item.recipient === "operator")).toBe(true);
  });

  it("rejects undeclared request fields such as mobilityProfile", () => {
    expect(() =>
      assertDeclaredRequestFields("external.remote-routing", {
        from: { lat: 1, lon: 2 },
        to: { lat: 3, lon: 4 },
        departAt: "2026-07-13T12:00:00Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertDeclaredRequestFields("external.remote-routing", {
        from: { lat: 1, lon: 2 },
        to: { lat: 3, lon: 4 },
        departAt: "2026-07-13T12:00:00Z",
        mobilityProfile: "wheelchair",
      }),
    ).toThrow(/mobilityProfile.*not declared/i);
  });

  it("rejects providers whose flow is missing or whose fields exceed the flow", () => {
    const valid: ProviderFlowDeclaration = {
      id: "test-router",
      flowId: "external.remote-routing",
      requestFields: ["from", "to", "departAt"],
    };
    expect(() => validateProviderFlowDeclarations([valid])).not.toThrow();

    expect(() =>
      validateProviderFlowDeclarations([
        {
          ...valid,
          flowId: "missing.flow",
        } as unknown as ProviderFlowDeclaration,
      ]),
    ).toThrow(/missing\.flow.*not registered/i);

    expect(() =>
      validateProviderFlowDeclarations([
        {
          ...valid,
          requestFields: ["from", "to", "mobilityProfile"],
        } as unknown as ProviderFlowDeclaration,
      ]),
    ).toThrow(/mobilityProfile.*not declared/i);
  });

  it("all curated geocoder and routing providers match registered external flows", () => {
    const providers: ProviderFlowDeclaration[] = [
      ...Object.values(BASEMAP_PROVIDERS),
      ...Object.values(GEOCODER_PROVIDERS),
      ...Object.values(ROUTING_PROVIDERS),
    ];
    expect(() => validateProviderFlowDeclarations(providers)).not.toThrow();
  });

  it("freezes the registry and its descriptors", () => {
    expect(Object.isFrozen(DATA_FLOW_REGISTRY)).toBe(true);
    for (const flow of DATA_FLOW_REGISTRY) {
      expect(Object.isFrozen(flow)).toBe(true);
      expect(Object.isFrozen(flow.requestFields)).toBe(true);
      expect(Object.isFrozen(flow.data)).toBe(true);
    }
  });

  it("the descriptor validator rejects empty localized keys", () => {
    const invalid = {
      ...DATA_FLOW_REGISTRY[0],
      nameKey: "",
    } as PrivacyDataFlowDescriptor;
    expect(() => validateDataFlowRegistry([invalid])).toThrow(/nameKey/i);
  });
});
