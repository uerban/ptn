import type { FirstRideConstraint, RaptorTransitLeg, TransportMode } from "@pt/shared";
import { effectiveTransferFloor } from "./effectiveTransferRule.ts";
import { NEXT_DEPARTURE_FRESHNESS_WINDOW_MS, type RtStoreLite } from "./nextDeparture.ts";
import type { RaptorIndex } from "./raptorIndex.ts";
import { resolveActiveServicesForYmd } from "./serviceDay.ts";
import { serviceDayFrame } from "./serviceDayFrame.ts";

export interface LiveTransferCandidate {
  firstRide: FirstRideConstraint & { tripId: string };
  scheduledBoardMs: number;
  predictedBoardMs: number;
  predictedAlightMs: number;
}

interface LiveTransferInput {
  index: RaptorIndex;
  realtime: RtStoreLite;
  incoming: Pick<RaptorTransitLeg, "toStopId" | "routeId" | "tripId">;
  incomingScheduledArrivalMs: number;
  alightStopIds: ReadonlySet<string>;
  minTransferSecs: number;
  nowMs: number;
  feedTz: string;
  latestBoardMs: number;
  excludedRouteIds?: ReadonlySet<string>;
  excludedModes?: ReadonlySet<TransportMode>;
}

function freshDelay(realtime: RtStoreLite, tripId: string, nowMs: number): number | null {
  const update = realtime.getTripDelay(tripId);
  const receivedAt = realtime.getReceivedAt(tripId);
  if (!update || update.cancelled || update.deleted || !Number.isFinite(update.delaySeconds) ||
      receivedAt === null || !Number.isFinite(receivedAt) ||
      receivedAt > nowMs || nowMs - receivedAt >= NEXT_DEPARTURE_FRESHNESS_WINDOW_MS) return null;
  return update.delaySeconds;
}

function transferServiceDays(index: RaptorIndex, nowMs: number, feedTz: string) {
  const nowSecs = Math.floor(nowMs / 1000);
  const frame = serviceDayFrame(nowSecs, feedTz);
  const todayOrigin = (nowSecs - frame.nowSecs) * 1000;
  return [
    { origin: todayOrigin, active: resolveActiveServicesForYmd(index.services, frame.todayYmd) },
    { origin: todayOrigin - frame.yesterdayShiftSecs * 1000, active: resolveActiveServicesForYmd(index.services, frame.yesterdayYmd) },
  ];
}

/** Limit optional acquisition to the two lines with eligible timetable
 * departures closest to the incoming scheduled arrival. */
export function liveTransferRouteIds(index: RaptorIndex, board: string, alight: ReadonlySet<string>,
  excludedRoutes: ReadonlySet<string>, excludedModes: ReadonlySet<TransportMode>, arrivalMs: number,
  latestBoardMs: number, feedTz: string): string[] {
  const routes = new Map<string, number>();
  const serviceDays = transferServiceDays(index, arrivalMs, feedTz);
  for (const i of index.patternsAtStop?.get(board) ?? []) {
    const pattern = index.patterns?.[i];
    if (!pattern || excludedRoutes.has(pattern.id) || excludedModes.has(pattern.mode)) continue;
    for (const [position, stopId] of pattern.stopIds.entries()) {
      if (stopId !== board || !pattern.stopIds.slice(position + 1).some(stop => stop !== board && alight.has(stop))) continue;
      for (const trip of pattern.trips) {
        const seconds = trip.departureSecs[position];
        if (!Number.isFinite(seconds) || seconds < 0 || trip.pickupTypes?.[position] === 1) continue;
        for (const { origin, active } of serviceDays) {
          if (!active.has(trip.serviceId)) continue;
          const departure = origin + seconds * 1000;
          if (departure > latestBoardMs || departure < arrivalMs - 1_800_000) continue;
          const distance = Math.abs(departure - arrivalMs);
          if (distance < (routes.get(pattern.id) ?? Infinity)) routes.set(pattern.id, distance);
        }
      }
    }
  }
  return [...routes].sort(([a, aDistance], [b, bDistance]) => aDistance - bDistance || a.localeCompare(b))
    .slice(0, 2).map(([routeId]) => routeId);
}

/** Discover one exact, same-platform realtime opportunity. A planner must
 * still validate mobility and the remainder of the door-to-door journey. */
export function findLiveTransferCandidate(input: LiveTransferInput): LiveTransferCandidate | null {
  const { index, realtime, incoming, nowMs } = input;
  const incomingDelay = freshDelay(realtime, incoming.tripId, nowMs);
  if (incomingDelay === null || incomingDelay >= 0 || !index.patterns || !index.patternsAtStop) return null;
  const arrivalMs = input.incomingScheduledArrivalMs + incomingDelay * 1000;
  if (!Number.isFinite(arrivalMs) || arrivalMs < nowMs || input.latestBoardMs < arrivalMs) return null;

  const serviceDays = transferServiceDays(index, nowMs, input.feedTz);
  let best: LiveTransferCandidate | null = null;
  for (const patternIdx of index.patternsAtStop.get(incoming.toStopId) ?? []) {
    const pattern = index.patterns[patternIdx];
    if (!pattern || input.excludedRouteIds?.has(pattern.id) || input.excludedModes?.has(pattern.mode)) continue;
    for (const trip of pattern.trips) {
      if (trip.tripId === incoming.tripId ||
          (trip.ptbTripIdx !== undefined && index.frequenciesByTrip?.has(trip.ptbTripIdx))) continue;
      const outgoingDelay = freshDelay(realtime, trip.tripId, nowMs);
      if (outgoingDelay === null || outgoingDelay <= 0) continue;
      const floor = effectiveTransferFloor(index, incoming, {
        fromStopId: incoming.toStopId, routeId: pattern.id, tripId: trip.tripId,
      }, input.minTransferSecs);
      if (floor === null) continue;
      for (const [board, stopId] of pattern.stopIds.entries()) {
        const boardSecs = trip.departureSecs[board];
        if (stopId !== incoming.toStopId || trip.pickupTypes?.[board] === 1 ||
            !Number.isFinite(boardSecs) || boardSecs < 0) continue;
        for (const { origin, active } of serviceDays) {
          if (!active.has(trip.serviceId)) continue;
          const scheduledBoardMs = origin + boardSecs * 1000;
          const predictedBoardMs = scheduledBoardMs + outgoingDelay * 1000;
          if (scheduledBoardMs >= input.incomingScheduledArrivalMs + floor * 1000 ||
              predictedBoardMs < arrivalMs + floor * 1000 || predictedBoardMs > input.latestBoardMs) continue;
          for (let alight = board + 1; alight < pattern.stopIds.length; alight++) {
            const alightStopId = pattern.stopIds[alight];
            const alightSecs = trip.departureSecs[alight] - (trip.dwellSecs?.[alight] ?? 0);
            if (alightStopId === stopId || !input.alightStopIds.has(alightStopId) ||
                trip.dropOffTypes?.[alight] === 1 || !Number.isFinite(alightSecs) || alightSecs < boardSecs) continue;
            const predictedAlightMs = origin + (alightSecs + outgoingDelay) * 1000;
            if (best && best.predictedAlightMs <= predictedAlightMs) continue;
            best = {
              firstRide: { routeId: pattern.id, tripId: trip.tripId, boardStopId: stopId, alightStopId },
              scheduledBoardMs, predictedBoardMs, predictedAlightMs,
            };
          }
        }
      }
    }
  }
  return best;
}
