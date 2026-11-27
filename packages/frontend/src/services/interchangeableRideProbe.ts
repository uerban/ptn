import type { BaseEndpoint, FirstRideConstraint, Itinerary, Leg } from "@pt/shared";
import { serviceDayOriginUnix } from "@pt/shared/time";
import { addDaysCivil } from "@pt/shared/util";
import { resolveActiveServicesForYmd } from "./serviceDay.ts";
import { serviceDayFrame } from "./serviceDayFrame.ts";
import { effectiveTransferFloor } from "./effectiveTransferRule.ts";
import type { RaptorIndex } from "./raptorIndex.ts";

const MAX_ROUTE_PROBES = 3;

type Probe = (origin: BaseEndpoint, destination: BaseEndpoint, at: Date, constraint: FirstRideConstraint) => Promise<Itinerary[]>;

function transferFits(index: RaptorIndex, from: Leg, to: Leg, minTransferSecs: number): boolean {
  const toStopId = from.to.stopId;
  const fromStopId = to.from.stopId;
  if (!toStopId || toStopId !== fromStopId || !from.tripId || !to.tripId || !from.routeId || !to.routeId) return false;
  const floor = effectiveTransferFloor(index, { toStopId, tripId: from.tripId, routeId: from.routeId },
    { fromStopId, tripId: to.tripId, routeId: to.routeId }, minTransferSecs);
  return floor !== null && Date.parse(to.departureTime) >= Date.parse(from.arrivalTime) + floor * 1000;
}

/** Find a scheduled trip that can use an earlier, exact transfer rule. */
function earlierTimedTrip(index: RaptorIndex, previous: Leg & { tripId: string; routeId: string },
  board: string, alight: string, routeId: string, floor: number | null, minTransferSecs: number, feedTz: string) {
  if (!index.transferRulesTripScoped?.size) return undefined;
  const arrival = Date.parse(previous.arrivalTime);
  if (!Number.isFinite(arrival)) return undefined;
  const limit = floor === null ? Infinity : arrival + floor * 1000;
  const frame = serviceDayFrame(Math.floor(arrival / 1000), feedTz);
  const days = [frame.yesterdayYmd, frame.todayYmd, addDaysCivil(frame.todayYmd, 1)].map(ymd => ({
    origin: serviceDayOriginUnix(Number(ymd), feedTz),
    services: resolveActiveServicesForYmd(index.services, ymd),
  }));
  let best: { tripId: string; departure: number; at: number } | undefined;
  for (const id of index.patternsAtStop?.get(board) ?? []) {
    const pattern = index.patterns?.[id];
    if (!pattern || pattern.id !== routeId) continue;
    for (const [position, stopId] of pattern.stopIds.entries()) {
      if (stopId !== board || pattern.stopIds.indexOf(alight, position + 1) === -1) continue;
      for (const trip of pattern.trips) {
        if (!trip.tripId || (trip.pickupTypes?.[position] ?? 0) !== 0 ||
            (trip.ptbTripIdx !== undefined && index.frequenciesByTrip?.has(trip.ptbTripIdx))) continue;
        const required = effectiveTransferFloor(index, { toStopId: board, tripId: previous.tripId, routeId: previous.routeId },
          { fromStopId: board, routeId, tripId: trip.tripId }, minTransferSecs);
        if (required === null || (floor !== null && required >= floor)) continue;
        const at = arrival + required * 1000;
        for (const day of days) {
          if (!day.services.has(trip.serviceId) || !Number.isFinite(trip.departureSecs[position]) ||
              trip.departureSecs[position] < 0) continue;
          const departure = (day.origin + trip.departureSecs[position]) * 1000;
          if (departure >= at && departure < limit &&
              (!best || departure < best.departure)) best = { tripId: trip.tripId, departure, at };
        }
      }
    }
  }
  return best;
}

