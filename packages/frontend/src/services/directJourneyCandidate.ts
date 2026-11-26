import type { FirstRideConstraint, TransportMode } from "@pt/shared";
import { serviceDayOriginUnix } from "@pt/shared/time";
import { addDaysCivil } from "@pt/shared/util";
import type { RaptorIndex } from "./raptorIndex.ts";
import { resolveActiveServicesForYmd } from "./serviceDay.ts";
import { serviceDayFrame } from "./serviceDayFrame.ts";

type StopAccess = { stopId: string; walkSecs: number };

/** Find one scheduled one-seat witness for the optional exact-trip probe. */
export function findDirectJourneyCandidate(input: {
  index: RaptorIndex;
  entry: StopAccess[];
  exit: StopAccess[];
  departureMs: number;
  deadlineMs: number;
  feedTz: string;
  excludedRoutes: ReadonlySet<string>;
  excludedModes: ReadonlySet<TransportMode>;
  wheelchair: boolean;
  isTripUnavailable?: (tripId: string) => boolean;
}): FirstRideConstraint | undefined {
  const { index, entry, exit, departureMs, deadlineMs, feedTz, excludedRoutes, excludedModes, wheelchair, isTripUnavailable } = input;
  if (!index.patterns || !index.patternsAtStop || deadlineMs <= departureMs) return;
  const start = Math.floor(departureMs / 1000);
  const frame = serviceDayFrame(start, feedTz);
  const deadline = frame.nowSecs + Math.floor(deadlineMs / 1000) - start;
  const origin = start - frame.nowSecs;
  const dates = [frame.yesterdayYmd, frame.todayYmd];
  const nextDate = addDaysCivil(frame.todayYmd, 1);
  if (serviceDayOriginUnix(Number(nextDate), feedTz) <= Math.floor(deadlineMs / 1000)) dates.push(nextDate);
  const days = dates.map(date => ({
    active: resolveActiveServicesForYmd(index.services, date),
    shift: serviceDayOriginUnix(Number(date), feedTz) - origin,
  }));
  const egress = new Map(exit.map(stop => [stop.stopId, stop.walkSecs]));
  let best: { ride: FirstRideConstraint; arrival: number; walking: number } | undefined;

  for (const { stopId, walkSecs } of entry) {
    for (const patternId of index.patternsAtStop.get(stopId) ?? []) {
      const pattern = index.patterns[patternId];
      if (!pattern || excludedRoutes.has(pattern.id) || excludedModes.has(pattern.mode)) continue;
      for (const [board, id] of pattern.stopIds.entries()) {
        if (id !== stopId) continue;
        const downstream = pattern.stopIds.flatMap((stop, pos) => {
          const walk = egress.get(stop);
          return pos > board && stop !== id && walk !== undefined ? [{ stop, pos, walk }] : [];
        });
        if (downstream.length === 0) continue;
        for (const trip of pattern.trips) {
          const dep = trip.departureSecs[board];
          if (!trip.tripId || !Number.isFinite(dep) || dep < 0 ||
              (trip.pickupTypes?.[board] ?? 0) !== 0 ||
              (wheelchair && trip.wheelchairAccessible === 2) ||
              (trip.ptbTripIdx !== undefined && index.frequenciesByTrip?.has(trip.ptbTripIdx))) continue;
          if (isTripUnavailable?.(trip.tripId)) continue;
          for (const { active, shift } of days) {
            if (!active.has(trip.serviceId) || dep + shift < frame.nowSecs + walkSecs || dep + shift > deadline) continue;
            // Compare departures by deadline proximity only after finding the
            // quickest finish for this boarding occurrence.
            let finish: { stop: string; arrival: number; walking: number } | undefined;
            for (const { stop, pos, walk } of downstream) {
              const arrival = trip.departureSecs[pos] - (trip.dwellSecs?.[pos] ?? 0);
              if (!Number.isFinite(arrival) || arrival < dep || (trip.dropOffTypes?.[pos] ?? 0) !== 0) continue;
              const doorArrival = arrival + walk + shift;
              const walking = walkSecs + walk;
              if (doorArrival > deadline || (finish && (doorArrival > finish.arrival ||
                  (doorArrival === finish.arrival && walking >= finish.walking)))) continue;
              finish = { stop, arrival: doorArrival, walking };
            }
            if (!finish || (best && (finish.arrival < best.arrival ||
                (finish.arrival === best.arrival && finish.walking >= best.walking)))) continue;
            best = { arrival: finish.arrival, walking: finish.walking, ride: {
              routeId: pattern.id, boardStopId: stopId, alightStopId: finish.stop, tripId: trip.tripId,
            } };
          }
        }
      }
    }
  }
  return best?.ride;
}
