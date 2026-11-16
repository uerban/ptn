import type { RaptorTransitLeg } from "@pt/shared";
import type { RtComposedItinerary } from "./rtOverlay.ts";

/** Validate effective times before ranking. Warnings do not make a broken
 * connection feasible. Shift walking within available slack, never transit. */
export function feasibleRtCandidates(results: RtComposedItinerary[], transferFloor?: (from: RaptorTransitLeg, to: RaptorTransitLeg) => number | null): RtComposedItinerary[] {
  return results.flatMap((itinerary): RtComposedItinerary[] => {
    if (itinerary.cancelled || itinerary.timingUnreliable) return [];
    let previousArrival = itinerary.departureSecs + itinerary.sourceWalkSecs;
    const legs = [];
    let priorTransit: RaptorTransitLeg | undefined;
    for (const original of itinerary.legs) {
      let leg = original;
      if (!Number.isFinite(leg.departSecs) || !Number.isFinite(leg.arriveSecs) || leg.arriveSecs < leg.departSecs) return [];
      if (leg.type === "walk" && leg.departSecs < previousArrival) {
        const duration = leg.arriveSecs - leg.departSecs;
        leg = { ...leg, departSecs: previousArrival, arriveSecs: previousArrival + duration };
      }
      if (leg.departSecs < previousArrival) return [];
      if (leg.type === "transit") {
        if (priorTransit && transferFloor) {
          const floor = transferFloor(priorTransit, leg);
          if (floor === null || leg.departSecs < priorTransit.arriveSecs + floor) return [];
        }
        priorTransit = leg;
      }
      legs.push(leg);
      previousArrival = leg.arriveSecs;
    }
    if (legs.length === 0) return [itinerary];
    const arrivalSecs = previousArrival + itinerary.destWalkSecs;
    return [{ ...itinerary, legs, arrivalSecs, totalSecs: arrivalSecs - itinerary.departureSecs }];
  });
}
