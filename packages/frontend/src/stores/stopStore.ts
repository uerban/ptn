import {useGtfsDataStore} from "./gtfsDataStore.ts";
import {cityDataWrite} from "../services/cityDataWrite.ts";
import { captureCityData, useCityDataStore } from "../services/cityData.ts";
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
  cityId: string | null;

  hydrate: () => Promise<void>;
  overlayBundleStops: () => Promise<void>;
  upsertStops: (stops: ApiStop[], opts?: { isStale?: () => boolean; cityId?: string }) => Promise<void>;
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

// Reset cancels pending optional cache writes without opening a disk clear.
let stopCacheAbort = new AbortController();

/** IndexedDB writes to a different store can still delay catalog reads at
 * the browser's backing store. Do not start this optional snapshot while the
 * selected catalog is being activated. Reset releases the waiter immediately. */
async function waitForActivation(signal: AbortSignal): Promise<void> {
  if (signal.aborted || !useGtfsDataStore.getState().syncing) return;
  await new Promise<void>(resolve => {
    const finish = () => {
      unsubscribe();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = useGtfsDataStore.subscribe(state => {
      if (!state.syncing) finish();
    });
    signal.addEventListener("abort", finish, {once: true});
    if (signal.aborted || !useGtfsDataStore.getState().syncing) finish();
  });
}

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
 * them. The captured city context validates each async read; legacy projection
 * fallback requires matching metadata. Foreign rows never become the new
 * city's stop floor while activation is pending.
 */
async function readBundleStops(): Promise<{
  stops: { id: string; name: string; lat: number; lon: number }[];
  lines: Map<string, LineInfo[]>;
  /** When the bundle these stops came from was synced. */
  lastSynced: number;
} | null> {
  const cityId = useCityStore.getState().activeCity.id;
  const data = captureCityData(cityId);
  const meta = await data.gtfsSyncMeta.get("current");
  if (!meta) return null;
  const [stops, routes] = await Promise.all([
    data.gtfsStops.toArray(),
    data.gtfsRoutes.toArray(),
  ]);
  // A city switch between the guard above and here would make both reads the
  // wrong city's — re-check before handing the rows back.
  data.assertCurrent();
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
  cityId: null,

  async hydrate() {
    const signal = stopCacheAbort.signal;
    const cityId = useCityStore.getState().activeCity.id;
    const cached = await db.stops.filter(stop => stop.cityId === cityId).toArray();
    if (signal.aborted || useCityStore.getState().activeCity.id !== cityId) return;

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
        if (signal.aborted || useCityStore.getState().activeCity.id !== cityId) return;
        if (merged) {
          set({ stops: merged, hydrated: true, cityId });
          return;
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        // The floor is best-effort: a bundle read failure must not stop the
        // cached server snapshot from rendering.
        reportError(e instanceof Error ? e : new Error(String(e)), {
          context: { where: "stopStore.hydrate.bundleFloor" },
        });
      }
    }

    if (signal.aborted || useCityStore.getState().activeCity.id !== cityId) return;
    set({ stops, hydrated: true, cityId });
  },

  /**
   * Paint the bundle floor over whatever is in the store right now. Called by
   * `useStopPreloader` when the local catalog arrives or API retries fail.
   * Local stops can render without waiting for the API retry backoff.
   */
  async overlayBundleStops() {
    const signal = stopCacheAbort.signal;
    const previousStops = get().stops;
    const cityId = useCityStore.getState().activeCity.id;
    try {
      const existing = get().cityId === cityId ? get().stops : [];
      const merged = await mergeBundleFloor(existing);
      if (signal.aborted || useCityStore.getState().activeCity.id !== cityId) return;
      // A newer API snapshot wins over an older asynchronous bundle floor.
      if (get().stops !== previousStops && get().cityId === cityId) return;
      if (merged) set({ stops: merged, cityId });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      reportError(e instanceof Error ? e : new Error(String(e)), {
        context: { where: "stopStore.overlayBundleStops" },
      });
    }
  },

  async upsertStops(newStops: ApiStop[], opts?: { isStale?: () => boolean; cityId?: string }) {
    const cityId = opts?.cityId ?? useCityStore.getState().activeCity.id;
    const signal = stopCacheAbort.signal;
    const isStale = () => signal.aborted || opts?.isStale?.() || useCityStore.getState().activeCity.id !== cityId;
    if (isStale()) return;
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
        cityId,
        name: s.name,
        location: s.location ?? { lat: s.lat!, lon: s.lon! },
        parentStationId: s.parentStationId,
        labelAnchor: s.labelAnchor,
        lastSeen: now,
        lines,
      };
    });

    const existing = get().cityId === cityId ? get().stops : [];
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
      set({ stops: merged, cityId });
    }
    await waitForActivation(signal);
    if (isStale()) return;
    // The verified catalog already owns offline stop/route data. Persisting
    // a second full API projection on every visit duplicates that data and
    // can stall the next city's artifact reads. API display enrichment stays
    // in memory; only API-only fallback sessions need this legacy snapshot.
    if (useCityDataStore.getState().active?.token.cityId === cityId) return;
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
        if (isStale()) return;
        await cityDataWrite([db.stops], signal, async () => {
          const previous = await db.stops.toCollection().first();
          if (isStale()) throw new DOMException("Stop cache changed", "AbortError");
          // Keep one bounded API snapshot. Replace a foreign snapshot together
          // with the new rows, after memory has already painted, never on selection.
          if (previous && previous.cityId !== cityId) await db.stops.clear();
          if (isStale()) throw new DOMException("Stop cache changed", "AbortError");
          await db.stops.bulkPut(records);
          if (isStale()) throw new DOMException("Stop cache changed", "AbortError");
        });
      } catch (e) {
        if (isStale()) return;
        reportError(e instanceof Error ? e : new Error(String(e)), {
          context: {
            where: "stopStore.upsertStops.bulkPut",
            count: records.length,
          },
        });
      }
    }
    // No post-write reset: it could erase a newer city's already-installed
    // memory. Every memory write above was synchronous under the captured city;
    // stale disk rows carry their owner and cannot be read as another city.
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
    stopCacheAbort.abort();
    stopCacheAbort = new AbortController();
    // Owned disk rows remain available until optional replacement succeeds.
    // Readers reject foreign owners; selection itself does no IndexedDB work.
    set({ stops: [], hydrated: true, cityId: useCityStore.getState().activeCity.id });
  },
}));

if (import.meta.hot) import.meta.hot.dispose(() => stopCacheAbort.abort());
