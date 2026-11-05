/**
 * Complete movement boundary for the opt-in experiment, not a second router.
 * Structural/accounting checks do not prove boarding legality or PTFT binding;
 * the worker must bind the owner, input bytes, query and request generation.
 * Never infer walks from timetable gaps or flatten onboard movement into a
 * passenger transfer. GTFS minimum transfer time includes more than walking:
 * https://gtfs.org/documentation/schedule/reference/#transferstxt
 * Repeated stops and split-trip continuations retain their concrete witnesses:
 * https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
 */
import { routeTypeToMode } from "@pt/shared/ptb";
import type { StopWalk, TransportMode } from "@pt/shared";
import {
  ARRIVE_BY_SELECTORS, arriveByPointKey, decodeArriveByPoint, decodeArriveByWinners,
  type ArriveByPoint, type ArriveByScope, type ArriveBySelector, type ArriveByTransitWitness,
} from "./temporalArriveByResults.ts";

export interface ArriveByMovementScope extends ArriveByScope {
  readonly entryStops: readonly Readonly<StopWalk>[];
  readonly exitStops: readonly Readonly<StopWalk>[];
}

export interface ArriveByRide {
  readonly witness: ArriveByTransitWitness;
  readonly routeId: string;
  readonly routeShortName: string;
  readonly routeColor: string | null;
  readonly tripId: string;
  readonly mode: TransportMode;
  readonly routeType: number;
  readonly fromStopId: string;
  readonly toStopId: string;
  readonly patternStopIds: readonly string[];
  readonly approximate: boolean;
}

export const ARRIVE_BY_CONNECTION_KINDS = [
  "same-stop", "footpath", "synthetic", "linked", "in-seat", "derived",
] as const;
export interface ArriveByConnection {
  readonly fromStopId: string;
  readonly toStopId: string;
  readonly arrivalSecs: number;
  readonly boardingSecs: number;
  readonly walkSecs: number;
  readonly minimumElapsedSecs: number;
  readonly kind: typeof ARRIVE_BY_CONNECTION_KINDS[number];
  readonly spendsTransfer: boolean;
}
export interface ArriveByJourney {
  readonly point: ArriveByPoint;
  readonly access: Readonly<StopWalk>;
  readonly rides: readonly ArriveByRide[];
  readonly connections: readonly ArriveByConnection[];
  readonly egress: {
    readonly fromStopId: string;
    readonly exitStopId: string;
    readonly physicalWalkSecs: number;
    readonly callerWalkSecs: number;
  };
}
export interface ArriveByJourneyOption {
  readonly journey: ArriveByJourney;
  readonly selectors: readonly ArriveBySelector[];
}

