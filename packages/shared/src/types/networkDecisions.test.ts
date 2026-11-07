import { describe, expect, it } from "vitest";
import {
  effectivePolicy,
  isProtectionAxis,
  LEGACY_NETWORK_FLOORS_V1,
  legacyEffectiveNetworkPolicy,
  LEVEL_FLOORS,
  NETWORK_POLICY_AXES,
  PRIVACY_LEVELS,
} from "./privacy.js";
import {
  decisionKey,
  matchOnboardingPreset,
  ONBOARDING_PRESETS,
  presetDecisions,
  resolveNetworkDecision,
  sanitizeNetworkDecisions,
  type NetworkDecisionMap,
} from "./networkDecisions.js";

describe("protection level without network axes", () => {
  it("level floors carry no network axis", () => {
    for (const level of PRIVACY_LEVELS) {
      for (const axis of NETWORK_POLICY_AXES) {
        expect(Object.hasOwn(LEVEL_FLOORS[level], axis)).toBe(false);
      }
    }
    expect(isProtectionAxis("realTimePolling")).toBe(false);
    expect(isProtectionAxis("m11TileDefense")).toBe(true);
  });

  it("reserves the decoy timer for paranoid", () => {
    expect(LEVEL_FLOORS.strict.m11TileDefense).toBe("prefetch-padding");
    expect(LEVEL_FLOORS.hardened.m11TileDefense).toBe("prefetch-padding");
    expect(LEVEL_FLOORS.paranoid.m11TileDefense).toBe("prefetch-padding-decoy");
  });

  it("keeps the override ratchet for protection axes and ignores network overrides", () => {
    const policy = effectivePolicy("standard", {
      m11TileDefense: "prefetch-padding-decoy",
      realTimePolling: "disabled-schedule-only",
    });
    expect(policy.m11TileDefense).toBe("prefetch-padding-decoy");
    expect(Object.hasOwn(policy, "realTimePolling")).toBe(false);
    expect(effectivePolicy("strict", { urlShare: "coords-raw" }).urlShare).toBe(
      "coords-stripped",
    );
  });
});

describe("LEGACY_NETWORK_FLOORS_V1", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(LEGACY_NETWORK_FLOORS_V1)).toBe(true);
    expect(Object.isFrozen(LEGACY_NETWORK_FLOORS_V1.standard)).toBe(true);
  });

  it("records the network floors that previously applied", () => {
    expect(LEGACY_NETWORK_FLOORS_V1.standard.realTimePolling).toBe("backend-adaptive");
    expect(LEGACY_NETWORK_FLOORS_V1.hardened.basemapMode).toBe("local-only");
    expect(LEGACY_NETWORK_FLOORS_V1.strict.realTimePolling).toBe(
      "disabled-schedule-only",
    );
    expect(LEGACY_NETWORK_FLOORS_V1.standard.nearbyStopLookup).toBe("centroid-server");
  });

  it("applies stored overrides only when they tighten", () => {
    const tightened = legacyEffectiveNetworkPolicy("standard", {
      realTimePolling: "disabled-schedule-only",
      basemapMode: "bogus",
    });
    expect(tightened.realTimePolling).toBe("disabled-schedule-only");
    expect(tightened.basemapMode).toBe("external-detailed");
    const loosened = legacyEffectiveNetworkPolicy("strict", {
      realTimePolling: "backend-adaptive",
    });
    expect(loosened.realTimePolling).toBe("disabled-schedule-only");
    expect(legacyEffectiveNetworkPolicy("baseline", null)).toEqual(
      LEGACY_NETWORK_FLOORS_V1.baseline,
    );
  });

  it("the protection policy carries no network axis", () => {
    for (const level of PRIVACY_LEVELS) {
      const policy = effectivePolicy(level, { basemapMode: "local-only" });
      for (const axis of NETWORK_POLICY_AXES) expect(policy).not.toHaveProperty(axis);
    }
  });
});

