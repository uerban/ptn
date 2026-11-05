/**
 * Owner-independent boundary for the opt-in arrive-by experiment. Not wired to
 * the planner yet. These are canonical winner points, NOT display itineraries.
 * Complete engine-projected movement is decoded separately in
 * temporalArriveByJourneys; never infer walking from these witnesses alone.
 *
 * Decoding checks the result contract, not the routing proof or work ledger.
 * GTFS occurrence identity must survive presentation/deduplication:
 * https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
 * https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 */
export const ARRIVE_BY_SELECTORS = [
  "latest-departure", "fastest", "least-walking", "fewest-transfers",
] as const;
export type ArriveBySelector = typeof ARRIVE_BY_SELECTORS[number];
export type ArriveBySequence = "portfolio" | "latest-then-portfolio";

export interface ArriveByScope {
  readonly serviceDate: number;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly arrivalDeadline: number;
  readonly maxRounds: number;
}

export interface ArriveByTransitWitness {
  readonly serviceDate: number;
  readonly routeIdx: number;
  readonly readerRouteIdx: number;
  readonly tripIdx: number;
  readonly boardPosition: number;
  readonly alightPosition: number;
  readonly boardSecs: number;
  readonly alightSecs: number;
  readonly frequencyOffsetSecs: number;
  readonly frequencyInstance: boolean;
  readonly inSeat: boolean;
}

export interface ArriveByPoint {
  readonly departureSecs: number;
  readonly arrivalSecs: number;
  readonly actualTransfers: number;
  readonly totalWalkSecs: number;
  readonly transitRounds: number;
  readonly serviceDate: number;
  readonly witnessLegs: number;
  readonly witness: readonly ArriveByTransitWitness[];
}
export type ArriveByWinners = Readonly<Record<ArriveBySelector, ArriveByPoint | null>>;

export interface ArriveByOption {
  readonly point: ArriveByPoint;
  readonly selectors: readonly ArriveBySelector[];
}

export const ARRIVE_BY_RESOURCE_LIMITS = [
  "segments", "frontier", "stop-scans", "lookup-work", "optimistic-edges",
  "catalogue-events", "catalogue-edges", "catalogue-bytes",
] as const;
export type ArriveByResourceLimit = typeof ARRIVE_BY_RESOURCE_LIMITS[number];
export function isArriveByResourceLimit(value: unknown): value is ArriveByResourceLimit {
  return typeof value === "string" && (ARRIVE_BY_RESOURCE_LIMITS as readonly string[]).includes(value);
}
export function isArriveByResourceFailure(failure: ArriveByFailure): boolean {
  return (failure.stage === "prepare" || failure.stage === "search") && failure.code === "ResourceLimit"
    && isArriveByResourceLimit(failure.resourceLimit);
}

export interface ArriveByFailure {
  readonly stage: "availability" | "setup" | "prepare" | "search" | "projection" | "transport" | "contract";
  /** Preserve the engine/transport code; exhaustion is never an empty result. */
  readonly code: string;
  readonly message: string;
  readonly resourceLimit?: ArriveByResourceLimit;
}

export interface ArriveByResultState {
  readonly status: "pending" | "latest" | "complete" | "limited" | "failed" | "cancelled";
  readonly options: readonly ArriveByOption[];
  readonly failure: ArriveByFailure | null;
}

export type ArriveByReply = {
  readonly requestId: number;
  readonly generation: number;
} & (
  | { readonly kind: "latest" | "complete"; readonly result: unknown }
  | { readonly kind: "failed"; readonly failure: ArriveByFailure }
);

class ResultContractError extends Error {}

function requireContract(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ResultContractError(message);
}

function record(value: unknown): Record<string, unknown> {
  requireContract(value !== null && typeof value === "object" && !Array.isArray(value), "expected result object");
  return value as Record<string, unknown>;
}

function integer(value: unknown): number {
  requireContract(typeof value === "number" && Number.isSafeInteger(value), "unsafe result integer");
  return value;
}

function unsigned(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = integer(value);
  requireContract(n >= 0 && n <= max, "out-of-range result integer");
  return n;
}

const U32_MAX = 0xffff_ffff;
const POINT_KEYS = ["departureSecs", "arrivalSecs", "actualTransfers", "totalWalkSecs", "transitRounds", "serviceDate", "witnessLegs", "witness"];
const WITNESS_KEYS = ["serviceDate", "routeIdx", "readerRouteIdx", "tripIdx", "boardPosition", "alightPosition", "boardSecs", "alightSecs", "frequencyOffsetSecs", "frequencyInstance", "inSeat"];

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  requireContract(actual.length === keys.length && keys.every((k) => Object.hasOwn(value, k)), "result fields changed");
}

