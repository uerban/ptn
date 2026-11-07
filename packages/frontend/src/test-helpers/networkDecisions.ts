/**
 * Seed per-flow network decisions in unit tests. Optional flows are off until
 * a decision allows them, so suites that exercise a request path record the
 * decision the way a user would, instead of picking a protection level.
 */
import type { NetworkDecisionValue } from "@pt/shared/privacy";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";

export function decideFlow(
  flowId: string,
  value: NetworkDecisionValue,
  providerId?: string,
): void {
  useNetworkDecisionsStore.getState().setDecision(flowId, value, "settings", providerId);
}

export function allowFlow(flowId: string, providerId?: string): void {
  decideFlow(flowId, "allowed", providerId);
}

export function denyFlow(flowId: string, providerId?: string): void {
  decideFlow(flowId, "denied", providerId);
}

export function resetFlows(): void {
  useNetworkDecisionsStore.getState().reset();
}
