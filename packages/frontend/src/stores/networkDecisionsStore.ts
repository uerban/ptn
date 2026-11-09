import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
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
  /**
   * Which life of the stored decisions this copy belongs to. Deleting all
   * data starts a new one, so a copy another tab kept from before the
   * deletion is recognised as outdated instead of being merged back. Empty
   * for a copy that does not say (written before generations existed); such
   * a copy merges with any generation.
   */
  generation: string;
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

const EMPTY: DecisionSnapshot = { decisions: {}, cleared: {}, generation: "" };

const MAX_GENERATION_LENGTH = 64;

function newGeneration(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeSnapshot(raw: unknown): DecisionSnapshot {
  const state = (raw && typeof raw === "object" ? raw : {}) as Partial<DecisionSnapshot>;
  const generation =
    typeof state.generation === "string" && state.generation.length <= MAX_GENERATION_LENGTH
      ? state.generation
      : "";
  return {
    decisions: sanitizeNetworkDecisions(state.decisions),
    cleared: sanitizeDecisionClears(state.cleared),
    generation,
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

function storedRaw(): string | null {
  return tolerantLocalStorage.getItem(NETWORK_DECISIONS_STORAGE_KEY) as string | null;
}

/** The decisions as last stored by any tab, or null when nothing readable is
 * stored. */
function storedSnapshot(): DecisionSnapshot | null {
  return parseSnapshot(storedRaw());
}

function snapshotOf(state: DecisionSnapshot): DecisionSnapshot {
  return { decisions: state.decisions, cleared: state.cleared, generation: state.generation };
}

/** The generation this tab last found in storage, or null before it has
 * found one. A tab whose own generation was stored and is now gone from
 * storage knows all data was deleted meanwhile. */
let seenGeneration: string | null = null;

function sameGeneration(a: string, b: string): boolean {
  return a === "" || b === "" || a === b;
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
  const generation = snapshots.find((snapshot) => snapshot.generation)?.generation ?? "";
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
  return { decisions, cleared, generation };
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
  return (
    a.generation === b.generation &&
    sameDecisions(a.decisions, b.decisions) &&
    sameClears(a.cleared, b.cleared)
  );
}

function changedAt(snapshot: DecisionSnapshot, key: string): number {
  return Math.max(snapshot.decisions[key]?.decidedAt ?? 0, snapshot.cleared[key] ?? 0);
}

/** What storage holds now, read once. */
interface StoredRead {
  /** The stored copy, or null when missing or unreadable. */
  stored: DecisionSnapshot | null;
  /** Nothing is stored at all (as opposed to an unreadable value). */
  missing: boolean;
}

function readStored(): StoredRead {
  const raw = storedRaw();
  return { stored: parseSnapshot(raw), missing: raw === null };
}

/**
 * The decisions to build on: the stored copy merged with this tab's own and,
 * when given, with the copy another tab just stored. Merging this tab's copy
 * keeps a decision whose write was refused in effect, and written again with
 * the next change.
 *
 * This tab's copy is left out once all data was deleted after it was stored:
 * the stored decisions were removed (`removed`, or missing although this
 * tab's generation was stored), or replaced by a new generation. Its grants
 * then never come back.
 */
function current(
  state: DecisionSnapshot,
  { stored, missing }: StoredRead,
  { removed = false, incoming = null }: { removed?: boolean; incoming?: DecisionSnapshot | null } = {},
): DecisionSnapshot {
  const ownWasStored = seenGeneration === state.generation;
  const outdated =
    removed ||
    (ownWasStored &&
      (missing || (!!stored && !sameGeneration(stored.generation, state.generation))));
  const copies: DecisionSnapshot[] = [];
  if (stored) {
    copies.push(stored);
    if (incoming && sameGeneration(incoming.generation, stored.generation)) copies.push(incoming);
  }
  if (!outdated) copies.push(snapshotOf(state));
  return copies.length > 0 ? mergeSnapshots(...copies) : EMPTY;
}

/** Remember the generation storage holds now. Called after every write, so
 * a tab always knows which generation it stored last. */
function noteStored(): void {
  const stored = storedSnapshot();
  if (stored) seenGeneration = stored.generation;
}

/**
 * Apply this tab's changes on top of the current decisions (see `current`).
 */
function decide(
  state: DecisionSnapshot,
  changes: Record<string, NetworkDecision | null>,
): DecisionSnapshot {
  const base = current(snapshotOf(state), readStored());
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
  return { decisions, cleared, generation: base.generation || newGeneration() };
}

type PersistedDecisions = DecisionSnapshot;

const tolerantStorage = createTolerantJSONStorage<PersistedDecisions>();
let writesHeld = false;

/**
 * Writes go through unless the store is updated in memory only. Every write
 * the store makes passes here, so this is the one place that records the
 * generation it left in storage.
 */
const decisionsStorage: PersistStorage<PersistedDecisions> | undefined = tolerantStorage && {
  getItem: (name) => tolerantStorage.getItem(name),
  setItem: (name, value) => {
    if (writesHeld) return;
    void tolerantStorage.setItem(name, value);
    noteStored();
  },
  removeItem: (name) => tolerantStorage.removeItem(name),
};

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
      generation: "",
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
          const base = current(snapshotOf(state), readStored());
          const changes: Record<string, NetworkDecision | null> = {};
          for (const key of Object.keys(base.decisions)) changes[key] = null;
          for (const [key, decision] of Object.entries(wanted)) {
            changes[key] = { value: decision.value, source: decision.source };
          }
          return decide(state, changes);
        }),
      // A new generation: copies other tabs hold from before are outdated.
      reset: () => set({ decisions: {}, cleared: {}, generation: newGeneration() }),
    }),
    {
      name: NETWORK_DECISIONS_STORAGE_KEY,
      storage: decisionsStorage,
      version: NETWORK_DECISIONS_SCHEMA_VERSION,
      partialize: (state): PersistedDecisions => snapshotOf(state),
      migrate: (persisted) => sanitizeSnapshot(persisted),
      merge: (persisted, state) => {
        if (persisted === undefined) return state;
        const stored = sanitizeSnapshot(persisted);
        const next = current(snapshotOf(state), { stored, missing: false });
        seenGeneration = stored.generation;
        return { ...state, ...next };
      },
    },
  ),
);

