// RaptorIndex pattern fixtures shared by the nearby-directions, trip-timeline,
// map-strip hook and Home page suites. Lives under src/ rather than
// tests/helpers/ because two of those suites are colocated with their
// subjects inside tsconfig's `rootDir: ./src`, and tsc rejects imports from
// outside the root (TS6059) — the same reason as bikeShareFixtures.ts. Not a
// test file, and nothing in the production import graph reaches it.
import type { RaptorIndex, RaptorIndexRoute } from "../services/raptorIndex.ts";

export interface TripSpec {
  tripId: string;
  /** Defaults to "Centre". */
  headsign?: string;
  /** GTFS `direction_id`; omitted from the trip when not given. */
  directionId?: 0 | 1;
  /**
   * Aligned to the pattern's `stopIds` (`-1` = no time there). Defaults to a
   * trip serving every position: 08:00, two minutes a stop, each further trip
   * ten minutes after the one before.
   */
  departureSecs?: number[];
}

/** One pattern of route `id` over `stopIds`, carrying `trips`. */
export function pattern(id: string, stopIds: string[], trips: TripSpec[]): RaptorIndexRoute {
  return {
    id,
    shortName: id,
    mode: "BUS",
    stopIds,
    trips: trips.map((t, n) => ({
      tripId: t.tripId,
      serviceId: "ALL",
      headsign: t.headsign ?? "Centre",
      ...(t.directionId !== undefined ? { directionId: t.directionId } : {}),
      departureSecs: t.departureSecs ?? stopIds.map((_, i) => 28800 + n * 600 + i * 120),
    })),
  };
}

/** A pattern with one trip in `directionId`, headed `"<id>-<directionId>"`. */
export function directedPattern(id: string, stopIds: string[], tripId: string, directionId: 0 | 1): RaptorIndexRoute {
  return pattern(id, stopIds, [{ tripId, headsign: `${id}-${directionId}`, directionId }]);
}

/**
 * An index over `patterns`, with `patternsAtStop` built as hydrate's scan
 * builds it (one entry per pattern per stop, a loop's repeated stop once).
 * Without `patterns` it has neither field: `PatternMode.Off`, the Dexie
 * fallback. The canonical `routes` view is empty.
 */
export function patternIndex(patterns?: RaptorIndexRoute[]): RaptorIndex {
  const patternsAtStop = new Map<string, number[]>();
  patterns?.forEach((p, idx) => {
    for (const stopId of new Set(p.stopIds)) {
      const arr = patternsAtStop.get(stopId) ?? [];
      arr.push(idx);
      patternsAtStop.set(stopId, arr);
    }
  });
  return {
    routes: [],
    routeIdToIdx: new Map(),
    routesAtStop: new Map(),
    services: new Map(),
    ...(patterns ? { patterns, patternsAtStop } : {}),
  } as unknown as RaptorIndex;
}
