import { validPedestrianRoute } from "./pedestrianEvidence.ts";
import type { LatLon } from "@pt/shared";
import type { WalkRoute } from "./walkGraphClient.ts";
import type { RtComposedItinerary } from "./rtOverlay.ts";

export interface DirectWalkCandidate extends RtComposedItinerary {
  directWalk: { origin: LatLon; destination: LatLon; route: WalkRoute };
}

/** Accept routed pedestrian evidence only; never infer a path from proximity. */
export function directWalkCandidate(
  origin: LatLon, destination: LatLon, route: WalkRoute | null,
  departureSecs: number, walkSpeedMps: number,
): DirectWalkCandidate | null {
  if (!validPedestrianRoute(route)
    || !Number.isFinite(walkSpeedMps) || walkSpeedMps <= 0
    || !Number.isFinite(departureSecs)) return null;
  const duration = Math.ceil(route.distanceMeters / walkSpeedMps);
  return {
    directWalk: { origin, destination, route }, legs: [],
    sourceWalkSecs: 0, destWalkSecs: 0, departureSecs,
    arrivalSecs: departureSecs + duration, totalSecs: duration,
    totalWalkSecs: duration, totalWalkMeters: route.distanceMeters, transfers: 0,
  };
}