/** Explicit, bounded lookup for the second ride of a planned journey. */
export async function probeInterchangeableRide(primary: Itinerary, index: RaptorIndex, minTransferSecs: number,
  excludedRouteIds: ReadonlySet<string>, excludedModes: ReadonlySet<Leg["mode"]>, signal: AbortSignal, probe: Probe, feedTz = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<Itinerary[]> {
  if (primary.cancelled || primary.timingUnreliable) return [];
  const first = primary.legs.findIndex((leg) => leg.mode !== "WALK");
  const previous = primary.legs[first];
  const original = primary.legs[first + 1];
  const next = primary.legs[first + 2];
  const board = original?.from.stopId;
  const alight = original?.to.stopId;
  if (!previous || !original || original.mode === "WALK" || !board || !alight || previous.to.stopId !== board || !previous.tripId || !previous.routeId ||
    (next && next.mode !== "WALK" && next.from.stopId !== alight) ||
    (next?.mode === "WALK" && primary.legs.length !== first + 3)) return [];

  const routeIds = new Set<string>();
  for (const id of index.patternsAtStop?.get(board) ?? []) {
    const route = index.patterns?.[id];
    if (!route || route.id === original.routeId || excludedRouteIds.has(route.id) || excludedModes.has(route.mode)) continue;
    const boardPosition = route.stopIds.indexOf(board);
    if (boardPosition >= 0 && route.stopIds.indexOf(alight, boardPosition + 1) >= 0) routeIds.add(route.id);
    if (routeIds.size === MAX_ROUTE_PROBES) break;
  }
  const origin = { kind: "stop" as const, stopId: board, name: original.from.name, ...original.from.location };
  const destination = { kind: "stop" as const, stopId: alight, name: original.to.name, ...original.to.location };
  const options: Itinerary[] = [];
  let remaining = MAX_ROUTE_PROBES;
  for (const routeId of routeIds) {
    if (signal.aborted) return [];
    const initialFloor = effectiveTransferFloor(index, { toStopId: board, tripId: previous.tripId, routeId: previous.routeId },
      { fromStopId: board, routeId }, minTransferSecs);
    const timed = earlierTimedTrip(index, { ...previous, tripId: previous.tripId, routeId: previous.routeId },
      board, alight, routeId, initialFloor, minTransferSecs, feedTz);
    const searches = [
      ...(timed ? [{ at: timed.at, tripId: timed.tripId }] : []),
      ...(initialFloor !== null ? [{ at: Date.parse(previous.arrivalTime) + initialFloor * 1000, tripId: undefined }] : []),
    ];
    for (const { at, tripId } of searches) {
      if (remaining === 0) break;
      remaining--;
      const before = options.length;
      const candidates = await probe(origin, destination, new Date(at), {
        routeId, boardStopId: board, alightStopId: alight, ...(tripId ? { tripId } : {}),
      });
      if (signal.aborted) return [];
      for (const candidate of candidates) {
        if (candidate.cancelled || candidate.timingUnreliable || candidate.legs.length !== 1) continue;
        const ride = candidate.legs[0];
        if ((tripId && ride.tripId !== tripId) || !Number.isFinite(Date.parse(ride.arrivalTime)) || ride.routeId !== routeId || ride.from.stopId !== board || ride.to.stopId !== alight ||
          !transferFits(index, previous, ride, minTransferSecs) ||
          (next && next.mode !== "WALK" && !transferFits(index, ride, next, minTransferSecs))) continue;

        const legs = primary.legs.slice();
        legs[first + 1] = ride;
        if (next?.mode === "WALK") {
          legs[first + 2] = { ...next, departureTime: ride.arrivalTime,
            arrivalTime: new Date(Date.parse(ride.arrivalTime) + next.durationSeconds * 1000).toISOString() };
        }
        const arrivalTime = legs[legs.length - 1].arrivalTime;
        options.push({ ...primary, legs, arrivalTime,
          durationSeconds: (Date.parse(arrivalTime) - Date.parse(primary.departureTime)) / 1000 });
      }
      if (options.length > before) break;
    }
  }
  return options;
}
