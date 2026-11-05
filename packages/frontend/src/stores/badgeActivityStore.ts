import { create } from "zustand";

/**
 * Per-stop badge activity, sourced from the schedule tile by
 * `useViewportBadgeActivity`. Consumed by `useVisibleStops` to narrow urban-mode
 * stop-card badges to routes actually departing soon.
 *
 *  - "loading"      — tile resolve/compute in flight (hold badges; render name-only).
 *  - "ready"        — authoritative route-id set (possibly empty → name-only card).
 *  - "unavailable"  — flag off / stop not in tile / fetch failed → fail-open to full lines.
 *
 * Entries are retained across recompute rounds and overwritten per-stop, so a
 * minute-tick or viewport nudge never blanks the map (no full→reduced blink).
 * `evictExcept` bounds memory to the current viewport set.
 */
export type BadgeActivity =
  | { state: "loading" }
  | { state: "ready"; routeIds: ReadonlySet<string> }
  | { state: "unavailable" };

interface BadgeActivityState {
  byStop: Map<string, BadgeActivity>;
  set: (stopId: string, activity: BadgeActivity) => void;
  setMany: (entries: Array<[string, BadgeActivity]>) => void;
  evictExcept: (keep: ReadonlySet<string>) => void;
  clear: () => void;
}

export const useBadgeActivityStore = create<BadgeActivityState>()((set, get) => ({
  byStop: new Map(),
  set: (stopId, activity) => {
    const next = new Map(get().byStop);
    next.set(stopId, activity);
    set({ byStop: next });
  },
  setMany: (entries) => {
    if (entries.length === 0) return;
    const next = new Map(get().byStop);
    for (const [id, a] of entries) next.set(id, a);
    set({ byStop: next });
  },
  evictExcept: (keep) => {
    const cur = get().byStop;
    let changed = false;
    const next = new Map<string, BadgeActivity>();
    for (const [id, a] of cur) {
      if (keep.has(id)) next.set(id, a);
      else changed = true;
    }
    if (changed) set({ byStop: next });
  },
  clear: () => set({ byStop: new Map() }),
}));
