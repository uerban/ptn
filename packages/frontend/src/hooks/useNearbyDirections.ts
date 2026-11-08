import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Departure, LatLon, StopWithLines } from "@pt/shared";
import { useDepartures } from "./useDepartures.ts";
import { useStopStore } from "../stores/stopStore.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useCityStore } from "../stores/cityStore.ts";
import { haversineDistance } from "../utils/geo.ts";
import {
  assignDeparturesToSides,
  patternDirKeys,
  resolveNearbySides,
  routeSidesAt,
  type PatternDirKeys,
  type Side,
} from "../services/nearbyDirections.ts";
import type { StopForGrouping } from "../services/stopGrouping.ts";

/** The strip only shows a nearest stop within this distance of the user. */
export const NEAREST_STOP_MAX_M = 1000;
/** Another stop must be at least this much closer to replace the current one. */
export const NEAREST_STOP_HYSTERESIS_M = 15;
/**
 * The pairing is resolved again once the user is this far from where it was
 * last resolved, even while the nearest stop stays: the 500 m reverse-stop
 * radius and the "closest to the user" choice are measured from that point.
 * GPS jitter stays well below it.
 */
export const PAIRING_ANCHOR_REFRESH_M = 75;
/** Same look-ahead the single-stop strip always used. */
const ETA_LOOKAHEAD_HOURS = 1;

const NO_SIDES: Side[] = [];
const NO_DEPARTURES = new Map<Side, Departure[]>();
const NO_TRIP_KEYS: Pick<PatternDirKeys, "byTrip"> = { byTrip: new Map() };

interface Nearest {
  stop: StopWithLines;
  /**
   * Where the pairing is resolved from: the user's position when this stop
   * was picked, moved to the live one once that is `PAIRING_ANCHOR_REFRESH_M`
   * away.
   */
  anchor: LatLon;
}

interface PreviousNearest {
  cityId: string;
  stopId: string;
  anchor: LatLon;
}

/**
 * Nearest stop within `NEAREST_STOP_MAX_M`, with hysteresis: `previousId`
 * stays while it is within the cap and no other stop is at least
 * `NEAREST_STOP_HYSTERESIS_M` closer, so standing mid-street does not flip
 * the rows.
 */
function pickNearestStop(
  stops: StopWithLines[],
  position: LatLon,
  previousId: string | null,
): StopWithLines | null {
  let best: StopWithLines | null = null;
  let bestDist = Infinity;
  let previous: StopWithLines | null = null;
  let previousDist = Infinity;
  for (const stop of stops) {
    const d = haversineDistance(position, stop.location);
    if (d < bestDist) {
      best = stop;
      bestDist = d;
    }
    if (stop.id === previousId) {
      previous = stop;
      previousDist = d;
    }
  }
  if (!best || bestDist > NEAREST_STOP_MAX_M) return null;
  if (previous && previousDist <= NEAREST_STOP_MAX_M && bestDist > previousDist - NEAREST_STOP_HYSTERESIS_M) {
    return previous;
  }
  return best;
}

export interface UseNearbyDirectionsArgs {
  /**
   * The strip may show. False → nothing is resolved and nothing is fetched,
   * not even for the nearest stop.
   */
  enabled: boolean;
  position: LatLon | null;
  /**
   * Stops the nearest stop is picked from: the map's visible set, or every
   * downloaded stop of the city where no map is rendered (Text mode).
   */
  visibleStops: StopWithLines[];
  /**
   * The city's stops a reverse stop is looked up in. Defaults to the stop
   * store, which the map fills; Text mode passes the downloaded stops.
   */
  cityStops?: StopWithLines[];
}

export interface NearbyDirections {
  nearestStop: StopWithLines | null;
  sides: Side[];
  departuresBySide: Map<Side, Departure[]>;
  /** The nearest stop's departures are loading; the other stops fill in when ready. */
  loading: boolean;
}

/**
 * The ETA strip's data: the nearest stop `S`, every line at it with its
 * opposite direction (`resolveNearbySides`), and the departures of each side.
 *
 * - `S` is picked over `visibleStops` within 1 km, with 15 m hysteresis; a
 *   city change resets it.
 * - The pairing is resolved from the user's position when `S` was picked,
 *   once per (`S`, index, city), again when the stop store changes (a late
 *   stop can complete a pair), and again once the user is
 *   `PAIRING_ANCHOR_REFRESH_M` from where it was resolved (a rider walking up
 *   to `S` brings the far side within reach). GPS jitter that keeps `S`
 *   neither re-resolves nor refetches.
 * - `S` keeps the pre-existing path, `useDepartures` (tile + rt-tile, and its
 *   policy-gated `departures-for-stop` fallback). Every other side's stop goes
 *   through `departuresForStops`, which is tile-only: asking the server about
 *   several stops around the user would pinpoint them. That batch starts once
 *   `S`'s read has finished, so the two never resolve tiles side by side (the
 *   tile cache has no in-flight dedupe). It is refetched only when the set of
 *   those stops changes, and dropped (aborted between stops, its rows
 *   cleared) when that set changes or the hook is switched off.
 * - Every route at `S` has a side, so no `S` departure is lost: no pattern
 *   index (PatternMode Off, the Dexie fallback) or `S` unknown to it → one
 *   `top` side per route, exactly the single row of before; a route the index
 *   does not list at `S` (index and tiles from different bundles until the
 *   next refresh) gets one too.
 */
