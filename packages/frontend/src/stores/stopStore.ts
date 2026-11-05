import { create } from "zustand";
import { db } from "../db/index.ts";
import { useCityStore } from "./cityStore.ts";
import { reportError } from "../services/errorReporter.ts";
import { shouldWriteStops } from "../services/gtfsQuotaGuard.ts";
import type { StopWithLines, LineInfo, LabelAnchor } from "@pt/shared";
import { loadStopUsage, recordStopUsage } from "../services/stopUsage.ts";

// 24h is well above GTFS_CLIENT_REFRESH_INTERVAL_MS (6h) so periodic
// refresh has time to land, but tight enough that an offline-resumed
// session on day-2+ stops trusting the cached badge lines.
//
// SCOPE: the window governs `lines` (the per-route badges that must not
// outlive the live /departures view), NOT the stop itself. A stop's name and
// coordinates do not rot, and deleting them stranded the map with nothing to
// draw whenever /stops/all was unreachable for longer than the window — while
// the RAPTOR bundle, which has no TTL at all, kept planning trips happily. See
// `hydrate` for the replacement policy.
const STOP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ApiRoute {
  id: string;
  shortName: string;
  color?: string;
  mode: LineInfo["mode"];
  subMode?: string;
}

interface ApiStop {
  id: string;
  name: string;
  location?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
  parentStationId?: string;
  routes?: ApiRoute[];
  labelAnchor?: LabelAnchor;
}

interface StopState {
  stops: StopWithLines[];
  hydrated: boolean;

  hydrate: () => Promise<void>;
  overlayBundleStops: () => Promise<void>;
  upsertStops: (stops: ApiStop[], opts?: { isStale?: () => boolean }) => Promise<void>;
  recordTap: (stopId: string) => Promise<void>;
  getPreloadScore: (stopId: string) => Promise<number>;
  reset: () => void;
}

