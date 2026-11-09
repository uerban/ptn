import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createTolerantJSONStorage,
  tolerantLocalStorage,
} from "../services/tolerantLocalStorage.ts";
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
 * The decisions as last stored by any tab, or null when nothing readable is
 * stored.
 */
function storedDecisions(): NetworkDecisionMap | null {
  try {
    const raw = tolerantLocalStorage.getItem(NETWORK_DECISIONS_STORAGE_KEY);
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw) as { state?: { decisions?: unknown } } | null;
    if (!parsed || typeof parsed !== "object" || !parsed.state) return null;
    return sanitizeNetworkDecisions(parsed.state.decisions);
  } catch {
    return null;
  }
}

/**
 * Every decision this tab made, with the time it was made (`null`: back to
 * "ask first"). Tabs share one stored map, and a change is merged per flow:
 * the most recent decision for a flow wins, whichever tab made it. Keeping
 * this tab's own decisions means
 * - a decision whose write was refused stays in effect for this session and
 *   is written again with the next change, instead of being replaced by an
 *   older stored value;
 * - when another tab's write drops one of these decisions (it read the map
 *   just before this tab wrote), this tab sees the change and writes the
 *   newer decision back.
 */
const ownDecisions = new Map<string, { decision: NetworkDecision | null; at: number }>();

function decidedAt(decision: NetworkDecision | undefined): number {
  return decision?.decidedAt ?? 0;
}

/** `base` with every decision of this tab that is newer than base's. */
function withOwnDecisions(base: NetworkDecisionMap): NetworkDecisionMap {
  const next: Record<string, NetworkDecision> = { ...base };
  for (const [key, { decision, at }] of ownDecisions) {
    if (at <= decidedAt(base[key])) continue;
    if (decision) next[key] = decision;
    else delete next[key];
  }
  return next;
}

function sameDecisions(a: NetworkDecisionMap, b: NetworkDecisionMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const x = a[key];
    const y = b[key];
    return (
      !!y && x?.value === y.value && x.source === y.source && x.decidedAt === y.decidedAt
    );
  });
}

/** Record this tab's changes and merge them onto the latest stored map. */
function decide(
  state: NetworkDecisionsState,
  changes: Record<string, NetworkDecision | null>,
): { decisions: NetworkDecisionMap } {
  const base = storedDecisions() ?? state.decisions;
  const now = Date.now();
  for (const [key, decision] of Object.entries(changes)) {
    // Strictly newer than anything stored for the flow, even within one
    // millisecond of another tab's change.
    const at = Math.max(now, decidedAt(base[key]) + 1, (ownDecisions.get(key)?.at ?? 0) + 1);
    ownDecisions.set(key, { decision: decision && { ...decision, decidedAt: at }, at });
  }
  return { decisions: withOwnDecisions(base) };
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
        set((state) =>
          decide(state, { [key]: value === "unset" ? null : { value, source } }),
        );
        return true;
      },
      replaceDecisions: (decisions) =>
        set((state) => {
          const wanted = sanitizeNetworkDecisions(decisions);
          const current = storedDecisions() ?? state.decisions;
          const changes: Record<string, NetworkDecision | null> = {};
          for (const key of Object.keys(current)) changes[key] = null;
          for (const [key, decision] of Object.entries(wanted)) {
            changes[key] = { value: decision.value, source: decision.source };
          }
          return decide(state, changes);
        }),
      reset: () => {
        ownDecisions.clear();
        set({ decisions: {} });
      },
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
          decisions: withOwnDecisions(sanitizeNetworkDecisions(stored?.decisions)),
        };
      },
      onRehydrateStorage: () => (state) => {
        // Another tab's write dropped a newer decision of this tab: store it
        // again so every tab (and the next load) sees it.
        const stored = storedDecisions();
        if (state && stored && !sameDecisions(stored, state.decisions)) {
          useNetworkDecisionsStore.setState({ decisions: { ...state.decisions } });
        }
      },
    },
  ),
);