export function useNearbyDirections({
  enabled,
  position,
  visibleStops,
  cityStops,
}: UseNearbyDirectionsArgs): NearbyDirections {
  const cityId = useCityStore((s) => s.activeCity.id);
  const raptorIndex = useGtfsDataStore((s) => s.raptorIndex);
  const storedStops = useStopStore((s) => s.stops);
  const allStops = cityStops ?? storedStops;

  // Hysteresis state: the last committed pick, dropped on a city change. Read
  // while rendering, written only once a render commits.
  const previousRef = useRef<PreviousNearest | null>(null);
  const nearest = useMemo<Nearest | null>(() => {
    const prev = previousRef.current?.cityId === cityId ? previousRef.current : null;
    const stop = position ? pickNearestStop(visibleStops, position, prev?.stopId ?? null) : null;
    if (!stop || !position) return null;
    const keepAnchor =
      prev !== null &&
      prev.stopId === stop.id &&
      haversineDistance(prev.anchor, position) < PAIRING_ANCHOR_REFRESH_M;
    return { stop, anchor: keepAnchor ? prev.anchor : position };
  }, [position, visibleStops, cityId]);
  useLayoutEffect(() => {
    previousRef.current = nearest ? { cityId, stopId: nearest.stop.id, anchor: nearest.anchor } : null;
  }, [nearest, cityId]);

  const nearestId = enabled ? nearest?.stop.id ?? null : null;
  const anchor = nearest?.anchor ?? null;

  // The full city set, not only the visible stops: a reverse stop may be off
  // screen. `parentStationId` is only known on server-provided rows.
  const stopLookup = useMemo(() => {
    const byId = new Map<string, StopForGrouping>();
    for (const s of allStops) {
      byId.set(s.id, {
        id: s.id,
        name: s.name,
        lat: s.location.lat,
        lon: s.location.lon,
        ...(s.parentStationId ? { parentStation: s.parentStationId } : {}),
      });
    }
    return byId;
  }, [allStops]);

  const resolved = useMemo(() => {
    if (!nearestId || !anchor || !raptorIndex) return NO_SIDES;
    return resolveNearbySides({
      index: raptorIndex,
      nearestStopId: nearestId,
      user: anchor,
      getStop: (id) => stopLookup.get(id),
    });
    // cityId: resolved once per (S, index, city).
  }, [nearestId, anchor, raptorIndex, stopLookup, cityId]);

  // ETA pills are unprompted (proximity): no polling and no hedge, as before.
  const {
    departures: nearestDepartures,
    loading,
    settledStopId,
  } = useDepartures(nearestId, false, ETA_LOOKAHEAD_HOURS);
  const nearestSettled = nearestId !== null && settledStopId === nearestId && !loading;

  // `nearestDepartures` is always `nearestId`'s: useDepartures empties it in the
  // render the stop changes, so a failed read at a new S never builds sides
  // there from the previous S's lines.
  const sides = useMemo(() => {
    if (!nearestId) return NO_SIDES;
    const routeSides = routeSidesAt(nearestId, nearestDepartures, resolved);
    return routeSides.length === 0 ? resolved : [...resolved, ...routeSides];
  }, [nearestId, nearestDepartures, resolved]);

  // The other stops, as one stable key: the batch refetches only when it changes.
  const otherKey = useMemo(() => {
    const ids = new Set<string>();
    for (const s of resolved) if (s.stopId !== nearestId) ids.add(s.stopId);
    return [...ids].sort().join("\n");
  }, [resolved, nearestId]);

  const [others, setOthers] = useState<{ key: string; byStop: Map<string, Departure[]> } | null>(null);
  useEffect(() => {
    if (!otherKey || !nearestSettled) return;
    const controller = new AbortController();
    void (async () => {
      // Dynamic import, as in useDepartures: keeps the read-path graph out of
      // the eager entry chunk.
      const { departuresForStops } = await import("../services/scheduleTileReadPath.ts");
      if (controller.signal.aborted) return;
      const byStop = await departuresForStops({
        stopIds: otherKey.split("\n"),
        lookAheadHours: ETA_LOOKAHEAD_HOURS,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setOthers({ key: otherKey, byStop });
    })().catch(() => { /* departuresForStops never throws; a failed import leaves the row empty */ });
    return () => {
      controller.abort();
      // Switched off or superseded: these rows are never shown again, not even
      // for the moment a later batch for the same stops takes to land.
      setOthers(null);
    };
  }, [otherKey, nearestSettled]);

  const departuresBySide = useMemo(() => {
    if (!nearestId) return NO_DEPARTURES;
    const byStop = new Map<string, Departure[]>();
    if (others && others.key === otherKey) {
      for (const [stopId, departures] of others.byStop) byStop.set(stopId, departures);
    }
    byStop.set(nearestId, nearestDepartures);
    const keys = raptorIndex ? patternDirKeys(raptorIndex) : NO_TRIP_KEYS;
    return assignDeparturesToSides(sides, byStop, keys, { nearestStopId: nearestId });
  }, [nearestId, others, otherKey, nearestDepartures, raptorIndex, sides]);

  return {
    nearestStop: nearestId ? nearest?.stop ?? null : null,
    sides,
    departuresBySide,
    loading: nearestId ? loading : false,
  };
}
