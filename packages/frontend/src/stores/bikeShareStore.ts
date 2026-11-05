import { create } from "zustand";
import type { CityConfig, SharedMobilitySystem } from "../config/cities.ts";
import {
  fetchDiscovery,
  fetchStationInformation,
  fetchStationStatus,
  mergeStations,
  type GbfsFeedUrls,
} from "../services/gbfs/client.ts";
import type { GbfsStation, GbfsStationInformationRow } from "../services/gbfs/types.ts";
import { readGbfsSystem, writeGbfsSystem } from "../db/index.ts";

/**
 * Session-only store driving the opt-in GBFS bike-share map layer.
 *
 * Lifecycle on `enable(city)`:
 *
 * 1. Dexie-cached station positions (if any) render instantly —
 *    `offline-cached`, null counts, grey markers.
 * 2. Discovery → station_information + station_status fetched and merged —
 *    `live`. Fresh info (positions only) is persisted to Dexie.
 * 3. A {@link STATUS_POLL_INTERVAL_MS} interval re-fetches station_status
 *    only; station_information is re-fetched (and re-persisted) only once
 *    older than {@link INFO_TTL_MS}. Discovery is resolved once per enable —
 *    unless the initial cycle failed entirely, in which case each tick
 *    retries the full cycle so the layer recovers when the network returns.
 * 4. `disable()` clears the interval and unmounts the layer but keeps
 *    in-memory stations for a cheap re-toggle; a later `enable` of the same
 *    city reuses them (positions only — old counts are stripped) and
 *    refreshes.
 *
 * Degradation: any feed-level failure keeps whatever positions we have and
 * nulls the counts (`offline-cached`); with nothing to show it is `error`.
 *
 * SCOPE: the layer drives ONE operator per city — the first
 * `CityConfig.sharedMobility` entry. Supporting several concurrently needs
 * per-system station namespacing (colliding `station_id`s across operators)
 * and per-system degradation; neither exists yet, so further entries are
 * deliberately ignored rather than half-merged.
 *
 * PRIVACY: deliberately NOT persisted (no zustand `persist`) — the toggle is
 * session-only, so no request ever leaves for the operator on app start; the
 * first fetch happens inside `enable()`, i.e. after the user's explicit
 * opt-in tap. Live availability is never written to Dexie (the persisted row
 * type has no availability fields).
 */

/** station_status repoll period (Cyclocity serves TTL 1 s; 60 s is polite). */
export const STATUS_POLL_INTERVAL_MS = 60_000;
/** station_information re-fetch period (client-side constant, not feed TTL). */
export const INFO_TTL_MS = 300_000;

export type BikeShareStatus = "idle" | "loading" | "live" | "offline-cached" | "error";

interface BikeShareState {
  /** Layer toggle; session-only, never persisted. */
  enabled: boolean;
  /** City the current stations belong to (kept across disable for reuse). */
  cityId: string | null;
  /** The enabled city's configured operators (only the first one is live). */
  systems: readonly SharedMobilitySystem[];
  /** Stations of the active (first configured) system, info-feed order. */
  stations: readonly GbfsStation[];
  status: BikeShareStatus;
  /** Epoch ms of the last successful live merge; null before the first. */
  lastUpdated: number | null;
  /**
   * Station open in the tap sheet (`BikeShareStationSheet`), or null.
   * Session-only like everything else here; cleared on disable and on city
   * switch. May go stale against `stations` mid-refresh — readers must treat
   * an id with no matching station as "no selection".
   */
  selectedStationId: string | null;
  /**
   * Turn the layer on for `city`. Resolves once the initial fetch cycle has
   * settled (state is `live`, `offline-cached`, or `error`). Safe to call
   * again with another city — the previous session is torn down first.
   */
  enable: (city: CityConfig) => Promise<void>;
  /** Turn the layer off: stop polling, keep in-memory state for re-toggle. */
  disable: () => void;
  /** Open the station sheet for `stationId` (tap on a bike marker). */
  selectStation: (stationId: string) => void;
  /** Close the station sheet. */
  clearStationSelection: () => void;
}

/** Active-system session context; null until a full cycle has succeeded. */
interface SystemRuntime {
  readonly system: SharedMobilitySystem;
  readonly feedUrls: GbfsFeedUrls;
  infoRows: readonly GbfsStationInformationRow[];
  /** Epoch ms of the last station_information fetch (TTL anchor). */
  infoFetchedAt: number;
}

/** Strip live status off a station: positions kept, counts null (grey). */
function toPositionOnly(station: GbfsStation): GbfsStation {
  return {
    ...station,
    bikesAvailable: null,
    docksAvailable: null,
    isRenting: false,
    isReturning: false,
    lastReported: null,
  };
}

