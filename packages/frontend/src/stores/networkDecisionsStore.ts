import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createTolerantJSONStorage,
  tolerantLocalStorage,
} from "../services/tolerantLocalStorage.ts";
import {
  decisionKey,
  NETWORK_DECISIONS_SCHEMA_VERSION,
  sanitizeDecisionClears,
  sanitizeNetworkDecisions,
  type NetworkDecision,
  type NetworkDecisionMap,
  type NetworkDecisionSource,
  type NetworkDecisionValue,
} from "@pt/shared/privacy";

export const NETWORK_DECISIONS_STORAGE_KEY = "ptn-network-decisions";

/** When each flow last went back to "ask first", keyed like decisions. */
type DecisionClears = Readonly<Record<string, number>>;

interface DecisionSnapshot {
  decisions: NetworkDecisionMap;
  cleared: DecisionClears;
}

interface NetworkDecisionsState extends DecisionSnapshot {
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

const EMPTY: DecisionSnapshot = { decisions: {}, cleared: {} };

function sanitizeSnapshot(raw: unknown): DecisionSnapshot {
  const state = (raw && typeof raw === "object" ? raw : {}) as Partial<DecisionSnapshot>;
  return {
    decisions: sanitizeNetworkDecisions(state.decisions),
    cleared: sanitizeDecisionClears(state.cleared),
  };
}

/** A serialized store value, or null when it is missing or unreadable. */
function parseSnapshot(raw: string | null | undefined): DecisionSnapshot | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || !parsed.state) return null;
    return sanitizeSnapshot(parsed.state);
  } catch {
    return null;
  }
}

/** The decisions as last stored by any tab, or null when nothing readable is
 * stored. */
function storedSnapshot(): DecisionSnapshot | null {
  return parseSnapshot(tolerantLocalStorage.getItem(NETWORK_DECISIONS_STORAGE_KEY) as string | null);
}

function snapshotOf(state: DecisionSnapshot): DecisionSnapshot {
  return { decisions: state.decisions, cleared: state.cleared };
}

/** One flow's latest change: a decision, or `null` for back to "ask first". */
interface Change {
  at: number;
  decision: NetworkDecision | null;
}

/** Ties (same millisecond) go to the more protective change, so every tab
 * settles on the same result. */
function protection(change: Change): number {
  if (!change.decision) return 1;
  return change.decision.value === "denied" ? 2 : 0;
}

function supersedes(a: Change, b: Change): boolean {
  if (a.at !== b.at) return a.at > b.at;
  if (protection(a) !== protection(b)) return protection(a) > protection(b);
  return (a.decision?.source ?? "") > (b.decision?.source ?? "");
}

/**
 * Tabs share one stored copy of the decisions and each tab keeps its own in
 * memory. Copies are merged per flow, newest change wins, and a return to
 * "ask first" is kept as a timed entry rather than a missing one, so an older
 * grant held by another copy can never bring a flow back. The merge gives the
 * same result in any order, so tabs converge whichever writes last.
 */
function mergeSnapshots(...snapshots: DecisionSnapshot[]): DecisionSnapshot {
  const latest = new Map<string, Change>();
  const offer = (key: string, change: Change) => {
    const current = latest.get(key);
    if (!current || supersedes(change, current)) latest.set(key, change);
  };
  for (const { decisions, cleared } of snapshots) {
    for (const [key, decision] of Object.entries(decisions)) {
      offer(key, { at: decision.decidedAt ?? 0, decision });
    }
    for (const [key, at] of Object.entries(cleared)) offer(key, { at, decision: null });
  }
  const decisions: Record<string, NetworkDecision> = {};
  const cleared: Record<string, number> = {};
  for (const [key, { at, decision }] of latest) {
    if (decision) decisions[key] = decision;
    else cleared[key] = at;
  }
  return { decisions, cleared };
}