/**
 * Take in a change another tab stored (`newValue` of its `storage` event,
 * null when that tab removed the decisions).
 *
 * Writes from two tabs are not serialized: a tab can read the stored copy
 * just before another tab's write lands and then store its own change on top,
 * dropping the other change. Both tabs repair that here. The overwritten tab
 * sees the later write and stores its newer decision again; the overwriting
 * tab receives the dropped change as `newValue`, even though its own read of
 * storage no longer shows it, and stores the merge. A change is only lost when
 * every tab that saw it closes before handling these events.
 *
 * A removal means another tab deleted all data: this tab drops its own copy
 * and takes whatever was stored since, or nothing, without writing anything
 * back.
 */
export function absorbStoredDecisions(newValue: string | null): void {
  const read = readStored();
  const { stored } = read;
  const state = useNetworkDecisionsStore.getState();
  const next = current(snapshotOf(state), read, {
    removed: newValue === null,
    incoming: parseSnapshot(newValue),
  });
  if (stored) seenGeneration = stored.generation;
  const memoryChanged = !sameSnapshot(snapshotOf(state), next);
  if (stored && sameSnapshot(stored, next)) {
    if (memoryChanged) useNetworkDecisionsStore.setState(next);
    return;
  }
  if (!stored) {
    // Nothing readable is stored: update memory only, so a deletion holds.
    if (!memoryChanged) return;
    writesHeld = true;
    try {
      useNetworkDecisionsStore.setState(next);
    } finally {
      writesHeld = false;
    }
    return;
  }
  useNetworkDecisionsStore.setState(next);
}
