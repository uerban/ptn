/**
 * Deliberate grants for network flows.
 *
 * A request path never decides on its own that a flow may run: it asks
 * `canUse`. What turns a flow on is a recorded decision, and outside setup the
 * only thing that may record `allowed` is a deliberate user action naming that
 * flow (a Settings choice, an explicit "search on the server" button, ...).
 * These helpers are that write, kept in one place so every surface records
 * exactly one flow (and provider) and never touches the protection level,
 * storage choices or presentation settings.
 */
import type {
  CapabilityFlowId,
  NetworkDecisionSource,
} from "@pt/shared/privacy";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { getNetworkDecision } from "./canUse.ts";
import { getCapability, hardConstraintsPass } from "./capabilityRegistry.ts";

/** Sources a deliberate action may record. Setup and the legacy migration
 * write their own decisions through the setup journal. */
export type GrantSource = Extract<NetworkDecisionSource, "contextual" | "settings">;

/**
 * Whether a flow could run once granted: it is a known capability and every
 * hard constraint (provider shipped, city availability, ...) holds. Surfaces
 * use it to decide whether to offer an action at all; it says nothing about
 * the decision.
 */
export function isFlowAvailable(
  flowId: CapabilityFlowId | string,
  providerId?: string,
): boolean {
  return getCapability(flowId) !== undefined && hardConstraintsPass(flowId, providerId);
}

/**
 * Record `allowed` for exactly one flow (and provider) after a deliberate
 * action. Returns whether the flow is now usable. A flow that is already
 * allowed keeps its recorded source; a flow whose hard constraints fail is
 * left untouched.
 */
export function grantFlow(
  flowId: CapabilityFlowId | string,
  source: GrantSource,
  providerId?: string,
): boolean {
  const capability = getCapability(flowId);
  if (!capability || !hardConstraintsPass(flowId, providerId)) return false;
  if (capability.necessary) return true;
  if (getNetworkDecision(flowId, providerId).value === "allowed") return true;
  return useNetworkDecisionsStore
    .getState()
    .setDecision(flowId, "allowed", source, providerId);
}