describe("network decisions", () => {
  it("keys provider-scoped flows per provider", () => {
    expect(decisionKey("operator.realtime")).toBe("operator.realtime");
    expect(decisionKey("operator.realtime", "x")).toBe("operator.realtime");
    expect(decisionKey("external.detailed-basemap")).toBeUndefined();
    expect(decisionKey("external.detailed-basemap", "carto")).toBe(
      "external.detailed-basemap@carto",
    );
    expect(decisionKey("external.detailed-basemap", "Bad Id")).toBeUndefined();
    expect(decisionKey("operator.transit-data")).toBeUndefined();
    expect(decisionKey("made.up")).toBeUndefined();
  });

  it("sanitizes untrusted stored decisions", () => {
    const sanitized = sanitizeNetworkDecisions({
      "operator.realtime": { value: "allowed", source: "setup", decidedAt: 5 },
      "operator.service-alerts": { value: "unset", source: "setup" },
      "external.detailed-basemap": { value: "allowed", source: "setup" },
      "external.detailed-basemap@carto": { value: "denied", source: "legacy" },
      "operator.place-search": { value: "allowed", source: "preset" },
      "made.up": { value: "allowed", source: "setup" },
      "operator.realtime@x": { value: "allowed", source: "setup" },
    });
    expect(sanitized).toEqual({
      "operator.realtime": { value: "allowed", source: "setup", decidedAt: 5 },
      "external.detailed-basemap@carto": { value: "denied", source: "legacy" },
    });
    expect(sanitizeNetworkDecisions("nope")).toEqual({});
    expect(sanitizeNetworkDecisions([1])).toEqual({});
  });

  it("resolves unknown flows and missing decisions as unset", () => {
    const decisions: NetworkDecisionMap = {
      "operator.realtime": { value: "denied", source: "contextual" },
    };
    expect(resolveNetworkDecision(decisions, "operator.realtime")).toEqual({
      value: "denied",
      source: "contextual",
    });
    expect(resolveNetworkDecision(decisions, "operator.service-alerts").value).toBe(
      "unset",
    );
    expect(resolveNetworkDecision(decisions, "who.knows").value).toBe("unset");
  });
});

describe("onboarding presets", () => {
  it("recommended applies standard with live departures and alerts", () => {
    expect(ONBOARDING_PRESETS.recommended.level).toBe("standard");
    expect(presetDecisions("recommended")).toEqual({
      "operator.realtime": "allowed",
      "operator.service-alerts": "allowed",
    });
  });

  it("strict applies strict and leaves every flow unset", () => {
    expect(ONBOARDING_PRESETS.strict.level).toBe("strict");
    expect(presetDecisions("strict")).toEqual({});
  });

  it("customize applies standard and writes only its guided answer", () => {
    expect(ONBOARDING_PRESETS.customize.level).toBe("standard");
    expect(presetDecisions("customize")).toEqual({});
    expect(presetDecisions("customize", "ask-first")).toEqual({});
    expect(presetDecisions("customize", "live-information")).toEqual({
      "operator.realtime": "allowed",
      "operator.service-alerts": "allowed",
    });
  });

  it("names the matching preset or reports custom", () => {
    const recommended: NetworkDecisionMap = {
      "operator.realtime": { value: "allowed", source: "setup" },
      "operator.service-alerts": { value: "allowed", source: "setup" },
    };
    expect(matchOnboardingPreset("standard", recommended)).toBe("recommended");
    expect(matchOnboardingPreset("strict", {})).toBe("strict");
    expect(matchOnboardingPreset("standard", {})).toBe("custom");
    expect(matchOnboardingPreset("hardened", recommended)).toBe("custom");
    expect(
      matchOnboardingPreset("standard", {
        ...recommended,
        "operator.place-search": { value: "allowed", source: "contextual" },
      }),
    ).toBe("custom");
  });
});
