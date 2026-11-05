import type { BaseEndpoint } from "@pt/shared";
import { findStopsInRadius, type OsmTransferLookup, type ReachableStop } from "./stopFinder.ts";

export interface ResolveOptions {
  maxWalkSecs: number;
  walkSpeedMps: number;
  /**
   * Pre-computed pedestrian transfer table. When provided alongside a
   * `stop`-kind endpoint, `findStopsInRadius` uses the table's walk
   * seconds in place of haversine for any covered destination stop.
   * Stops outside the table fall back to haversine.
   */
  osmLookup?: OsmTransferLookup;
  /**
   * Which side of the journey this endpoint represents. "origin"
   * (default) reads the transfer table in the entry-walk direction
   * `(endpoint → candidate)`; "destination" reads the exit-walk
   * direction `(candidate → endpoint)`. The two are equivalent only
   * for engines that emit symmetric durations.
   */
  role?: "origin" | "destination";
}

interface StopLocation {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/**
 * Resolve a route endpoint to the set of stops a passenger can board from.
 *
 * For a `stop` endpoint, the stop itself is always included with walkSecs=0
 * — even if the stop falls outside the walk radius (e.g., the user explicitly
 * picked it from a list). Nearby stops within the walk radius are appended.
 *
 * For `mappoint` / `geocoded` endpoints, only stops within the walk radius
 * are returned.
 */
export function resolveToEntryStops(
  ep: BaseEndpoint,
  stops: StopLocation[],
  opts: ResolveOptions,
): ReachableStop[] {
  const endpointStopId = ep.kind === "stop" ? ep.stopId : undefined;
  const role = opts.role ?? "origin";
  const nearby = findStopsInRadius(
    { lat: ep.lat, lon: ep.lon },
    stops,
    opts.maxWalkSecs * opts.walkSpeedMps,
    opts.walkSpeedMps,
    {
      originStopId: role === "origin" ? endpointStopId : undefined,
      destStopId: role === "destination" ? endpointStopId : undefined,
      osmLookup: opts.osmLookup,
    },
  );
  if (ep.kind === "stopGroup") {
    // Force EVERY member to walkSecs:0 (rider is "at the group" and walks the
    // last metres to whichever sibling the route serves), then append radius
    // neighbours minus the members so a member isn't duplicated with a non-zero
    // haversine walk.
    const members = new Set(ep.stopIds);
    const forced = ep.stopIds.map((stopId) => ({
      stopId,
      walkSecs: 0,
      distanceMeters: 0,
    }));
    const rest = nearby.filter((s) => !members.has(s.stopId));
    return [...forced, ...rest];
  }
  if (ep.kind === "stop") {
    const already = nearby.some((s) => s.stopId === ep.stopId);
    return already
      ? nearby
      : [{ stopId: ep.stopId, walkSecs: 0, distanceMeters: 0 }, ...nearby];
  }
  return nearby;
}