function linesEqual(a: LineInfo[] | undefined, b: LineInfo[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((l, i) =>
    l.routeId === b[i].routeId &&
    l.shortName === b[i].shortName &&
    l.color === b[i].color &&
    l.mode === b[i].mode &&
    l.subMode === b[i].subMode
  );
}

// Tracks the in-flight db.stops.clear() so upsertStops can wait for it
// before writing, preventing a late-resolving clear from wiping new data.
// reset() owns lifecycle: it sets the promise and clears it via .finally()
// once the clear settles. upsertStops MUST NOT null this itself — two
// concurrent upsert callers would both null after their await, leaving a
// third upsert that arrives mid-clear with no gate to wait on.
let clearingDb: Promise<void> | null = null;

/**
 * Per-stop badge lines derived from the PTB bundle's own route membership
 * (`db.gtfsRoutes.stopIds`) — the same data `/stops/all` is built from
 * server-side, so the fallback badges match what the server would have sent.
 *
 * A route visiting one stop twice (GTFS loop/lasso trips list the stop twice —
 * see AGENTS.md guardrail 1) must contribute ONE badge, not two.
 */
function bundleLinesByStop(routes: readonly BundleRoute[]): Map<string, LineInfo[]> {
  const byStop = new Map<string, LineInfo[]>();
  for (const route of routes) {
    const line: LineInfo = {
      routeId: route.id,
      shortName: route.shortName,
      color: route.color,
      mode: route.mode,
    };
    for (const stopId of route.stopIds ?? []) {
      const lines = byStop.get(stopId);
      if (!lines) byStop.set(stopId, [line]);
      else if (!lines.some((l) => l.routeId === line.routeId)) lines.push(line);
    }
  }
  return byStop;
}

interface BundleRoute {
  id: string;
  shortName: string;
  color?: string;
  mode: LineInfo["mode"];
  stopIds: string[];
}

/**
 * The offline stop floor: the active city's stops as the RAPTOR bundle sees
 * them. Returns null when there is no bundle, or when the resident bundle
 * belongs to another city — `gtfsSyncMeta.cityId` is the only record of which
 * city `db.gtfsStops` was written for, and a city switch clears it lazily
 * (gtfsSync), so an unguarded read would paint city A's stops onto city B.
 */
async function readBundleStops(): Promise<{
  stops: { id: string; name: string; lat: number; lon: number }[];
  lines: Map<string, LineInfo[]>;
  /** When the bundle these stops came from was synced. */
  lastSynced: number;
} | null> {
  const cityId = useCityStore.getState().activeCity.id;
  const meta = await db.gtfsSyncMeta.get("current");
  if (!meta || meta.cityId !== cityId) return null;
  const [stops, routes] = await Promise.all([
    db.gtfsStops.toArray(),
    db.gtfsRoutes.toArray(),
  ]);
  // A city switch between the guard above and here would make both reads the
  // wrong city's — re-check before handing the rows back.
  if (useCityStore.getState().activeCity.id !== cityId) return null;
  if (stops.length === 0) return null;
  return {
    stops,
    lines: bundleLinesByStop(routes as BundleRoute[]),
    lastSynced: meta.lastSynced,
  };
}

/**
 * Merge the bundle floor under an existing (possibly empty or partial) server
 * snapshot. The server row wins wherever it exists — it carries display data
 * the bundle has no field for (labelAnchor, parentStationId) — but a row with
 * no usable badges takes the bundle's, which is what re-dresses a row whose
 * `lines` the staleness window just stripped.
 *
 * In-memory only: these stops are derived, so persisting them into `db.stops`
 * would both duplicate multi-MB of bundle data and corrupt `lastSeen`, whose
 * meaning is "when the server last confirmed this stop".
 */
async function mergeBundleFloor(current: StopWithLines[]): Promise<StopWithLines[] | null> {
  const bundle = await readBundleStops();
  if (!bundle) return null;
  const byId = new Map(current.map((s) => [s.id, s]));
  for (const bs of bundle.stops) {
    const lines = bundle.lines.get(bs.id);
    const existing = byId.get(bs.id);
    if (!existing) {
      byId.set(bs.id, {
        id: bs.id,
        name: bs.name,
        location: { lat: bs.lat, lon: bs.lon },
        lines,
        // Honest provenance: the bundle sync is when this stop was last
        // confirmed by the server. Nothing persists these rows, so the value
        // only ever feeds display/debug — but a `Date.now()` here would claim
        // a freshness the row does not have.
        lastSeen: bundle.lastSynced,
      });
      continue;
    }
    if ((!existing.lines || existing.lines.length === 0) && lines && lines.length > 0) {
      byId.set(bs.id, { ...existing, lines });
    }
  }
  return Array.from(byId.values());
}

export const useStopStore = create<StopState>((set, get) => ({
  stops: [],
  hydrated: false,

  async hydrate() {
    const cached = await db.stops.toArray();

    // Recovery scope: hydrate reads IDB unconditionally. If a prior session's
    // `upsertStops` call updated memory but its `bulkPut` failed (quota,
    // schema mismatch), this session sees only what made it to IDB until
    // useStopPreloader re-fetches and re-upserts. In-memory-first recovery
    // is single-session by design — cross-session recovery on a permanently
    // near-quota device depends on the network preloader running again.
    //
    // Staleness policy: a row whose `lines` cache predates
    // STOP_CACHE_MAX_AGE_MS keeps its geometry and loses its badges. The
    // window is wider than the bundle refresh interval (currently 6h) so we
    // don't fight with periodic GTFS refresh, but tight enough that a session
    // resumed days later never renders routes that no longer match the live
    // /departures API. `useVisibleStops` already renders a lineless stop as a
    // name-only card, and `useStopPreloader` re-fetches /stops/all on mount —
    // so a reachable server restores the badges within a request, while an
    // unreachable one leaves a usable map instead of an empty one.
    const cutoff = Date.now() - STOP_CACHE_MAX_AGE_MS;
    const stripped = new Set<string>();
    const stops: StopWithLines[] = cached.map((s) => {
      if (s.lastSeen >= cutoff) return { ...s };
      stripped.add(s.id);
      return { ...s, lines: undefined };
    });

    // Degraded states only — an empty snapshot (cold cache, post-wipe, or a
    // city switch whose re-fetch hasn't landed) or one the window just
    // stripped. Both mean the server data is missing or unverified, so fall
    // back to the bundle the on-device planner is already using. A healthy
    // snapshot skips the two table scans entirely.
    if (stops.length === 0 || stripped.size > 0) {
      try {
        const merged = await mergeBundleFloor(stops);
        if (merged) {
          set({ stops: merged, hydrated: true });
          return;
        }
      } catch (e) {
        // The floor is best-effort: a bundle read failure must not stop the
        // cached server snapshot from rendering.
        reportError(e instanceof Error ? e : new Error(String(e)), {
          context: { where: "stopStore.hydrate.bundleFloor" },
        });
      }
    }

    set({ stops, hydrated: true });
  },

  /**
   * Paint the bundle floor over whatever is in the store right now. Called by
   * `useStopPreloader` once /stops/all has exhausted its retries: the map
   * would otherwise stay empty for the rest of the session while the very
   * same stops sit in IndexedDB backing the RAPTOR index.
   */
  async overlayBundleStops() {
    try {
      const merged = await mergeBundleFloor(get().stops);
      if (merged) set({ stops: merged });
    } catch (e) {
      reportError(e instanceof Error ? e : new Error(String(e)), {
        context: { where: "stopStore.overlayBundleStops" },
      });
    }
  },

  async upsertStops(newStops: ApiStop[], opts?: { isStale?: () => boolean }) {
    // Wait on (but don't clear) an in-flight reset. The reference is captured
    // locally so two concurrent upserts both await the SAME promise without
    // racing to null the shared slot — see `clearingDb` comment for the
    // failure mode that prompted this. reset() owns the null via .finally().
    const pendingClear = clearingDb;
    if (pendingClear) await pendingClear;
    // Re-check staleness after the await: the caller's effect may have been
    // cleaned up (city switch, location change) while we awaited a clear.
    // Without this, an in-flight upsert for city A can land its data into
    // city B's empty store after reset() ran.
    if (opts?.isStale?.()) return;
    const now = Date.now();
    const withLocation = newStops.filter(
      (s) => s.location || (s.lat != null && s.lon != null)
    );
    const records = withLocation.map((s) => {
      const lines: LineInfo[] | undefined = s.routes?.map((route) => ({
        routeId: route.id,
        shortName: route.shortName,
        color: route.color,
        mode: route.mode,
        subMode: route.subMode,
      }));
      return {
        id: s.id,
        name: s.name,
        location: s.location ?? { lat: s.lat!, lon: s.lon! },
        parentStationId: s.parentStationId,
        labelAnchor: s.labelAnchor,
        lastSeen: now,
        lines,
      };
    });

    const existing = get().stops;
    const existingMap = new Map(existing.map((s) => [s.id, s]));
    for (const r of records) {
      existingMap.set(r.id, { ...r });
    }
    // Referential stability: skip set() if meaningful data hasn't changed.
    // lastSeen always updates (it's Date.now()), so we only compare fields
    // that affect rendering to avoid unnecessary TransitMap re-renders.
    const merged = Array.from(existingMap.values());
    const existingById = new Map(existing.map((s) => [s.id, s]));
    const meaningfulChange =
      merged.length !== existing.length ||
      !merged.every((ms) => {
        const es = existingById.get(ms.id);
        if (!es) return false;
        return (
          es.name === ms.name &&
          es.location.lat === ms.location.lat &&
          es.location.lon === ms.location.lon &&
          es.parentStationId === ms.parentStationId &&
          es.labelAnchor === ms.labelAnchor &&
          linesEqual(es.lines, ms.lines)
        );
      });

    // In-memory render first, persistence best-effort. A bulkPut failure
    // (iOS PWA storage near-quota has been observed throwing on a multi-MB
    // /stops/all payload while accepting smaller /stops/nearby payloads)
    // must not leave the map showing only nearby stops for the whole session.
    if (meaningfulChange) {
      set({ stops: merged });
    }
    // Quota pre-flight: on iOS PWAs that are near storage quota, attempting
    // a multi-MB bulkPut wastes IDB churn and surfaces a generic
    // QuotaExceededError. Skipping early gives a clearer telemetry signal
    // ("storage full, skipped persist") and lets the in-memory write above
    // serve the rest of the session. The catch below remains as a safety net
    // for estimate-vs-actual drift and platforms without storage.estimate.
    if (!(await shouldWriteStops())) {
      reportError(new Error("stops persist skipped: storage near quota"), {
        context: {
          where: "stopStore.upsertStops.quotaSkip",
          count: records.length,
        },
      });
    } else {
      try {
        await db.stops.bulkPut(records);
      } catch (e) {
        reportError(e instanceof Error ? e : new Error(String(e)), {
          context: {
            where: "stopStore.upsertStops.bulkPut",
            count: records.length,
          },
        });
      }
    }
    // Final staleness check: a city switch can land between set() and the
    // end of the bulkPut await. If the caller is now stale, our in-memory
    // write needs to be undone — reset() has already flushed state to [],
    // but our set above just re-populated it with the prior city's stops.
    // Re-call reset to restore the cleared state. Idempotent if not stale.
    if (opts?.isStale?.()) {
      get().reset();
    }
  },

  async recordTap(stopId: string) {
    await recordStopUsage(stopId);
  },

  async getPreloadScore(stopId: string) {
    const stat = (await loadStopUsage([stopId])).get(stopId);
    if (!stat) return 0;

    const tapScore = stat.tapCount * 3;
    const hoursSinceLastTap = (Date.now() - stat.lastTapped) / (1000 * 60 * 60);
    let recencyBonus = 0;
    if (hoursSinceLastTap < 24) recencyBonus = 10;
    else if (hoursSinceLastTap < 168) recencyBonus = 5; // 7 days

    return tapScore + recencyBonus;
  },

  reset() {
    // Clear IndexedDB so stale cross-city stops don't rehydrate.
    // Keep hydrated: true so the hydrate effect doesn't re-run and
    // reload the (now-clearing) DB — the preloader's loadAll will
    // repopulate from the correct city's API.
    // .finally clears the slot exactly when the clear settles, so a third
    // upsertStops arriving mid-clear still has a gate to await; the prior
    // "first awaiter nulls it" pattern dropped the gate for everyone else.
    const clearPromise = db.stops.clear() as unknown as Promise<void>;
    clearingDb = clearPromise.finally(() => {
      if (clearingDb === clearPromise) clearingDb = null;
    });
    set({ stops: [], hydrated: true });
  },
}));
