import type {
  RaptorItinerary,
  ComposedItinerary,
  RankingCriteria,
} from "@pt/shared";

/**
 * Compose RAPTOR itineraries with source/destination walk times.
 *
 * For each RAPTOR itinerary, finds the matching entry and exit walk times
 * and computes the total trip time including walking.
 */
export function composeItineraries(
  itineraries: RaptorItinerary[],
  entryStops: { stopId: string; walkSecs: number; distanceMeters?: number; runToCatch?: boolean }[],
  exitStops: { stopId: string; walkSecs: number; distanceMeters?: number }[],
  departureSecs: number,
): ComposedItinerary[] {
  const entryMap = new Map(entryStops.map((s) => [s.stopId, s.walkSecs]));
  const runEntries = new Set(entryStops.filter((s) => s.runToCatch).map((s) => s.stopId));
  const exitMap = new Map(exitStops.map((s) => [s.stopId, s.walkSecs]));
  const entryMeters = new Map(entryStops.map((s) => [s.stopId, s.distanceMeters]));
  const exitMeters = new Map(exitStops.map((s) => [s.stopId, s.distanceMeters]));

  const composed: ComposedItinerary[] = [];

  for (const itin of itineraries) {
    if (itin.legs.length === 0) continue;

    const firstLeg = itin.legs[0];
    const lastLeg = itin.legs[itin.legs.length - 1];

    const sourceWalkSecs = entryMap.get(firstLeg.fromStopId) ?? 0;
    const destWalkSecs = exitMap.get(lastLeg.toStopId) ?? 0;

    const arrivalSecs = itin.alightSecs + destWalkSecs;
    const totalSecs = arrivalSecs - departureSecs;
    const transferWalks = itin.legs.filter(leg => leg.type === "walk");
    const totalWalkSecs = sourceWalkSecs + destWalkSecs
      + transferWalks.reduce((sum, leg) => sum + leg.arriveSecs - leg.departSecs, 0);
    const distances = transferWalks.map(leg => "distanceMeters" in leg && typeof leg.distanceMeters === "number"
      ? leg.distanceMeters : undefined);
    const transferMetersKnown = distances.every(distance => distance !== undefined);
    const transferMeters = distances.reduce<number>((sum, distance) => sum + (distance ?? 0), 0);
    const sourceMeters = entryMeters.get(firstLeg.fromStopId);
    const destMeters = exitMeters.get(lastLeg.toStopId);

    composed.push({
      sourceWalkSecs,
      ...(runEntries.has(firstLeg.fromStopId) ? { sourceRunToCatch: true } : {}),
      legs: itin.legs,
      destWalkSecs,
      totalSecs,
      departureSecs,
      arrivalSecs,
      transfers: itin.transfers,
      totalWalkSecs,
      ...(sourceMeters !== undefined && destMeters !== undefined && transferMetersKnown
        ? { totalWalkMeters: sourceMeters + destMeters + transferMeters }
        : {}),
    });
  }

  return composed;
}

/**
 * Rank composed itineraries by the given criteria.
 * Returns a new sorted array (does not mutate input).
 */
export function rankResults(
  results: ComposedItinerary[],
  criteria: RankingCriteria,
): ComposedItinerary[] {
  const sorted = [...results];

  switch (criteria) {
    case "fastest":
      sorted.sort((a, b) => a.totalSecs - b.totalSecs);
      break;
    case "fewest_transfers":
      sorted.sort((a, b) => a.transfers - b.transfers || a.totalSecs - b.totalSecs);
      break;
    case "least_walking":
      // Missing evidence must not change the physical ordering of known
      // distances. Incomplete totals follow, ordered by arrival rather than
      // claiming that their pace-dependent walking time measures distance.
      sorted.sort((a, b) => {
        const knownA = Number.isFinite(a.totalWalkMeters) && a.totalWalkMeters! >= 0;
        const knownB = Number.isFinite(b.totalWalkMeters) && b.totalWalkMeters! >= 0;
        if (knownA !== knownB) return knownA ? -1 : 1;
        return (knownA ? a.totalWalkMeters! - b.totalWalkMeters! : 0) || a.totalSecs - b.totalSecs;
      });
      break;
  }

  return sorted;
}
