/**
 * Setup presets as the app presents them. The definitions (level plus
 * decisions) are shared in `@pt/shared/privacy`; this module joins them with
 * the capability registry so setup, confirmations and Settings describe the
 * same flows from the same data-flow descriptions.
 */
import {
  matchOnboardingPreset,
  ONBOARDING_PRESETS,
  presetDecisions,
  type GuidedNetworkChoice,
  type NetworkDecisionFlowId,
  type OnboardingPresetId,
  type PrivacyLevel,
} from "@pt/shared/privacy";
import { getCapability, type CapabilityDescriptor } from "../privacy/capabilityRegistry.ts";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { getCurrentLevel } from "../stores/privacyStore.ts";

export interface PresetSummary {
  readonly id: OnboardingPresetId;
  readonly level: PrivacyLevel;
  /** Flows the preset turns on, with their shared descriptions. */
  readonly allowedFlows: readonly Readonly<CapabilityDescriptor>[];
}

export function describePreset(
  id: OnboardingPresetId,
  guidedChoice?: GuidedNetworkChoice,
): PresetSummary {
  const allowedFlows = Object.entries(presetDecisions(id, guidedChoice))
    .filter(([, value]) => value === "allowed")
    .map(([flowId]) => getCapability(flowId as NetworkDecisionFlowId))
    .filter((capability): capability is Readonly<CapabilityDescriptor> => !!capability);
  return { id, level: ONBOARDING_PRESETS[id].level, allowedFlows };
}

/** Which preset the current level and decisions amount to (`custom` when
 * they match neither shortcut). */
export function currentPresetMatch(): "recommended" | "strict" | "custom" {
  return matchOnboardingPreset(
    getCurrentLevel(),
    useNetworkDecisionsStore.getState().decisions,
  );
}
