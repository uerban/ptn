/**
 * Contextual network prompts: Allow / Not now / Don't ask again.
 *
 * - **Allow** records `allowed` (source `contextual`) for exactly one flow and
 *   provider.
 * - **Not now** records nothing: the flow stays `unset`. This session, the
 *   surface that asked shows no unsolicited hint for it again; a later
 *   deliberate action still opens the prompt.
 * - **Don't ask again** records `denied`. That silences unsolicited hints
 *   only: a deliberate action (pressing **More map detail**, **Show live
 *   times**) still opens the disclosure, offering **Allow**.
 *
 * Nothing here touches the protection level, storage choices or presentation
 * settings.
 */
import { decisionKey, type CapabilityFlowId } from "@pt/shared/privacy";
import { useNetworkDecisionsStore } from "../stores/networkDecisionsStore.ts";
import { getNetworkDecision } from "./canUse.ts";
import { grantFlow } from "./flowGrants.ts";

export type ContextualAnswer = "allowed" | "not-now" | "denied";

/** `flow|surface` pairs answered **Not now** in this page session. */
const notNowThisSession = new Set<string>();

function sessionKey(flowId: string, surface: string, providerId?: string): string {
  return `${decisionKey(flowId, providerId) ?? flowId}|${surface}`;
}

/** Apply one answer. Returns whether the flow may now be used. */
export function answerContextualPrompt(
  answer: ContextualAnswer,
  flowId: CapabilityFlowId | string,
  surface: string,
  providerId?: string,
): boolean {
  switch (answer) {
    case "allowed":
      return grantFlow(flowId, "contextual", providerId);
    case "denied":
      useNetworkDecisionsStore
        .getState()
        .setDecision(flowId, "denied", "contextual", providerId);
      return false;
    case "not-now":
      notNowThisSession.add(sessionKey(flowId, surface, providerId));
      return false;
  }
}

/**
 * Whether a surface may show an unsolicited hint or offer for a flow: only
 * while the decision is `unset` and this surface was not told **Not now**
 * this session.
 */
export function mayOfferUnprompted(
  flowId: CapabilityFlowId | string,
  surface: string,
  providerId?: string,
): boolean {
  if (getNetworkDecision(flowId, providerId).value !== "unset") return false;
  return !notNowThisSession.has(sessionKey(flowId, surface, providerId));
}

/** Test-only: forget this session's **Not now** answers. */
export function __resetContextualPromptsForTests(): void {
  notNowThisSession.clear();
}