function requireMovement(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid arrive-by movement: ${message}`);
}
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  requireMovement(value !== null && typeof value === "object" && !Array.isArray(value), "expected object");
  const r = value as Record<string, unknown>;
  if (keys) requireMovement(Object.keys(r).length === keys.length
    && keys.every((k) => Object.hasOwn(r, k)), "fields changed");
  return r;
}
function integer(value: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  requireMovement(typeof value === "number" && Number.isSafeInteger(value)
    && value >= min && value <= max, "unsafe/out-of-range integer");
  return value;
}
function add(...values: number[]): number { return integer(values.reduce((a, b) => a + b, 0)); }
function text(value: unknown): string {
  requireMovement(typeof value === "string", "expected string metadata");
  return value;
}
function stopWalk(value: unknown): Readonly<StopWalk> {
  const r = record(value, ["stopId", "walkSecs"]);
  return Object.freeze({ stopId: text(r.stopId), walkSecs: integer(r.walkSecs, 0, 0xffff_ffff) });
}
function checkStops(stops: readonly Readonly<StopWalk>[]): void {
  requireMovement(Array.isArray(stops), "missing query stops");
  for (const s of stops) stopWalk(s);
}
function decodeJourney(value: unknown, scope: ArriveByMovementScope): ArriveByJourney {
  const r = record(value, ["point", "access", "rides", "connections", "egress"]);
  const point = decodeArriveByPoint(r.point, scope);
  requireMovement(point !== null, "null journey point");
  const access = stopWalk(r.access);
  requireMovement(scope.entryStops.some((s) => s.stopId === access.stopId && s.walkSecs === access.walkSecs), "access not in query");
  requireMovement(Array.isArray(r.rides) && r.rides.length === point.witnessLegs, "ride count");
  const horizon = add(point.departureSecs, 172800);
  const rides = Object.freeze(r.rides.map((value, i): ArriveByRide => {
    const ride = record(value, ["witness", "routeId", "routeShortName", "routeColor", "tripId", "mode",
      "routeType", "fromStopId", "toStopId", "patternStopIds", "approximate"]);
    // Decode all eleven fields against the already decoded point. A matching
    // key alone is insufficient: extra canonical fields must also be rejected.
    const w = record(ride.witness, Object.keys(point.witness[i]!));
    requireMovement(Object.entries(point.witness[i]!).every(([k, v]) => w[k] === v), "ride witness differs");
    const witness = point.witness[i]!;
    requireMovement(witness.alightSecs <= horizon, "ride outside origin horizon");
    const routeType = integer(ride.routeType, 0, 0xffff);
    const mode = routeTypeToMode(routeType);
    requireMovement(ride.mode === mode, "mode differs from route type");
    requireMovement(ride.approximate === witness.frequencyInstance, "frequency approximation differs");
    requireMovement(ride.routeColor === null || typeof ride.routeColor === "string", "route color");
    const fromStopId = text(ride.fromStopId), toStopId = text(ride.toStopId);
    requireMovement(Array.isArray(ride.patternStopIds), "missing pattern stops");
    const patternStopIds = Object.freeze(ride.patternStopIds.map(text));
    requireMovement(patternStopIds[witness.boardPosition] === fromStopId
      && patternStopIds[witness.alightPosition] === toStopId, "stop occurrence differs");
    return Object.freeze({ witness, routeId: text(ride.routeId), routeShortName: text(ride.routeShortName),
      routeColor: ride.routeColor, tripId: text(ride.tripId), mode, routeType,
      fromStopId, toStopId, patternStopIds, approximate: witness.frequencyInstance });
  }));
  requireMovement(access.stopId === rides[0]!.fromStopId
    && add(point.departureSecs, access.walkSecs) === rides[0]!.witness.boardSecs, "access movement differs");
  requireMovement(Array.isArray(r.connections) && r.connections.length === rides.length - 1, "connection count");
  const connections = Object.freeze(r.connections.map((value, i): ArriveByConnection => {
    const c = record(value, ["fromStopId", "toStopId", "arrivalSecs", "boardingSecs", "walkSecs", "minimumElapsedSecs", "kind", "spendsTransfer"]);
    const from = rides[i]!, to = rides[i + 1]!;
    const kind = ARRIVE_BY_CONNECTION_KINDS.find((k) => k === c.kind);
    requireMovement(kind !== undefined, "connection kind");
    const walkSecs = integer(c.walkSecs, 0), minimumElapsedSecs = integer(c.minimumElapsedSecs, 0);
    const arrivalSecs = integer(c.arrivalSecs), boardingSecs = integer(c.boardingSecs);
    requireMovement(c.fromStopId === from.toStopId && c.toStopId === to.fromStopId
      && arrivalSecs === from.witness.alightSecs && boardingSecs === to.witness.boardSecs, "connection endpoints/times differ");
    requireMovement(minimumElapsedSecs >= walkSecs && add(arrivalSecs, minimumElapsedSecs) <= boardingSecs, "insufficient connection time");
    const spendsTransfer = kind !== "in-seat" && kind !== "derived";
    requireMovement(c.spendsTransfer === spendsTransfer && spendsTransfer === !to.witness.inSeat, "connection transfer differs");
    if (kind === "same-stop") requireMovement(c.fromStopId === c.toStopId && walkSecs === 0, "same-stop movement");
    return Object.freeze({ fromStopId: from.toStopId, toStopId: to.fromStopId,
      arrivalSecs, boardingSecs, walkSecs, minimumElapsedSecs, kind, spendsTransfer });
  }));
  const e = record(r.egress, ["fromStopId", "exitStopId", "physicalWalkSecs", "callerWalkSecs"]);
  const egress = Object.freeze({ fromStopId: text(e.fromStopId), exitStopId: text(e.exitStopId),
    physicalWalkSecs: integer(e.physicalWalkSecs, 0), callerWalkSecs: integer(e.callerWalkSecs, 0, 0xffff_ffff) });
  const last = rides[rides.length - 1]!;
  requireMovement(egress.fromStopId === last.toStopId
    && scope.exitStops.some((s) => s.stopId === egress.exitStopId && s.walkSecs === egress.callerWalkSecs), "egress not in query");
  requireMovement(egress.fromStopId !== egress.exitStopId || egress.physicalWalkSecs === 0, "same-stop egress walk");
  requireMovement(add(last.witness.alightSecs, egress.physicalWalkSecs) <= horizon, "physical egress outside origin horizon");
  requireMovement(add(last.witness.alightSecs, egress.physicalWalkSecs, egress.callerWalkSecs) === point.arrivalSecs, "egress arrival differs");
  requireMovement(add(access.walkSecs, ...connections.map((c) => c.walkSecs), egress.physicalWalkSecs, egress.callerWalkSecs) === point.totalWalkSecs, "total walking differs");
  requireMovement(connections.filter((c) => c.spendsTransfer).length === point.actualTransfers, "total transfers differ");
  return Object.freeze({ point, access, rides, connections, egress });
}

/**
 * Complete selected options in fixed latest-first order. Diagnostics/timings
 * are not consumed as proof. No partial options escape if any journey fails.
 */
export function decodeArriveByJourneys(
  value: unknown, scope: ArriveByMovementScope, goal: ArriveBySelector | "portfolio",
): readonly ArriveByJourneyOption[] {
  const winners = decodeArriveByWinners(value, scope, goal);
  checkStops(scope.entryStops);
  checkStops(scope.exitStops);
  const r = record(value);
  requireMovement(r.journeyContract === "complete-selected-movement-v1", "incompatible movement contract");
  const selectors = goal === "portfolio" ? ARRIVE_BY_SELECTORS : [goal];
  const mapping = record(r.journeyByPreference, selectors);
  requireMovement(Array.isArray(r.journeys) && r.journeys.length <= selectors.length, "journey count");
  const journeys = r.journeys.map((j) => decodeJourney(j, scope));
  const options = new Map<string, { journey: ArriveByJourney; index: number; selectors: ArriveBySelector[] }>();
  const used = new Set<number>();
  for (const s of selectors) {
    const point = winners[s];
    if (point === null) { requireMovement(mapping[s] === null, "empty selector has journey"); continue; }
    const index = integer(mapping[s], 0, journeys.length - 1);
    const journey = journeys[index]!;
    const key = arriveByPointKey(point);
    requireMovement(arriveByPointKey(journey.point) === key, "selector point differs");
    const previous = options.get(key);
    if (previous) {
      requireMovement(previous.index === index, "duplicate winner not shared");
      previous.selectors.push(s);
    } else options.set(key, { journey, index, selectors: [s] });
    used.add(index);
  }
  requireMovement(used.size === journeys.length, "unselected journey");
  return Object.freeze([...options.values()].map(({ journey, selectors }) =>
    Object.freeze({ journey, selectors: Object.freeze(selectors) })));
}

interface Interval { readonly departureSecs: number; readonly arrivalSecs: number }
export type ArriveByTimelineSegment = Interval & (
  | { readonly kind: "access"; readonly access: ArriveByJourney["access"] }
  | { readonly kind: "ride"; readonly ride: ArriveByRide }
  | { readonly kind: "connection"; readonly connection: ArriveByConnection }
  | { readonly kind: "physical-egress" | "caller-egress"; readonly egress: ArriveByJourney["egress"] }
);
export interface ArriveByPresentation extends Interval {
  readonly option: ArriveByJourneyOption;
  readonly totalSecs: number;
  readonly totalWalkSecs: number;
  readonly transfers: number;
  readonly timeline: readonly ArriveByTimelineSegment[];
}

/**
 * Not the legacy ComposedItinerary: keep connection kind and concrete identity
 * available to the opt-in UI. A connection interval includes physical movement
 * and waiting/onboard elapsed time; it is never a fabricated street-walk leg.
 * Zero-time segments remain explicit. Only pass options returned by the decoder.
 */
export function composeArriveByJourney(option: ArriveByJourneyOption): ArriveByPresentation {
  const j = option.journey, p = j.point;
  const timeline: ArriveByTimelineSegment[] = [{ kind: "access", access: j.access,
    departureSecs: p.departureSecs, arrivalSecs: j.rides[0]!.witness.boardSecs }];
  j.rides.forEach((ride, i) => {
    if (i) {
      const connection = j.connections[i - 1]!;
      timeline.push({ kind: "connection", connection,
        departureSecs: connection.arrivalSecs, arrivalSecs: connection.boardingSecs });
    }
    timeline.push({ kind: "ride", ride, departureSecs: ride.witness.boardSecs, arrivalSecs: ride.witness.alightSecs });
  });
  const alight = j.rides[j.rides.length - 1]!.witness.alightSecs;
  const exit = add(alight, j.egress.physicalWalkSecs);
  timeline.push({ kind: "physical-egress", egress: j.egress, departureSecs: alight, arrivalSecs: exit },
    { kind: "caller-egress", egress: j.egress, departureSecs: exit, arrivalSecs: p.arrivalSecs });
  return Object.freeze({ option, departureSecs: p.departureSecs, arrivalSecs: p.arrivalSecs,
    totalSecs: p.arrivalSecs - p.departureSecs, totalWalkSecs: p.totalWalkSecs,
    transfers: p.actualTransfers, timeline: Object.freeze(timeline.map((s) => Object.freeze(s))) });
}
