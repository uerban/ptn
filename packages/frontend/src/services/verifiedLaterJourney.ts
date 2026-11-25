import type { Itinerary, Leg } from "@pt/shared";

function hasExactRide(leg: Leg): boolean {
  const { boardStopIdx, alightStopIdx, patternStopIds } = leg;
  return !!leg.tripId && !leg.approximate &&
    !!leg.from.stopId && !!leg.to.stopId &&
    boardStopIdx !== undefined && alightStopIdx !== undefined &&
    boardStopIdx >= 0 && alightStopIdx > boardStopIdx &&
    patternStopIds?.[boardStopIdx] === leg.from.stopId &&
    patternStopIds?.[alightStopIdx] === leg.to.stopId;
}

function hasValidTimeline(itinerary: Itinerary, earliestLeaveMs: number, deadlineMs: number): boolean {
  let previousArrival = Date.parse(itinerary.departureTime);
  const firstLeg = itinerary.legs[0];
  // A plan starting at its boarding stop can carry search-window waiting
  // before the first leg. The first actual movement must still be reachable.
  if (!firstLeg || !Number.isFinite(previousArrival) ||
    !(Date.parse(firstLeg.departureTime) >= earliestLeaveMs)) return false;

  for (const leg of itinerary.legs) {
    const departure = Date.parse(leg.departureTime);
    const arrival = Date.parse(leg.arrivalTime);
    if (!(departure >= previousArrival && arrival >= departure)) return false;
    if (leg.mode !== "WALK" && !hasExactRide(leg)) return false;
    previousArrival = arrival;
  }
  return previousArrival === Date.parse(itinerary.arrivalTime) && previousArrival <= deadlineMs;
}

export interface LaterJourneyConstraints {
  earliestLeaveMs: number;
  arriveByMs?: number;
}

/**
 * Select one fallback from complete results already planned and validated for
 * the same endpoints and rider settings. Keeps the selected trip and every
 * onward leg intact. A boarding-stop departure lookup cannot supply candidates.
 */
export function selectVerifiedLaterJourney(
  primary: Itinerary,
  planned: readonly Itinerary[],
  { earliestLeaveMs, arriveByMs = Infinity }: LaterJourneyConstraints,
): Itinerary | null {
  const firstRide = primary.legs.find((leg) => leg.mode !== "WALK");
  if (!firstRide?.routeId || !hasExactRide(firstRide)) return null;
  const primaryBoarding = Date.parse(firstRide.departureTime);
  let best: Itinerary | null = null;
  let bestBoarding = Infinity;

  for (const candidate of planned) {
    if (candidate.cancelled || candidate.timingUnreliable) continue;
    const ride = candidate.legs.find((leg) => leg.mode !== "WALK");
    if (!ride || ride.tripId === firstRide.tripId || ride.mode !== firstRide.mode ||
      ride.routeId !== firstRide.routeId || ride.from.stopId !== firstRide.from.stopId ||
      ride.to.stopId !== firstRide.to.stopId) continue;
    const boarding = Date.parse(ride.departureTime);
    if (!(boarding > primaryBoarding && boarding <= bestBoarding)) continue;
    if (!hasValidTimeline(candidate, earliestLeaveMs, arriveByMs)) continue;
    if (boarding === bestBoarding && best &&
      Date.parse(candidate.arrivalTime) >= Date.parse(best.arrivalTime)) continue;

    best = candidate;
    bestBoarding = boarding;
  }
  return best;
}


/** Find an already validated itinerary that replaces exactly one ride.
 * Fixed rides keep their trip, stop occurrences and effective times.
 */
export function interchangeableRide(
  primary: Itinerary,
  candidate: Itinerary,
  { earliestLeaveMs, arriveByMs = Infinity }: LaterJourneyConstraints,
): Leg | null {
  if (primary.legs.length !== candidate.legs.length || candidate.cancelled || candidate.timingUnreliable ||
    !hasValidTimeline(candidate, earliestLeaveMs, arriveByMs)) return null;

  let replacement: Leg | null = null;
  let fixedRides = 0;
  for (const [i, original] of primary.legs.entries()) {
    const next = candidate.legs[i];
    if (original.from.stopId !== next.from.stopId || original.to.stopId !== next.to.stopId ||
      original.from.location.lat !== next.from.location.lat || original.from.location.lon !== next.from.location.lon ||
      original.to.location.lat !== next.to.location.lat || original.to.location.lon !== next.to.location.lon) return null;

    if (original.mode === "WALK" || next.mode === "WALK") {
      if (original.mode !== next.mode || original.durationSeconds !== next.durationSeconds ||
        !!original.runToCatch !== !!next.runToCatch) return null;
      continue;
    }

    if (!hasExactRide(original) || !original.routeId || !next.routeId) return null;
    if (original.tripId === next.tripId) {
      if (original.routeId !== next.routeId || original.boardStopIdx !== next.boardStopIdx ||
        original.alightStopIdx !== next.alightStopIdx || original.departureTime !== next.departureTime ||
        original.arrivalTime !== next.arrivalTime) return null;
      fixedRides++;
      continue;
    }
    if (replacement || original.inSeat || next.inSeat || primary.legs[i + 1]?.inSeat || candidate.legs[i + 1]?.inSeat) return null;
    replacement = next;
  }
  return fixedRides > 0 ? replacement : null;
}