function decodeWitness(value: unknown): ArriveByTransitWitness {
  const w = record(value);
  exactKeys(w, WITNESS_KEYS);
  requireContract(typeof w.frequencyInstance === "boolean" && typeof w.inSeat === "boolean", "invalid witness flags");
  const leg = Object.freeze({
    serviceDate: unsigned(w.serviceDate, U32_MAX),
    routeIdx: unsigned(w.routeIdx, U32_MAX),
    readerRouteIdx: unsigned(w.readerRouteIdx, U32_MAX),
    tripIdx: unsigned(w.tripIdx, U32_MAX),
    boardPosition: unsigned(w.boardPosition, U32_MAX),
    alightPosition: unsigned(w.alightPosition, U32_MAX),
    boardSecs: integer(w.boardSecs),
    alightSecs: integer(w.alightSecs),
    frequencyOffsetSecs: integer(w.frequencyOffsetSecs),
    frequencyInstance: w.frequencyInstance,
    inSeat: w.inSeat,
  });
  requireContract(leg.boardPosition < leg.alightPosition && leg.boardSecs <= leg.alightSecs, "invalid transit occurrence");
  return leg;
}

export function decodeArriveByPoint(value: unknown, scope: ArriveByScope): ArriveByPoint | null {
  checkScope(scope);
  if (value === null) return null;
  const p = record(value);
  exactKeys(p, POINT_KEYS);
  requireContract(Array.isArray(p.witness) && p.witness.length > 0 && p.witness.length <= scope.maxRounds, "invalid witness length");
  const point: ArriveByPoint = Object.freeze({
    departureSecs: integer(p.departureSecs),
    arrivalSecs: integer(p.arrivalSecs),
    actualTransfers: unsigned(p.actualTransfers, U32_MAX),
    totalWalkSecs: unsigned(p.totalWalkSecs),
    transitRounds: unsigned(p.transitRounds, U32_MAX),
    serviceDate: unsigned(p.serviceDate, U32_MAX),
    witnessLegs: unsigned(p.witnessLegs, U32_MAX),
    witness: Object.freeze(p.witness.map(decodeWitness)),
  });
  requireContract(point.serviceDate === scope.serviceDate
    && point.departureSecs >= scope.windowStart && point.departureSecs < scope.windowEnd
    && point.arrivalSecs <= scope.arrivalDeadline && point.arrivalSecs >= point.departureSecs,
  "winner outside requested scope");
  const duration = point.arrivalSecs - point.departureSecs;
  requireContract(Number.isSafeInteger(duration) && point.totalWalkSecs <= duration, "invalid journey duration/walking");
  requireContract(point.witnessLegs === point.witness.length && point.transitRounds === point.witness.length, "witness round mismatch");
  let end = point.departureSecs;
  let transfers = 0;
  point.witness.forEach((leg, i) => {
    requireContract(leg.boardSecs >= end && leg.alightSecs <= point.arrivalSecs && (i !== 0 || !leg.inSeat), "nonchronological witness");
    if (i > 0 && !leg.inSeat) transfers++;
    end = leg.alightSecs;
  });
  requireContract(point.actualTransfers === transfers, "passenger transfer mismatch");
  return point;
}

function checkScope(scope: ArriveByScope): void {
  unsigned(scope.serviceDate, U32_MAX);
  integer(scope.windowStart);
  integer(scope.windowEnd);
  integer(scope.arrivalDeadline);
  unsigned(scope.maxRounds, 4);
  requireContract(scope.windowStart < scope.windowEnd && scope.windowEnd - 1 <= scope.arrivalDeadline, "invalid request scope");
}

/** Diagnostic fields are deliberately not consumed as routing/work proof. */
export function decodeArriveByWinners(
  value: unknown,
  scope: ArriveByScope,
  goal: ArriveBySelector | "portfolio",
): ArriveByWinners {
  checkScope(scope);
  requireContract(goal === "portfolio" || ARRIVE_BY_SELECTORS.includes(goal), "invalid winner selector");
  const r = record(value);
  requireContract(r.scope === "deadline-winner-session-wasm-experiment"
    && r.contract === "lexicographic-filter-winners-v1-no-arrival-floor"
    && r.complete === true && r.queryKind === goal
    && r.completionScope === (goal === "portfolio" ? "fixed-selectors-only" : "single-selector-only"),
  "incomplete or incompatible winner certificate");
  requireContract(Array.isArray(r.requestedWindow) && r.requestedWindow.length === 2
    && r.requestedWindow[0] === scope.windowStart && r.requestedWindow[1] === scope.windowEnd
    && r.arrivalDeadline === scope.arrivalDeadline, "winner window/deadline mismatch");
  const raw = record(r.winners);
  exactKeys(raw, goal === "portfolio" ? ARRIVE_BY_SELECTORS : [goal]);
  const out: Record<ArriveBySelector, ArriveByPoint | null> = {
    "latest-departure": null, fastest: null, "least-walking": null, "fewest-transfers": null,
  };
  for (const selector of goal === "portfolio" ? ARRIVE_BY_SELECTORS : [goal]) {
    out[selector] = decodeArriveByPoint(raw[selector], scope);
  }
  if (goal === "portfolio") {
    const present = ARRIVE_BY_SELECTORS.filter((s) => out[s] !== null).length;
    requireContract(present === 0 || present === ARRIVE_BY_SELECTORS.length, "inconsistent empty selectors");
  }
  return Object.freeze(out);
}

