/**
 * Arrive-by options as cards of the existing results list. Each option is one
 * decoded journey (`decodeArriveByJourneys`); this only re-shapes it.
 *
 * Times are GTFS `Time` in the scope's service-day frame (noon minus 12 h):
 * https://gtfs.org/documentation/schedule/reference/#field-types
 * A walk leg appears only where the engine reports walking seconds: a
 * connection's wait or an in-seat continuation is never a street walk, and an
 * in-seat (block) continuation spends no passenger transfer:
 * https://gtfs.org/documentation/schedule/reference/#tripstxt (block_id)
 */
import type { Itinerary, LatLon, Leg, LegPlace, RankingCriteria, TransportMode } from "@pt/shared";
import { DEFAULT_WALK_SPEED_MPS } from "@pt/shared/constants";
import { serviceDayOriginUnix } from "@pt/shared/time";
import type { ArriveByJourneyOption } from "../../services/temporalArriveByJourneys.ts";
import { arriveByPointKey } from "../../services/temporalArriveByResults.ts";

export interface ArriveByStop {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

export interface ArriveByDisplayContext {
  /** The scope's service date, whose frame every time is in. */
  readonly serviceDate: number;
  readonly tz: string;
  readonly origin: LatLon;
  readonly destination: LatLon;
  readonly labels: { readonly origin: string; readonly destination: string };
  readonly stops: ReadonlyMap<string, ArriveByStop>;
  /** tripId → headsign; routeId → colour when the ride carries none. */
  readonly headsigns: ReadonlyMap<string, string>;
  readonly routeColors: ReadonlyMap<string, string>;
  /** Entry stops reached at a running pace (run-to-catch). */
  readonly runToCatchStops: ReadonlySet<string>;
}

export interface ArriveByCard {
  readonly key: string;
  readonly option: ArriveByJourneyOption;
  readonly itinerary: Itinerary;
}

export function arriveByItinerary(option: ArriveByJourneyOption, ctx: ArriveByDisplayContext): Itinerary {
  const j = option.journey, p = j.point;
  const origin0 = serviceDayOriginUnix(ctx.serviceDate, ctx.tz);
  const iso = (secs: number): string => new Date((origin0 + secs) * 1000).toISOString();
  const stop = (stopId: string): LegPlace => {
    const s = ctx.stops.get(stopId);
    return { name: s?.name ?? stopId, stopId, location: s ? { lat: s.lat, lon: s.lon } : { lat: 0, lon: 0 } };
  };
  const walk = (from: LegPlace, to: LegPlace, start: number, secs: number, run = false): Leg => ({
    mode: "WALK" as TransportMode, from, to,
    departureTime: iso(start), arrivalTime: iso(start + secs), durationSeconds: secs,
    ...(run ? { runToCatch: true } : {}),
  });

  const legs: Leg[] = [];
  if (j.access.walkSecs > 0) {
    legs.push(walk({ name: ctx.labels.origin, location: ctx.origin }, stop(j.access.stopId),
      p.departureSecs, j.access.walkSecs, ctx.runToCatchStops.has(j.access.stopId)));
  }
  j.rides.forEach((ride, i) => {
    const c = i > 0 ? j.connections[i - 1]! : null;
    if (c && c.walkSecs > 0 && c.fromStopId !== c.toStopId) {
      legs.push(walk(stop(c.fromStopId), stop(c.toStopId), c.arrivalSecs, c.walkSecs));
    }
    const w = ride.witness;
    const color = ride.routeColor ?? ctx.routeColors.get(ride.routeId);
    const headsign = ctx.headsigns.get(ride.tripId);
    legs.push({
      mode: ride.mode, from: stop(ride.fromStopId), to: stop(ride.toStopId),
      departureTime: iso(w.boardSecs), arrivalTime: iso(w.alightSecs), durationSeconds: w.alightSecs - w.boardSecs,
      routeShortName: ride.routeShortName, ...(color ? { routeColor: color } : {}), tripId: ride.tripId,
      ...(headsign ? { headsign } : {}), intermediateStops: w.alightPosition - w.boardPosition - 1,
      routeId: ride.routeId, approximate: ride.approximate,
      boardStopIdx: w.boardPosition, alightStopIdx: w.alightPosition, patternStopIds: [...ride.patternStopIds],
    });
  });
  const e = j.egress;
  const alight = j.rides[j.rides.length - 1]!.witness.alightSecs;
  if (e.physicalWalkSecs > 0) legs.push(walk(stop(e.fromStopId), stop(e.exitStopId), alight, e.physicalWalkSecs));
  if (e.callerWalkSecs > 0) {
    legs.push(walk(stop(e.exitStopId), { name: ctx.labels.destination, location: ctx.destination },
      alight + e.physicalWalkSecs, e.callerWalkSecs));
  }
  return {
    legs,
    departureTime: iso(p.departureSecs),
    arrivalTime: iso(p.arrivalSecs),
    durationSeconds: p.arrivalSecs - p.departureSecs,
    transfers: p.actualTransfers,
    walkingDistanceMeters: Math.round(p.totalWalkSecs * DEFAULT_WALK_SPEED_MPS),
  };
}

export function arriveByCards(options: readonly ArriveByJourneyOption[], ctx: ArriveByDisplayContext): ArriveByCard[] {
  return options.map((option) => ({ key: arriveByPointKey(option.journey.point), option, itinerary: arriveByItinerary(option, ctx) }));
}

/**
 * The spec's card order: the latest departure first, the rest by descending
 * departure, with the selected sort resolving equal departures.
 */
export function orderArriveByCards(cards: readonly ArriveByCard[], ranking: RankingCriteria): ArriveByCard[] {
  const latest = cards.find((c) => c.option.selectors.includes("latest-departure"));
  const point = (c: ArriveByCard) => c.option.journey.point;
  const duration = (c: ArriveByCard) => point(c).arrivalSecs - point(c).departureSecs;
  const tie = (a: ArriveByCard, b: ArriveByCard): number =>
    ranking === "fewest_transfers" ? point(a).actualTransfers - point(b).actualTransfers || duration(a) - duration(b)
      : ranking === "least_walking" ? point(a).totalWalkSecs - point(b).totalWalkSecs || duration(a) - duration(b)
        : duration(a) - duration(b);
  const rest = cards.filter((c) => c !== latest).sort((a, b) =>
    point(b).departureSecs - point(a).departureSecs || tie(a, b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return latest ? [latest, ...rest] : rest;
}