export const useBikeShareStore = create<BikeShareState>()((set, get) => {
  // Non-reactive session internals. `generation` invalidates every in-flight
  // continuation on disable/re-enable/city-switch: each async step compares
  // its captured value and bails when stale, so a late-resolving fetch can
  // never clobber a newer session's state (disable-mid-flight guard).
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let runtime: SystemRuntime | null = null;
  // Overlap guard: a tick that outlives its interval (slow feed) must not
  // race the next one — out-of-order status writes would flap the UI.
  let ticking = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Fire-and-forget Dexie persist; a cache write failure must not break polling. */
  function persistInfo(
    cityId: string,
    systemId: string,
    info: readonly GbfsStationInformationRow[],
  ): void {
    // An empty-but-valid info feed (operator glitch) must not overwrite good
    // cached positions with nothing.
    if (info.length === 0) return;
    void writeGbfsSystem(cityId, systemId, info).catch((err) => {
      console.warn("[bikeShareStore] failed to cache station info:", err);
    });
  }

  /**
   * Feed-level failure → degrade, never throw: keep whatever positions are
   * on screen with counts nulled (`offline-cached`); with nothing to keep,
   * `error`. Stale counts are worse than none, so live numbers never survive
   * a failed refresh. The error (typically a `GbfsError` carrying kind,
   * status and URL) is logged for diagnosis — every kind degrades the same.
   */
  function degrade(err: unknown): void {
    console.warn("[bikeShareStore] GBFS refresh failed:", err);
    const stations = get().stations;
    if (stations.length > 0) {
      set({ stations: stations.map(toPositionOnly), status: "offline-cached" });
    } else {
      set({ status: "error" });
    }
  }

  /**
   * Full cycle: discovery + info + status for the active system. Runs once
   * per enable when it succeeds; a failed run leaves `runtime` null so the
   * next tick retries the whole cycle (recovery).
   */
  async function fullRefresh(
    g: number,
    cityId: string,
    system: SharedMobilitySystem,
  ): Promise<void> {
    try {
      const feedUrls = await fetchDiscovery(system.gbfsDiscoveryUrl);
      if (g !== generation) return;
      const [info, status] = await Promise.all([
        fetchStationInformation(feedUrls.stationInformation),
        fetchStationStatus(feedUrls.stationStatus),
      ]);
      if (g !== generation) return;
      runtime = { system, feedUrls, infoRows: info, infoFetchedAt: Date.now() };
      persistInfo(cityId, system.id, info);
      set({ stations: mergeStations(info, status), status: "live", lastUpdated: Date.now() });
    } catch (err) {
      if (g === generation) degrade(err);
    }
  }

  /**
   * Interval body. With a live runtime: status-only repoll, info riding
   * along once its TTL lapsed (discovery is never redone — feed URLs are
   * session-stable). Without one — the initial cycle never succeeded — the
   * tick retries the full cycle instead, so a failed enable self-heals once
   * the network returns rather than polling into the void.
   */
  async function tick(
    g: number,
    cityId: string,
    system: SharedMobilitySystem,
  ): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      if (runtime === null) {
        await fullRefresh(g, cityId, system);
        return;
      }
      const rt = runtime;
      try {
        if (Date.now() - rt.infoFetchedAt >= INFO_TTL_MS) {
          const info = await fetchStationInformation(rt.feedUrls.stationInformation);
          if (g !== generation) return;
          rt.infoRows = info;
          rt.infoFetchedAt = Date.now();
          persistInfo(cityId, rt.system.id, info);
        }
        const status = await fetchStationStatus(rt.feedUrls.stationStatus);
        if (g !== generation) return;
        set({
          stations: mergeStations(rt.infoRows, status),
          status: "live",
          lastUpdated: Date.now(),
        });
      } catch (err) {
        if (g === generation) degrade(err);
      }
    } finally {
      ticking = false;
    }
  }

  return {
    enabled: false,
    cityId: null,
    systems: [],
    stations: [],
    status: "idle",
    lastUpdated: null,
    selectedStationId: null,

    async enable(city: CityConfig): Promise<void> {
      const g = ++generation;
      clearTimer();
      runtime = null;

      const systems = city.sharedMobility ?? [];
      // Single-operator scope (see module doc): the first entry is the layer.
      const system: SharedMobilitySystem | undefined = systems[0];
      const sameCity = get().cityId === city.id;
      if (!sameCity) {
        // Never show the previous city's stations under the new one.
        set({ stations: [], lastUpdated: null, status: "idle", selectedStationId: null });
      }
      set({ enabled: true, cityId: city.id, systems });

      if (system === undefined) {
        set({ stations: [], status: "idle", lastUpdated: null });
        return;
      }

      // Cheap re-toggle: same city with stations still in memory skips the
      // Dexie read. The kept counts may be arbitrarily old, so they render
      // as positions-only grey until the refresh below lands.
      const reuseInMemory = sameCity && get().stations.length > 0;
      if (reuseInMemory) {
        set({
          stations: get().stations.map(toPositionOnly),
          status: "offline-cached",
        });
      } else {
        let row;
        try {
          row = await readGbfsSystem(city.id, system.id);
        } catch (err) {
          console.warn("[bikeShareStore] failed to read cached stations:", err);
          row = undefined;
        }
        if (g !== generation) return;
        // Cached-first render: positions now, counts when the fetch lands.
        // Cached rows are the persisted wire shape, so the empty-status
        // merge gives exactly the null-count conservative-flag stations.
        if (row !== undefined && row.stations.length > 0) {
          set({ stations: mergeStations(row.stations, []), status: "offline-cached" });
        } else {
          set({ status: "loading" });
        }
      }

      await fullRefresh(g, city.id, system);
      if (g !== generation) return;
      // Start polling even when the initial cycle failed: tick() retries the
      // full cycle while `runtime` is null, so the layer recovers by itself.
      timer = setInterval(() => {
        void tick(g, city.id, system);
      }, STATUS_POLL_INTERVAL_MS);
    },

    disable(): void {
      generation++; // invalidate in-flight continuations
      clearTimer();
      // Stations/status stay in memory so re-enabling the same city renders
      // instantly; session-only by construction (nothing persisted). The
      // sheet selection does NOT survive toggle-off.
      set({ enabled: false, selectedStationId: null });
    },

    selectStation(stationId: string): void {
      set({ selectedStationId: stationId });
    },

    clearStationSelection(): void {
      set({ selectedStationId: null });
    },
  };
});