/** Fixed field order: object insertion order must not affect canonical identity. */
export function arriveByPointKey(p: ArriveByPoint | null): string {
  return JSON.stringify(p === null ? null : [
    p.departureSecs, p.arrivalSecs, p.actualTransfers, p.totalWalkSecs,
    p.transitRounds, p.serviceDate, p.witnessLegs,
    p.witness.map((w) => WITNESS_KEYS.map((k) => w[k as keyof ArriveByTransitWitness])),
  ]);
}

function optionsFor(winners: ArriveByWinners): readonly ArriveByOption[] {
  const options = new Map<string, { point: ArriveByPoint; selectors: ArriveBySelector[] }>();
  for (const selector of ARRIVE_BY_SELECTORS) {
    const point = winners[selector];
    if (point === null) continue;
    const key = arriveByPointKey(point);
    const existing = options.get(key);
    if (existing) existing.selectors.push(selector);
    else options.set(key, { point, selectors: [selector] });
  }
  return Object.freeze([...options.values()].map((o) => Object.freeze({ ...o, selectors: Object.freeze(o.selectors) })));
}

function state(status: ArriveByResultState["status"], options: readonly ArriveByOption[] = Object.freeze([]), failure: ArriveByFailure | null = null): ArriveByResultState {
  return Object.freeze({ status, options, failure });
}

/**
 * One request, not a cross-query cache. A transport must bind its own request ID
 * and owner generation; structural result decoding cannot establish that link.
 * Cancellation suppresses delivery, not synchronous WASM work already running.
 */
export class ArriveByResultSession {
  private current: ArriveByResultState = state("pending");
  private latest: ArriveByPoint | null = null;
  private readonly scope: ArriveByScope;

  constructor(
    private readonly requestId: number,
    private readonly generation: number,
    scope: ArriveByScope,
    private readonly sequence: ArriveBySequence,
  ) {
    unsigned(requestId);
    unsigned(generation);
    checkScope(scope);
    requireContract(sequence === "portfolio" || sequence === "latest-then-portfolio", "invalid result sequence");
    this.scope = Object.freeze({ ...scope });
  }

  get snapshot(): ArriveByResultState { return this.current; }

  cancel(): void {
    if (this.current.status === "pending" || this.current.status === "latest" || this.current.status === "limited") {
      this.latest = null;
      this.current = state("cancelled");
    }
  }

  /** Returns false for obsolete/terminal replies without inspecting payloads. */
  accept(reply: ArriveByReply): boolean {
    if (reply.requestId !== this.requestId || reply.generation !== this.generation
      || !["pending", "latest"].includes(this.current.status)) return false;
    try {
      if (reply.kind === "failed") {
        const failure = record(reply.failure);
        requireContract(typeof failure.stage === "string"
          && ["availability", "setup", "prepare", "search", "projection", "transport", "contract"].includes(failure.stage)
          && typeof failure.code === "string" && failure.code.length > 0
          && typeof failure.message === "string", "invalid failure envelope");
        const retained = this.latest;
        this.latest = null;
        this.current = retained && isArriveByResourceFailure(reply.failure)
          ? state("limited", optionsFor({ "latest-departure": retained, fastest: null, "least-walking": null, "fewest-transfers": null }), Object.freeze({ ...reply.failure }))
          : state("failed", Object.freeze([]), Object.freeze({ ...reply.failure }));
        return true;
      }
      requireContract(reply.kind === "latest" || reply.kind === "complete", "unknown reply kind");
      const isLatest = reply.kind === "latest";
      requireContract(isLatest
        ? this.sequence === "latest-then-portfolio" && this.current.status === "pending"
        : this.sequence === "portfolio" || this.current.status === "latest", "unexpected result stage");
      const winners = decodeArriveByWinners(reply.result, this.scope, isLatest ? "latest-departure" : "portfolio");
      if (!isLatest && this.sequence === "latest-then-portfolio") {
        requireContract(arriveByPointKey(this.latest) === arriveByPointKey(winners["latest-departure"]), "latest winner changed across stages");
      }
      this.latest = isLatest ? winners["latest-departure"] : null;
      this.current = state(isLatest ? "latest" : "complete", optionsFor(winners));
    } catch (err) {
      this.latest = null;
      this.current = state("failed", Object.freeze([]), Object.freeze({
        stage: "contract", code: "InvalidWinnerResult",
        message: err instanceof Error ? err.message : String(err),
      }));
    }
    return true;
  }
}
