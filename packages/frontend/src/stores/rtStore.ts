import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { RtPoller } from "../services/rtPoller.ts";
import type { RtRouteUpdate, RtTripUpdate } from "@pt/shared";

// Mirrors the server-side clamp in `parseTripUpdatesBuffer` (±1800 s).
// Defends against feeds that bypass the backend (cached envelopes, alt poll
// paths, future decoder regressions) reaching the UI with absurd delays.
const DELAY_SECONDS_MAX = 1800;

function clampDelay(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(DELAY_SECONDS_MAX, Math.max(-DELAY_SECONDS_MAX, raw));
}

interface RtState {
  updates: Map<string, RtTripUpdate[]>;
  poller: RtPoller;
  /** Guidance's route set: replaces the previous one. */
  subscribeRoutes: (routeIds: string[]) => void;
  /** Drops guidance's route set; routes a surface still retains keep polling. */
  unsubscribeAll: () => void;
  /**
   * Additive, counted hold on routes for a surface other than guidance (the
   * result cards, the line preview). Returns the release. A route polls while
   * guidance subscribes it or any holder retains it, so one surface letting go
   * never cuts another off — picking a result starts guidance on the same
   * routes before the result list unmounts and releases them.
   */
  retainRoutes: (routeIds: string[]) => () => void;
  setMode: (mode: "idle" | "navigating" | "transfer") => void;
  getTripDelay: (tripId: string) => { delaySeconds: number; cancelled: boolean; deleted?: boolean } | null;
  /**
   * Returns the wall-clock millisecond timestamp at which the most recent
   * update for `tripId` was stored in this store, or `null` if the trip is
   * unknown OR the entry was inserted without a `receivedAt` stamp (legacy
   * data, or a writer that hasn't been migrated). Consumers (e.g. the
   * 120s freshness guard in `rtOverlay`) should treat `null` as "fresh"
   * to avoid silently dropping RT corrections.
   */
  getReceivedAt: (tripId: string) => number | null;
  /**
   * Single writer entry-point for RT updates. Any code that mutates
   * `updates` MUST go through this so the clamp + receivedAt stamp apply
   * uniformly across writer paths (poller-managed subscriptions AND
   * surfaces like LinePreview that bypass `subscribeRoutes`).
   */
  applyUpdate: (update: RtRouteUpdate) => void;
}

/**
 * Lazy tripId → update index, cached per `updates` Map IDENTITY. Every write
 * replaces the Map (see `applyUpdate`), so a cached index can never go stale;
 * the WeakMap lets retired Maps (and their indexes) be collected. Built once
 * per RT patch on first per-trip read instead of a linear scan over every
 * subscribed route's trip array PER READ — `useTripDelay` runs its selector
 * once per subscriber per patch, which made reads O(subscribers × trips).
 * Keyed on the Map rather than stored in the store so test/e2e seeders that
 * `setState({ updates })` directly stay correct with no extra bookkeeping.
 * First-match-wins across routes, mirroring the scan it replaces.
 */
const tripIndexCache = new WeakMap<Map<string, RtTripUpdate[]>, Map<string, RtTripUpdate>>();
function tripIndex(updates: Map<string, RtTripUpdate[]>): Map<string, RtTripUpdate> {
  let idx = tripIndexCache.get(updates);
  if (!idx) {
    idx = new Map();
    for (const trips of updates.values()) {
      for (const t of trips) {
        if (!idx.has(t.tripId)) idx.set(t.tripId, t);
      }
    }
    tripIndexCache.set(updates, idx);
  }
  return idx;
}

