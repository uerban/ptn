import { useEffect, useRef } from "react";
import type { Leg, LatLon, Departure, RiderCandidate } from "@pt/shared";
import {
  VEHICLE_SPEED_THRESHOLD_MS,
  STOP_CONTEXT_WINDOW_MS,
  MAX_RIDER_CANDIDATES,
  LEG_ARRIVAL_RADIUS_M,
} from "@pt/shared/constants";
import { haversineDistance } from "../utils/geo.ts";
import { useGuidanceStore } from "../stores/guidanceStore.ts";

/** Auto-activate rider mode during navigation when user boards transit */
export function shouldAutoActivateRider(
  leg: Leg,
  position: LatLon,
  speed: number | null
): boolean {
  if (leg.mode === "WALK" || leg.mode === "BIKE" || leg.mode === "SCOOTER") {
    return false;
  }
  if (!leg.tripId) return false;
  if (speed === null || speed < VEHICLE_SPEED_THRESHOLD_MS) return false;

  const distToStart = haversineDistance(position, leg.from.location);
  return distToStart < LEG_ARRIVAL_RADIUS_M * 4; // wider radius for boarding
}

/** Find candidates for stop-context rider mode prompt */
export function findStopContextCandidates(
  departures: Departure[],
  now: Date
): RiderCandidate[] {
  const windowEnd = new Date(now.getTime() + STOP_CONTEXT_WINDOW_MS);

  const inWindow = departures.filter((d) => {
    const depTime = new Date(d.predictedTime ?? d.scheduledTime);
    return depTime >= now && depTime <= windowEnd;
  });

  // Skip if too many candidates (ambiguous)
  if (inWindow.length > MAX_RIDER_CANDIDATES) return [];

  return inWindow.map((d) => ({
    tripId: d.tripId,
    routeShortName: d.routeShortName,
    headsign: d.headsign,
    departureTime: d.predictedTime ?? d.scheduledTime,
    routeColor: d.routeColor,
  }));
}

/**
 * Hook that monitors conditions for automatic rider mode activation.
 *
 * Path 1 (manual): handled by UI tap handler, not this hook.
 * Path 2 (navigation): auto-activates when on a transit leg and speed exceeds threshold.
 * Path 3 (stop context): activated via RiderModePrompt component using findStopContextCandidates.
 */
export function useRiderModeDetection(
  position: LatLon | null,
  speed: number | null
): void {
  const phase = useGuidanceStore((s) => s.phase);
  const itinerary = useGuidanceStore((s) => s.itinerary);
  const currentLegIndex = useGuidanceStore((s) => s.currentLegIndex);
  const activatedRef = useRef(false);

  // Reset activation flag on leg change
  useEffect(() => {
    activatedRef.current = false;
  }, [currentLegIndex]);

  // Path 2: Navigation auto-activation
  useEffect(() => {
    if (phase !== "navigating" || !itinerary || !position || activatedRef.current) {
      return;
    }

    const leg = itinerary.legs[currentLegIndex];
    if (!leg || !leg.tripId) return;

    if (shouldAutoActivateRider(leg, position, speed)) {
      activatedRef.current = true;
      useGuidanceStore.getState().enterRiderMode("navigation", leg.tripId);
    }
  }, [phase, itinerary, currentLegIndex, position, speed]);
}
