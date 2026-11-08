import { beforeEach, describe, expect, it } from "vitest";
import { NETWORK_DECISION_FLOW_IDS } from "@pt/shared/privacy";
import {
  NETWORK_DECISIONS_STORAGE_KEY,
  useNetworkDecisionsStore,
} from "../stores/networkDecisionsStore.ts";
import { getCurrentLevel, usePrivacyStore } from "../stores/privacyStore.ts";
import { installPrivacyStateSync } from "../stores/onboardingStore.ts";
import { canUse, getNetworkDecision } from "./canUse.ts";

const decide = useNetworkDecisionsStore.getState;

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  usePrivacyStore.getState().reset();
});

describe("canUse", () => {
  it("allows necessary flows without a decision", () => {
    expect(canUse("operator.transit-data")).toBe(true);
  });

  it("treats every optional flow as off until it is allowed", () => {
    for (const flowId of NETWORK_DECISION_FLOW_IDS) {
      expect(canUse(flowId, "carto")).toBe(false);
    }
  });

  it("rejects unknown flows", () => {
    expect(canUse("operator.everything")).toBe(false);
    expect(getNetworkDecision("operator.everything").value).toBe("unset");
  });

  it("does not consult the protection level", async () => {
    await usePrivacyStore.getState().setLevel("baseline");
    expect(canUse("operator.realtime")).toBe(false);
    decide().setDecision("operator.realtime", "allowed", "contextual");
    await usePrivacyStore.getState().setLevel("paranoid");
    expect(canUse("operator.realtime")).toBe(true);
  });

  it("grants exactly one flow even where flows once shared a policy axis", () => {
    // m10ThirdPartyEnabled once gated external place search, external stop
    // search and external routing together.
    decide().setDecision("external.place-search", "allowed", "contextual", "nominatim");
    expect(canUse("external.place-search", "nominatim")).toBe(true);
    expect(canUse("external.stop-search")).toBe(false);
    expect(canUse("external.remote-routing", "transitous")).toBe(false);

    // routingAdapter once gated operator and external routing together.
    decide().setDecision("operator.remote-routing", "allowed", "contextual");
    expect(canUse("operator.remote-routing")).toBe(true);
    expect(canUse("external.remote-routing", "transitous")).toBe(false);

    // basemapMode once covered every basemap provider.
    decide().setDecision("operator.realtime", "allowed", "contextual");
    expect(canUse("external.detailed-basemap", "carto")).toBe(false);
  });

  it("scopes provider flows to the granted provider", () => {
    decide().setDecision("external.place-search", "allowed", "settings", "nominatim");
    expect(canUse("external.place-search", "nominatim")).toBe(true);
    expect(canUse("external.place-search", "photon")).toBe(false);
    expect(canUse("external.place-search")).toBe(false);
  });

  it("requires a configured provider for provider flows", () => {
    expect(
      decide().setDecision("external.detailed-basemap", "allowed", "settings", "unknownmaps"),
    ).toBe(true);
    expect(canUse("external.detailed-basemap", "unknownmaps")).toBe(false);
    expect(decide().setDecision("external.detailed-basemap", "allowed", "settings")).toBe(
      false,
    );
  });

  it("revocation takes effect immediately and leaves other flows alone", () => {
    decide().setDecision("operator.realtime", "allowed", "setup");
    decide().setDecision("operator.service-alerts", "allowed", "setup");
    decide().setDecision("operator.realtime", "denied", "settings");
    expect(canUse("operator.realtime")).toBe(false);
    expect(canUse("operator.service-alerts")).toBe(true);
    expect(getNetworkDecision("operator.realtime")).toEqual({
      value: "denied",
      source: "settings",
    });
    decide().setDecision("operator.realtime", "unset", "settings");
    expect(getNetworkDecision("operator.realtime").value).toBe("unset");
  });

  it("never changes the protection level or storage choices", () => {
    const before = usePrivacyStore.getState();
    decide().setDecision("operator.realtime", "allowed", "contextual");
    expect(getCurrentLevel()).toBe(before.level);
    expect(usePrivacyStore.getState().overrides).toBe(before.overrides);
  });
});

describe("cross-tab decision sync", () => {
  it("picks up a revocation written by another tab", async () => {
    decide().setDecision("operator.realtime", "allowed", "setup");
    const stop = installPrivacyStateSync();
    try {
      // Another tab revokes: it rewrites storage and fires `storage` here.
      localStorage.setItem(
        NETWORK_DECISIONS_STORAGE_KEY,
        JSON.stringify({
          state: {
            decisions: { "operator.realtime": { value: "denied", source: "settings" } },
          },
          version: 1,
        }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: NETWORK_DECISIONS_STORAGE_KEY }),
      );
      await Promise.resolve();
      expect(canUse("operator.realtime")).toBe(false);
    } finally {
      stop();
    }
  });

  it("drops tampered decisions when rehydrating", async () => {
    localStorage.setItem(
      NETWORK_DECISIONS_STORAGE_KEY,
      JSON.stringify({
        state: {
          decisions: {
            "operator.realtime": { value: "always", source: "setup" },
            "operator.transit-data": { value: "denied", source: "setup" },
          },
        },
        version: 1,
      }),
    );
    await useNetworkDecisionsStore.persist.rehydrate();
    expect(useNetworkDecisionsStore.getState().decisions).toEqual({});
    expect(canUse("operator.transit-data")).toBe(true);
  });
});
