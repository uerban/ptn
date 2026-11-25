import type { BaseEndpoint, FirstRideConstraint, Itinerary, Leg } from "@pt/shared";
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

/** Explicit, bounded lookup for the second ride of a planned journey. */
export async function probeInterchangeableRide(primary: Itinerary, index: RaptorIndex, minTransferSecs: number,
  excludedRouteIds: ReadonlySet<string>, excludedModes: ReadonlySet<Leg["mode"]>, signal: AbortSignal, probe: Probe): Promise<Itinerary[]> {
  if (primary.cancelled || primary.timingUnreliable) return [];
  const first = primary.legs.findIndex((leg) => leg.mode !== "WALK");
  const previous = primary.legs[first];
  const original = primary.legs[first + 1];
  const next = primary.legs[first + 2];
  const board = original?.from.stopId;
  const alight = original?.to.stopId;
  if (!previous || !original || original.mode === "WALK" || !board || !alight || previous.to.stopId !== board ||
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
  for (const routeId of routeIds) {
    if (signal.aborted) return [];
    const candidates = await probe(origin, destination, new Date(Date.parse(previous.arrivalTime) + minTransferSecs * 1000), {
      routeId, boardStopId: board, alightStopId: alight,
    });
    if (signal.aborted) return [];
    for (const candidate of candidates) {
      if (candidate.cancelled || candidate.timingUnreliable || candidate.legs.length !== 1) continue;
      const ride = candidate.legs[0];
      if (!Number.isFinite(Date.parse(ride.arrivalTime)) || ride.routeId !== routeId || ride.from.stopId !== board || ride.to.stopId !== alight ||
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
  }
  return options;
}
