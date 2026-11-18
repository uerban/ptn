import { useCallback, useEffect, useRef, useState } from "react";
import type { Departure, GuidancePhase, LatLon, RiderCandidate, Stop } from "@pt/shared";
import { PEDESTRIAN_SPEED_THRESHOLD_MS } from "@pt/shared/constants";
import { haversineDistance } from "../utils/geo.ts";
import { findStopContextCandidates } from "./useRiderModeDetection.ts";

/** How close the rider must have been to the viewed stop to be boarding there. */
export const STOP_CONTEXT_RADIUS_M = 150;

interface ViewedStop {
  stop: Stop;
  departures: Departure[];
  wasNear: boolean;
}

interface StopContextRiderPromptInput {
  stop: Stop | null;
  departures: Departure[];
  position: LatLon | null;
  speed: number | null;
  phase: GuidancePhase;
}

interface StopContextRiderPrompt {
  candidates: RiderCandidate[];
  /** Closes the prompt; the trips it offered are not offered again. */
  dismiss: () => void;
}

/**
 * Offers rider mode when someone who was at the stop they last viewed starts
 * moving at vehicle speed. The viewed stop outlives its popup, so boarding
 * after closing the popup still counts.
 */
export function useStopContextRiderPrompt({
  stop,
  departures,
  position,
  speed,
  phase,
}: StopContextRiderPromptInput): StopContextRiderPrompt {
  const [candidates, setCandidates] = useState<RiderCandidate[]>([]);
  const viewedRef = useRef<ViewedStop | null>(null);
  const answeredTripIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!stop || departures.length === 0) return;
    const previous = viewedRef.current;
    viewedRef.current = {
      stop,
      departures,
      wasNear: previous?.stop.id === stop.id && previous.wasNear,
    };
  }, [stop, departures]);

  useEffect(() => {
    if (phase !== "idle") {
      setCandidates((current) => (current.length > 0 ? [] : current));
      return;
    }

    const viewed = viewedRef.current;
    if (!viewed) return;
    if (position && haversineDistance(position, viewed.stop.location) <= STOP_CONTEXT_RADIUS_M) {
      viewed.wasNear = true;
    }
    if (!viewed.wasNear) return;
    if (speed === null || speed < PEDESTRIAN_SPEED_THRESHOLD_MS) return;

    const next = findStopContextCandidates(viewed.departures, new Date())
      .filter((candidate) => !answeredTripIdsRef.current.has(candidate.tripId));
    if (next.length > 0) setCandidates(next);
  }, [stop, departures, position, speed, phase]);

  const dismiss = useCallback(() => {
    for (const candidate of candidates) answeredTripIdsRef.current.add(candidate.tripId);
    setCandidates([]);
  }, [candidates]);

  return { candidates, dismiss };
}
