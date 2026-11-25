import type { Leg } from "@pt/shared";
import type { NextDeparture } from "./nextDeparture.ts";
import type { RaptorIndex } from "./raptorIndex.ts";

const WARNING_WINDOW_MS = 20 * 60_000;

/** Confirm a scheduled same-direction departure from the same platform skips the intended stop. */
export function branchDepartureWarning(index: RaptorIndex, planned: Leg, next: NextDeparture): boolean {
  const board = planned.from.stopId;
  const alight = planned.to.stopId;
  const earlier = Date.parse(planned.departureTime);
  const gap = next.departureMs - earlier;
  if (!board || !alight || !planned.routeId || !planned.headsign || planned.approximate ||
    !next.headsign || next.headsign === planned.headsign || next.tripId === planned.tripId ||
    next.isApproximate || !(gap > 0 && gap <= WARNING_WINDOW_MS)) return false;

  const patterns = (index.patternsAtStop?.get(board) ?? []).flatMap((position) => {
    const pattern = index.patterns?.[position];
    return pattern && pattern.id === planned.routeId ? [pattern] : [];
  });
  const plannedTrip = patterns.flatMap((pattern) => pattern.trips).find((trip) => trip.tripId === planned.tripId);
  if (plannedTrip?.directionId === undefined) return false;

  let confirmedBoarding = false;
  for (const pattern of patterns) {
    const trip = pattern.trips.find((candidate) => candidate.tripId === next.tripId);
    if (!trip || trip.directionId !== plannedTrip.directionId) continue;
    for (const [position, stop] of pattern.stopIds.entries()) {
      if (stop !== board || !(trip.departureSecs[position] >= 0) || trip.pickupTypes?.[position] === 1) continue;
      confirmedBoarding = true;
      if (pattern.stopIds.some((id, later) => later > position && id === alight && trip.departureSecs[later] >= 0)) {
        return false;
      }
    }
  }
  return confirmedBoarding;
}
