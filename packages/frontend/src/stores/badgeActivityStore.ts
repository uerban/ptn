import { create } from "zustand";

/**
 * Per-stop badge activity, sourced from the schedule tile by
 * `useViewportBadgeActivity`. Consumed by `useVisibleStops` to narrow urban-mode
 * stop-card badges to routes actually departing soon.
 *
 *  - "loading"      — tile resolve/compute in flight (hold badges; render name-only).
 *  - "ready"        — authoritative route-id set (possibly empty → name-only card).
 *  - "unavailable"  — flag off / stop not in tile / fetch failed → render name-only unless a recent resolved verdict can be held.
 *
 * Entries are retained across recompute rounds and overwritten per-stop, so a
 * minute-tick or viewport nudge never blanks the map (no full→reduced blink).
 * `retainViewport` bounds nearby history while prioritizing visible stops.
 */
export const BADGE_ACTIVITY_HOLD_MS = 120_000;

export type BadgeActivity =
  | { state: "loading" }
  | { state: "ready"; routeIds: ReadonlySet<string> }
  | { state: "unavailable" };

interface BadgeActivityState {
  byStop: Map<string, BadgeActivity>;
  context: string | null;
  activateContext: (context: string) => void;
  resolvedAt: Map<string, number>;
  retainViewport: (keep: ReadonlySet<string>, limit?: number) => void;
  set: (stopId: string, activity: BadgeActivity) => void;
  setMany: (entries: Array<[string, BadgeActivity]>, context?: string) => void;
  evictExcept: (keep: ReadonlySet<string>) => void;
  clear: () => void;
}

export const useBadgeActivityStore = create<BadgeActivityState>()((set, get) => ({
  byStop: new Map(),
  context: null,
  resolvedAt: new Map(),
  activateContext: (context) => {
    if (get().context !== context) set({ context, byStop: new Map(), resolvedAt: new Map() });
  },
  set: (stopId, activity) => {
    const next = new Map(get().byStop);
    next.set(stopId, activity);
    const resolvedAt = new Map(get().resolvedAt);
    if (activity.state === "ready") resolvedAt.set(stopId, Date.now());
    else resolvedAt.delete(stopId);
    set({ byStop: next, resolvedAt });
  },
  setMany: (entries, context) => {
    if (context !== undefined && get().context !== context) return;
    if (entries.length === 0) return;
    const next = new Map(get().byStop);
    const resolvedAt = new Map(get().resolvedAt);
    const now = Date.now();
    for (const [id, a] of entries) {
      // A short refresh failure must not resurrect the catalog's full lines
      // or blank a recently resolved card. Never retain indefinitely offline.
      if (a.state !== "ready" && next.get(id)?.state === "ready" &&
          now - (resolvedAt.get(id) ?? 0) < BADGE_ACTIVITY_HOLD_MS) continue;
      next.delete(id);
      next.set(id, a);
      if (a.state === "ready") resolvedAt.set(id, now);
      else resolvedAt.delete(id);
    }
    set({ byStop: next, resolvedAt });
  },
  retainViewport: (keep, limit = 4_000) => {
    const next = new Map(get().byStop);
    const resolvedAt = new Map(get().resolvedAt);
    for (const id of next.keys()) {
      if (next.size <= Math.max(limit, keep.size)) break;
      if (!keep.has(id)) { next.delete(id); resolvedAt.delete(id); }
    }
    if (next.size !== get().byStop.size) set({ byStop: next, resolvedAt });
  },
  evictExcept: (keep) => {
    const cur = get().byStop;
    let changed = false;
    const next = new Map<string, BadgeActivity>();
    for (const [id, a] of cur) {
      if (keep.has(id)) next.set(id, a);
      else changed = true;
    }
    if (changed) set({ byStop: next, resolvedAt: new Map([...get().resolvedAt].filter(([id]) => keep.has(id))) });
  },
  clear: () => set({ byStop: new Map(), context: null, resolvedAt: new Map() }),
}));


export function badgeActivityContext(cityId: string, lookAheadHours: number, tz: string, generationId?: string | null): string {
  return JSON.stringify(generationId ? [cityId, lookAheadHours, tz, generationId] : [cityId, lookAheadHours, tz]);
}