export const useRtStore = create<RtState>()((set, get) => {
  const poller = new RtPoller();
  const guidanceRoutes = new Set<string>();
  const retained = new Map<string, number>();
  const polled = new Set<string>();

  /**
   * Bring the poller and the stored updates in line with who wants what:
   * subscribe newly wanted routes, drop routes nobody wants along with their
   * entries (so `updates` cannot grow without bound across a session), and
   * stop polling once nothing is wanted.
   */
  function reconcile(): void {
    const want = new Set([...guidanceRoutes, ...retained.keys()]);
    for (const id of [...polled]) {
      if (want.has(id)) continue;
      poller.unsubscribe(id);
      polled.delete(id);
    }
    const state = get();
    let next: Map<string, RtTripUpdate[]> | null = null;
    for (const id of state.updates.keys()) {
      if (want.has(id)) continue;
      if (!next) next = new Map(state.updates);
      next.delete(id);
    }
    if (next) set({ updates: next });
    // Re-subscribing a polled route is a no-op for the poller (a Map.set).
    for (const id of want) {
      poller.subscribe(id, applyUpdate);
      polled.add(id);
    }
    if (want.size === 0) poller.stop();
    else poller.start();
  }

  function applyUpdate(update: RtRouteUpdate): void {
    // Stamp every trip with the wall-clock arrival time so the freshness
    // guard can detect stale entries (see RtTripUpdate.receivedAt). Same
    // pass clamps delaySeconds to ±1800s defending against feeds that
    // bypass the backend decoder cap. Centralised here because more than
    // one surface writes into `updates` (poller subscriptions AND ad-hoc
    // callers like LinePreview that subscribe through `poller` directly).
    const now = Date.now();
    const stamped = update.trips.map((t) => {
      const clamped = clampDelay(t.delaySeconds);
      if (clamped !== t.delaySeconds || !Number.isFinite(t.delaySeconds)) {
        console.debug("rt.clamp", {
          tripId: t.tripId,
          raw: t.delaySeconds,
          clamped,
        });
      }
      return { ...t, delaySeconds: clamped, receivedAt: now };
    });
    set((state) => {
      const next = new Map(state.updates);
      next.set(update.routeId, stamped);
      return { updates: next };
    });
  }

  return {
    updates: new Map(),
    poller,
    applyUpdate,

    subscribeRoutes(routeIds: string[]) {
      guidanceRoutes.clear();
      for (const id of routeIds) guidanceRoutes.add(id);
      reconcile();
    },

    unsubscribeAll() {
      guidanceRoutes.clear();
      reconcile();
    },

    retainRoutes(routeIds: string[]) {
      const ids = [...new Set(routeIds)];
      for (const id of ids) retained.set(id, (retained.get(id) ?? 0) + 1);
      reconcile();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const id of ids) {
          const n = (retained.get(id) ?? 0) - 1;
          if (n > 0) retained.set(id, n);
          else retained.delete(id);
        }
        reconcile();
      };
    },

    setMode(mode) {
      poller.setMode(mode);
    },

    getTripDelay(tripId: string) {
      const t = tripIndex(get().updates).get(tripId);
      return t
        ? { delaySeconds: t.delaySeconds, cancelled: t.cancelled, deleted: t.deleted }
        : null;
    },

    getReceivedAt(tripId: string) {
      const t = tripIndex(get().updates).get(tripId);
      return t && typeof t.receivedAt === "number" ? t.receivedAt : null;
    },
  };
});

/**
 * Subscribing selector: re-renders when the RT update for `tripId` changes.
 *
 * Components that need live RT data MUST use this hook (or another selector
 * via `useRtStore(...)`) — calling `useRtStore.getState().getTripDelay(...)`
 * reads a snapshot and does not subscribe, so the UI will not re-render when
 * an RT patch flips the `updates` Map identity. See known-defects D-009 / D-019.
 *
 * Returns `null` when `tripId` is undefined or no update is present.
 * `useShallow` keeps re-renders cheap: the selector returns a fresh object on
 * every `updates` patch (because the Map reference flips each time), but
 * shallow-equal results skip the React render.
 */
export function useTripDelay(
  tripId: string | undefined,
): { delaySeconds: number; cancelled: boolean; deleted?: boolean } | null {
  return useRtStore(
    useShallow((s) => {
      if (!tripId) return null;
      const t = tripIndex(s.updates).get(tripId);
      return t
        ? { delaySeconds: t.delaySeconds, cancelled: t.cancelled, deleted: t.deleted }
        : null;
    }),
  );
}
