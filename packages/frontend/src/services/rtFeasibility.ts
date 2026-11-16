import type { RtComposedItinerary } from "./rtOverlay.ts";

/** Validate effective times before ranking. Warnings do not make a broken
 * connection feasible. Shift walking within available slack, never transit. */
export function feasibleRtCandidates(results: RtComposedItinerary[]): RtComposedItinerary[] {
  return results.flatMap((itinerary): RtComposedItinerary[] => {
    if (itinerary.cancelled || itinerary.timingUnreliable) return [];
    let previousArrival = itinerary.departureSecs + itinerary.sourceWalkSecs;
    const legs = [];
    for (const original of itinerary.legs) {
      let leg = original;
      if (!Number.isFinite(leg.departSecs) || !Number.isFinite(leg.arriveSecs) || leg.arriveSecs < leg.departSecs) return [];
      if (leg.type === "walk" && leg.departSecs < previousArrival) {
        const duration = leg.arriveSecs - leg.departSecs;
        leg = { ...leg, departSecs: previousArrival, arriveSecs: previousArrival + duration };
      }
      if (leg.departSecs < previousArrival) return [];
      legs.push(leg);
      previousArrival = leg.arriveSecs;
    }
    if (legs.length === 0) return [itinerary];
    const arrivalSecs = previousArrival + itinerary.destWalkSecs;
    return [{ ...itinerary, legs, arrivalSecs, totalSecs: arrivalSecs - itinerary.departureSecs }];
  });
}
