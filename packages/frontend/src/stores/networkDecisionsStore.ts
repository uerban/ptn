import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createTolerantJSONStorage } from "../services/tolerantLocalStorage.ts";
import {
  decisionKey,
  NETWORK_DECISIONS_SCHEMA_VERSION,
  sanitizeNetworkDecisions,
  type NetworkDecision,
  type NetworkDecisionMap,
  type NetworkDecisionSource,
  type NetworkDecisionValue,
} from "@pt/shared/privacy";

export const NETWORK_DECISIONS_STORAGE_KEY = "ptn-network-decisions";

interface NetworkDecisionsState {
  decisions: NetworkDecisionMap;
  /**
   * Record one decision for exactly one flow (and provider, for
   * provider-scoped flows). `unset` removes the decision. Returns false when
   * the flow/provider pair cannot hold a decision.
   */
  setDecision: (
    flowId: string,
    value: NetworkDecisionValue,
    source: NetworkDecisionSource,
    providerId?: string,
  ) => boolean;
  /** Replace every decision with an already-keyed set (setup journal). A
   * flow the set does not list goes back to "ask first", so committing a
   * preset never leaves an earlier grant in place. */
  replaceDecisions: (decisions: NetworkDecisionMap) => void;
  reset: () => void;
}

/**
 * Optional network decisions keyed by data flow. Kept separate from the
 * protection level (`privacyStore`) and from storage choices
 * (`privacyChoicesStore`): writing a decision never touches either.
 * Persisted state is untrusted and re-sanitized on every hydration; callers
 * resolve through `canUse`, which re-reads the store at call time.
 */
export const useNetworkDecisionsStore = create<NetworkDecisionsState>()(
  persist(
    (set) => ({
      decisions: {},
      setDecision: (flowId, value, source, providerId) => {
        const key = decisionKey(flowId, providerId);
        if (!key) return false;
        set((state) => {
          const next: Record<string, NetworkDecision> = { ...state.decisions };
          if (value === "unset") {
            delete next[key];
          } else {
            next[key] = { value, source, decidedAt: Date.now() };
          }
          return { decisions: next };
        });
        return true;
      },
      replaceDecisions: (decisions) =>
        set({ decisions: sanitizeNetworkDecisions(decisions) }),
      reset: () => set({ decisions: {} }),
    }),
    {
      name: NETWORK_DECISIONS_STORAGE_KEY,
      storage: createTolerantJSONStorage(),
      version: NETWORK_DECISIONS_SCHEMA_VERSION,
      partialize: (state) => ({ decisions: state.decisions }),
      migrate: (persisted) => {
        const stored = persisted as Partial<NetworkDecisionsState> | undefined;
        return { decisions: sanitizeNetworkDecisions(stored?.decisions) };
      },
      merge: (persisted, current) => {
        const stored = persisted as Partial<NetworkDecisionsState> | undefined;
        return {
          ...current,
          decisions: sanitizeNetworkDecisions(stored?.decisions),
        };
      },
    },
  ),
);
