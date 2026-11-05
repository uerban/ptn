import type { LatLon } from "@pt/shared";
import { DEFAULT_WALK_SPEED_MPS } from "@pt/shared/constants";

interface StopLocation {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface ReachableStop {
  stopId: string;
  walkSecs: number;
  distanceMeters: number;
  /** True if this stop is only reachable by running (beyond normal walk budget) */
  runToCatch?: boolean;
}

/**
 * Lookup over the pre-computed pedestrian transfer table. Callers query
 * stop-to-stop walk times; the implementation returns the table's value
 * when both stops are represented, or `undefined` otherwise.
 */
export interface OsmTransferLookup {
  getWalkSecs(fromStopId: string, toStopId: string): number | undefined;
}

export interface FindStopsOptions {
  /**
   * Stop the origin "snaps" to — typically populated when the origin
   * endpoint is itself a GTFS stop (kind === "stop"). Used as the
   * `from`-id for the OSM transfer-table lookup: walk seconds are read
   * for the directed pair `(originStopId, candidate)`. Mutually
   * exclusive with `destStopId` (passing both throws).
   */
  originStopId?: string;
  /**
   * Stop the *destination* endpoint snaps to. When set, the transfer
   * lookup is reversed — walk seconds are read for the directed pair
   * `(candidate, destStopId)`, i.e. "candidate stop → destination".
   * Mutually exclusive with `originStopId`. The OSRM-engine artifact
   * preserves per-row directed durations rather than symmetrizing, so
   * looking up the wrong direction for exit-walk gives wrong cost or
   * drops the pair entirely.
   */
  destStopId?: string;
  /**
   * Pre-computed pedestrian transfer table. When provided alongside
   * `originStopId` or `destStopId`, the table's `walkSecs` replaces
   * haversine for any covered stop. Stops outside the table fall back
   * to haversine.
   */
  osmLookup?: OsmTransferLookup;
}

/**
 * Equirectangular approximation of distance between two points in meters.
 * Accurate enough for short distances (< 10km).
 */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const avgLat = ((lat1 + lat2) / 2) * toRad;
  const dx = (lon2 - lon1) * toRad * Math.cos(avgLat) * 6_371_000;
  const dy = (lat2 - lat1) * toRad * 6_371_000;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Find stops within a radius of a point and compute walking times.
 *
 * Uses straight-line distance as approximation. OSRM WASM provides more
 * accurate walking distances when available (see isochrone.ts).
 *
 * When `options.osmLookup` is provided alongside `originStopId` (entry-
 * walk: from endpoint to candidate) or `destStopId` (exit-walk: from
 * candidate to endpoint), candidates covered by the pre-computed
 * pedestrian transfer table use the table's `walkSecs` for the correct
 * directed pair. Stops absent from the table fall back to haversine,
 * preserving radius semantics. Passing both `originStopId` and
 * `destStopId` is an error.
 *
 * The artifact's `walkSecs` are emitted at the builder's walking speed
 * (DEFAULT_WALK_SPEED_MPS, matching `scripts/build-transfers.mjs` defaults).
 * The consumer recovers physical distance and rescales to the caller's
 * `walkSpeedMps` so slower profiles (wheelchair) get realistic walk-time
 * and distance budgets. Without this rescaling a wheelchair user would
 * see the same walk time as a default-speed user for any covered pair.
 *
 * Returns stops sorted by walk time ascending.
 */
export function findStopsInRadius(
  origin: LatLon,
  stops: StopLocation[],
  radiusMeters: number,
  walkSpeedMps: number,
  options?: FindStopsOptions,
): ReachableStop[] {
  const results: ReachableStop[] = [];
  const lookup = options?.osmLookup;
  const originStopId = options?.originStopId;
  const destStopId = options?.destStopId;
  if (originStopId !== undefined && destStopId !== undefined) {
    throw new Error(
      "findStopsInRadius: pass originStopId (entry-walk) or destStopId (exit-walk), not both",
    );
  }
  const endpointStopId = originStopId ?? destStopId;
  const lookupReversed = destStopId !== undefined;

  for (const stop of stops) {
    let walkSecs: number;
    let distanceMetersOut: number;

    let osmSecs: number | undefined;
    if (lookup && endpointStopId !== undefined) {
      if (endpointStopId === stop.id) {
        osmSecs = 0;
      } else {
        osmSecs = lookupReversed
          ? lookup.getWalkSecs(stop.id, endpointStopId)
          : lookup.getWalkSecs(endpointStopId, stop.id);
      }
    }

    if (osmSecs !== undefined) {
      // The artifact's walkSecs are measured at the builder's walking
      // speed; recover physical meters from that, check against the
      // radius budget in meters, then rescale to the caller's speed.
      const distanceM = osmSecs * DEFAULT_WALK_SPEED_MPS;
      if (distanceM > radiusMeters) continue;
      walkSecs = Math.round(distanceM / walkSpeedMps);
      distanceMetersOut = Math.round(distanceM);
    } else {
      const dist = distanceMeters(origin.lat, origin.lon, stop.lat, stop.lon);
      if (dist > radiusMeters) continue;
      walkSecs = Math.round(dist / walkSpeedMps);
      distanceMetersOut = Math.round(dist);
    }

    results.push({
      stopId: stop.id,
      walkSecs,
      distanceMeters: distanceMetersOut,
    });
  }

  results.sort((a, b) => a.walkSecs - b.walkSecs);
  return results;
}