function sameSnapshot(a: DecisionSnapshot, b: DecisionSnapshot): boolean {
  const sameDecisions = (x: NetworkDecisionMap, y: NetworkDecisionMap) => {
    const keys = Object.keys(x);
    return (
      keys.length === Object.keys(y).length &&
      keys.every((key) => {
        const p = x[key];
        const q = y[key];
        return !!q && p?.value === q.value && p.source === q.source && p.decidedAt === q.decidedAt;
      })
    );
  };
  const sameClears = (x: DecisionClears, y: DecisionClears) => {
    const keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every((key) => x[key] === y[key]);
  };
  return sameDecisions(a.decisions, b.decisions) && sameClears(a.cleared, b.cleared);
}

function changedAt(snapshot: DecisionSnapshot, key: string): number {
  return Math.max(snapshot.decisions[key]?.decidedAt ?? 0, snapshot.cleared[key] ?? 0);
}

/**
 * Apply this tab's changes on top of the latest stored copy merged with this
 * tab's own. Merging the tab's copy keeps a decision whose write was refused
 * in effect, and written again with the next change.
 */
function decide(
  state: DecisionSnapshot,
  changes: Record<string, NetworkDecision | null>,
): DecisionSnapshot {
  const base = mergeSnapshots(storedSnapshot() ?? EMPTY, snapshotOf(state));
  const decisions: Record<string, NetworkDecision> = { ...base.decisions };
  const cleared: Record<string, number> = { ...base.cleared };
  const now = Date.now();
  for (const [key, decision] of Object.entries(changes)) {
    // Strictly newer than anything known for the flow, even within one
    // millisecond of another tab's change.
    const at = Math.max(now, changedAt(base, key) + 1);
    if (decision) {
      decisions[key] = { ...decision, decidedAt: at };
      delete cleared[key];
    } else {
      delete decisions[key];
      cleared[key] = at;
    }
  }
  return { decisions, cleared };
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
      cleared: {},
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
          const current = mergeSnapshots(storedSnapshot() ?? EMPTY, snapshotOf(state));
          const changes: Record<string, NetworkDecision | null> = {};
          for (const key of Object.keys(current.decisions)) changes[key] = null;
          for (const [key, decision] of Object.entries(wanted)) {
            changes[key] = { value: decision.value, source: decision.source };
          }
          return decide(state, changes);
        }),
      reset: () => set({ decisions: {}, cleared: {} }),
    }),
    {
      name: NETWORK_DECISIONS_STORAGE_KEY,
      storage: createTolerantJSONStorage(),
      version: NETWORK_DECISIONS_SCHEMA_VERSION,
      partialize: (state) => ({ decisions: state.decisions, cleared: state.cleared }),
      migrate: (persisted) => sanitizeSnapshot(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...mergeSnapshots(sanitizeSnapshot(persisted), snapshotOf(current)),
      }),
    },
  ),
);

/**
 * Take in a change another tab stored (`newValue` of its `storage` event).
 *
 * Writes from two tabs are not serialized: a tab can read the stored copy
 * just before another tab's write lands and then store its own change on top,
 * dropping the other change. Both tabs repair that here. The overwritten tab
 * sees the later write and stores its newer decision again; the overwriting
 * tab receives the dropped change as `newValue`, even though its own read of
 * storage no longer shows it, and stores the merge. A change is only lost when
 * every tab that saw it closes before handling these events.
 */
export function absorbStoredDecisions(newValue: string | null | undefined): void {
  const stored = storedSnapshot();
  const incoming = parseSnapshot(newValue);
  // Removed (data deletion) or unreadable: nothing to merge, nothing to write.
  if (!stored && !incoming) return;
  const state = useNetworkDecisionsStore.getState();
  const merged = mergeSnapshots(stored ?? EMPTY, incoming ?? EMPTY, snapshotOf(state));
  if (!stored || !sameSnapshot(stored, merged) || !sameSnapshot(snapshotOf(state), merged)) {
    useNetworkDecisionsStore.setState(merged);
  }
}
