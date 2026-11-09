import { useCallback, useEffect, useRef } from "react";
import { buildLinePatterns } from "../utils/buildLinePatterns.ts";
import { tripDirectionId } from "../services/nearbyDirections.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { useLineViewStore, type LinePattern } from "../stores/lineViewStore.ts";

/** GTFS `direction_id` of `tripId` in the loaded index (see `tripDirectionId`). */
function loadedTripDirectionId(routeId: string, tripId: string): 0 | 1 | undefined {
  const index = useGtfsDataStore.getState().raptorIndex;
  return index ? tripDirectionId(index, routeId, tripId) : undefined;
}

/**
 * The pattern to show first. `trip_headsign` is rider-facing text that the two
 * directions of a route may share; `direction_id` is what tells them apart
 * (https://gtfs.org/documentation/schedule/reference/#tripstxt). So a known
 * trip direction picks among that direction's patterns (the branch with the
 * headsign, else its first); the headsign alone decides only when the
 * direction is unknown or no pattern carries it; else the first pattern.
 */
function initialDirection(
  patterns: LinePattern[],
  headsign: string,
  direction: 0 | 1 | undefined,
): number {
  if (direction !== undefined) {
    let first = -1;
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].gtfsDirectionId !== direction) continue;
      if (patterns[i].headsign === headsign) return i;
      if (first < 0) first = i;
    }
    if (first >= 0) return first;
  }
  const byHeadsign = patterns.findIndex((p) => p.headsign === headsign);
  return byHeadsign >= 0 ? byHeadsign : 0;
}

/**
 * Encapsulates the async load-and-show-line-view pattern with
 * stale-request cancellation.  Returns a stable `openLine` handler
 * and a `cancel` function that invalidates any in-flight load.
 *
 * `openLine` shows the line in the direction of `tripId` when given and the
 * index knows it (a departure's own trip: the trip sheet), else in the first
 * direction with `headsign` (a line group: the stop popup, the departure
 * sheet). It resolves to whether it showed the line: false for a route
 * without patterns, a failed load, or a load cancelled or superseded before
 * it finished. True also when the line was already on screen — a re-show
 * that changes neither `isVisible` nor `activeRouteId` (it does set fresh
 * `patterns`, and may flip `activeDirection`), so an effect keyed on those two
 * does not fire.
 */
export function useLineClick() {
  const idRef = useRef(0);

  // Cancel any in-flight load on unmount
  useEffect(() => () => { ++idRef.current; }, []);

  const openLine = useCallback(
    async (
      routeId: string,
      routeShortName: string,
      routeColor: string | undefined,
      headsign: string,
      tripId?: string,
    ): Promise<boolean> => {
      const requestId = ++idRef.current;
      try {
        // Read before the load's first await, as `buildLinePatterns` reads
        // the index: both from the same index.
        const direction = tripId === undefined ? undefined : loadedTripDirectionId(routeId, tripId);
        const patterns = await buildLinePatterns(routeId);
        if (requestId !== idRef.current) return false;
        if (patterns.length === 0) {
          console.warn(
            `[useLineClick] buildLinePatterns returned empty for route ${routeId} ("${routeShortName}") — line view will not open`,
          );
          return false;
        }
        useLineViewStore
          .getState()
          .showLine(
            routeId,
            routeShortName,
            routeColor ?? null,
            patterns,
            initialDirection(patterns, headsign, direction),
          );
        return true;
      } catch (err) {
        console.error("Failed to load line patterns", err);
        return false;
      }
    },
    [],
  );

  const cancel = useCallback(() => { ++idRef.current; }, []);

  return { openLine, cancel };
}
