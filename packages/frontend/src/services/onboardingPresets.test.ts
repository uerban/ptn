import { beforeEach, describe, expect, it } from "vitest";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";
import { currentPresetMatch, describePreset } from "./onboardingPresets.ts";

beforeEach(() => {
  localStorage.clear();
  useNetworkDecisionsStore.getState().reset();
  usePrivacyStore.getState().reset();
});

describe("onboardingPresets", () => {
  it("describes the flows each preset turns on from the shared registry", () => {
    const recommended = describePreset("recommended");
    expect(recommended.level).toBe("standard");
    expect(recommended.allowedFlows.map((f) => f.flowId)).toEqual([
      "operator.realtime",
      "operator.service-alerts",
    ]);
    expect(recommended.allowedFlows[0]?.dataFlow?.nameKey).toBe(
      "privacy.flow.operator.realtime.name",
    );
    expect(describePreset("strict")).toEqual({ id: "strict", level: "strict", allowedFlows: [] });
    expect(describePreset("customize", "ask-first").allowedFlows).toEqual([]);
  });

  it("reports custom when level and decisions match neither shortcut", async () => {
    expect(currentPresetMatch()).toBe("custom");
    await usePrivacyStore.getState().setLevel("strict");
    expect(currentPresetMatch()).toBe("strict");
    useNetworkDecisionsStore.getState().setDecision("operator.realtime", "allowed", "contextual");
    expect(currentPresetMatch()).toBe("custom");
  });
});
