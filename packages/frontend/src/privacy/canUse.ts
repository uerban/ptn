/**
 * The network capability resolver.
 *
 *   canUse(flowId, providerId?) =
 *     hard constraints pass AND (flow is necessary OR decision is `allowed`)
 *
 * `unset` means off until asked. Resolution never consults a setup preset,
 * the protection level or a legacy policy axis: presets only write decisions
 * and the level when they are applied. Call it at the request boundary and
 * again before applying a response, so a revocation (also from another tab)
 * stops late results.
 */
import {
  isNecessaryFlow,
  resolveNetworkDecision,
  type CapabilityFlowId,
  type ResolvedNetworkDecision,
} from "@pt/shared/privacy";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { hardConstraintsPass, isKnownFlow } from "./capabilityRegistry.ts";

export function getNetworkDecision(
  flowId: CapabilityFlowId | string,
  providerId?: string,
): ResolvedNetworkDecision {
  return resolveNetworkDecision(
    useNetworkDecisionsStore.getState().decisions,
    flowId,
    providerId,
  );
}

export function canUse(
  flowId: CapabilityFlowId | string,
  providerId?: string,
): boolean {
  if (!isKnownFlow(flowId)) return false;
  if (!hardConstraintsPass(flowId, providerId)) return false;
  if (isNecessaryFlow(flowId)) return true;
  return getNetworkDecision(flowId, providerId).value === "allowed";
}

/** React binding: re-renders when the decision for this flow changes. */
export function useCanUse(
  flowId: CapabilityFlowId | string,
  providerId?: string,
): boolean {
  // Subscribe to the decision map so revocations re-render; resolve through
  // canUse so hooks and request paths can never disagree.
  useNetworkDecisionsStore((state) => state.decisions);
  return canUse(flowId, providerId);
}
