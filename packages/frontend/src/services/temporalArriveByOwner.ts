/**
 * Optional owner for the opt-in owner worker (H74), not another routing engine.
 * Only pt-core decides boarding, directed walking and continuation legality:
 * https://gtfs.org/documentation/schedule/reference/#transferstxt
 * https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes
 *
 * No runtime import here. The opt-in entry must inject the initialized feature
 * package. Source snapshots stay alive even while disabled (for re-enable);
 * freeing an owner does not shrink a WASM runtime's linear-memory high water.
 */
import { decodeArriveByJourneys, type ArriveByJourneyOption, type ArriveByMovementScope } from "./temporalArriveByJourneys.ts";
import { isArriveByResourceLimit, ARRIVE_BY_SELECTORS, type ArriveByFailure, type ArriveBySelector } from "./temporalArriveByResults.ts";

export interface RawArriveByOwner {
  prepare(query: unknown, options: unknown): unknown;
  run_winner_journeys(goal: string, suffix: string): unknown;
  /** H58 backward scan: the latest departure only, never a journey. Builds
   * without it cannot serve `latestStage: "reverse-scan"`. */
  latestDeparture?(query: unknown, windowStart: number, windowEnd: number, arrivalDeadline: number): unknown;
  /** H81 backward scan for `fewest-transfers` / `least-walking`: the optimum
   * and the latest departure achieving it, never a journey. Builds without it
   * cannot narrow those selectors. */
  selectorDeparture?(goal: string, query: unknown, windowStart: number, windowEnd: number, arrivalDeadline: number): unknown;
  /** Drop all request state while preserving immutable input bindings. */
  clear?(): void;
  free(): void;
}
export type ArriveByOwnerFactory = (ptb: Uint8Array, ptft: Uint8Array, mode: string) => RawArriveByOwner;
export interface ArriveByOwnerRequest {
  readonly generation: number;
  readonly scope: ArriveByMovementScope;
  readonly goal: ArriveBySelector | "portfolio";
  /** `reverse-scan` (latest departure, fewest transfers or least walking):
   * find the departure D by a backward scan (H58 latest; H81 the latest
   * departure reaching the selector's optimum), then certify it with the exact
   * selector on [D, D + 1). Without D, or out of the scan's scope, the full
   * window runs as usual. The name predates H81. */
  readonly latestStage: "full-window" | "reverse-scan";
  readonly prefixPolicy: "duration-rebuild" | "timetable-prepared";
  /** The H78 walking and H79 transfer profiles as exact search bounds. */
  readonly walkingTransferBounds: boolean;
  /** H86, `fastest` on the full window only: the certified latest winner's
   * arrival minus its departure. That winner is a fastest candidate, so the
   * fastest winner arrives by `windowEnd - 1` plus this; the search stops
   * there when that is before the deadline. Null everywhere else. */
  readonly durationBound: number | null;
  readonly mobilityProfile: "default" | "wheelchair" | "bicycle";
  readonly excludedModes: readonly number[];
  readonly excludedRouteIds?: readonly string[];
  /** The rider's transfer-walk speed (m/s) and minimum transfer (s), as the
   * normal planner's query sends them. */
  readonly walkSpeedMps: number;
  readonly minTransferSecs: number;
}
export interface ArriveByOwnerState {
  readonly city: string;
  readonly generation: number;
  readonly enabled: boolean;
  readonly transfersReady: boolean;
  readonly poisoned: boolean;
  readonly ownerLive: boolean;
  /** JS source buffers only; excludes normal owner, runtime, indexes and output. */
  readonly retainedInputBytes: number;
  readonly sourceCopyMs: number;
  readonly constructions: number;
  readonly retirements: number;
  readonly retirementMs: number;
}
/** Epoch timestamps, not same-origin performance.now() values. Delivery/paint
 * and queue delay are outside these local marks and must be measured separately. */
export interface ArriveByOwnerMarks {
  start: number;
  end: number;
  constructStart?: number;
  constructEnd?: number;
  constructorCopyBytes?: number;
  scanStart?: number;
  scanEnd?: number;
  prepareStart?: number;
  prepareEnd?: number;
  searchStart?: number;
  searchEnd?: number;
  resetStart?: number;
  resetEnd?: number;
  decodeStart?: number;
  decodeEnd?: number;
}
/** What the reverse first stage did. Only `narrowed` changes the window the
 * selector certifies; every other outcome ran the full window. */
export interface ArriveByLatestScan {
  readonly outcome: "narrowed" | "no-departure" | "out-of-scope" | "scan-failed";
  readonly departure: number | null;
  /** H81 only: the selector's first key at `departure` (passenger transfers
   * or total walk seconds); null for the latest scan. */
  readonly optimum: number | null;
  readonly outOfScope: string | null;
  readonly error: string | null;
  readonly indexBuilt: boolean;
  readonly scanIndexBytes: number | null;
}
export type ArriveByOwnerOutcome = {
  readonly state: ArriveByOwnerState;
  readonly marks: Readonly<ArriveByOwnerMarks>;
  /** Null unless the request asked for `reverse-scan` and reached the scan. */
  readonly latestScan: ArriveByLatestScan | null;
} & (
  | { readonly ok: true; readonly options: readonly ArriveByJourneyOption[] }
  | { readonly ok: false; readonly failure: ArriveByFailure }
);

function now(): number { return performance.timeOrigin + performance.now(); }
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function integer(n: unknown, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): asserts n is number {
  check(typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max, "invalid request integer");
}
function keys(value: object, expected: readonly string[]): void {
  check(Object.keys(value).length === expected.length && expected.every((k) => Object.hasOwn(value, k)), "request fields changed");
}
function validate(req: ArriveByOwnerRequest): void {
  check(req !== null && typeof req === "object", "invalid request");
  keys(req, [...(req.excludedRouteIds === undefined ? [] : ["excludedRouteIds"]), "generation", "scope", "goal", "latestStage", "prefixPolicy", "walkingTransferBounds", "durationBound",
    "mobilityProfile", "excludedModes", "walkSpeedMps", "minTransferSecs"]);
  integer(req.generation, 1);
  check(req.goal === "portfolio" || ARRIVE_BY_SELECTORS.includes(req.goal), "invalid selector");
  check(req.latestStage === "full-window" || req.latestStage === "reverse-scan" && SCAN_GOALS.includes(req.goal),
    "invalid latest stage");
  check(req.prefixPolicy === "duration-rebuild" || req.prefixPolicy === "timetable-prepared", "invalid prefix policy");
  check(typeof req.walkingTransferBounds === "boolean", "invalid bound flag");
  if (req.durationBound !== null) {
    check(req.goal === "fastest" && req.latestStage === "full-window", "duration bound outside the fastest stage");
    integer(req.durationBound, 0);
  }
  check(["default", "wheelchair", "bicycle"].includes(req.mobilityProfile), "invalid mobility profile");
  check(Array.isArray(req.excludedModes), "invalid excluded modes");
  for (const m of req.excludedModes) integer(m, 0, 0xffff);
  if (req.excludedRouteIds !== undefined) check(Array.isArray(req.excludedRouteIds) && req.excludedRouteIds.every((id) => typeof id === "string"), "invalid excluded routes");
  check(typeof req.walkSpeedMps === "number" && Number.isFinite(req.walkSpeedMps) && req.walkSpeedMps > 0,
    "invalid walk speed");
  integer(req.minTransferSecs, 0, 3600);
  const s = req.scope;
  check(s !== null && typeof s === "object", "invalid scope");
  keys(s, ["serviceDate", "windowStart", "windowEnd", "arrivalDeadline", "maxRounds", "entryStops", "exitStops"]);
  integer(s.serviceDate, 10000101, 99991231);
  integer(s.windowStart); integer(s.windowEnd); integer(s.arrivalDeadline); integer(s.maxRounds, 0, 4);
  check(s.windowStart < s.windowEnd && s.windowEnd - 1 <= s.arrivalDeadline, "invalid window/deadline");
  for (const stops of [s.entryStops, s.exitStops]) {
    check(Array.isArray(stops), "invalid stops");
    for (const stop of stops) {
      check(stop !== null && typeof stop === "object", "invalid stop"); keys(stop, ["stopId", "walkSecs"]);
      check(typeof stop.stopId === "string", "invalid stop id"); integer(stop.walkSecs, 0, 0xffff_ffff);
    }
  }
}

/** Selectors with a reverse first stage: H58 latest, H81 the two whose
 * second key is the latest departure. */
const SCAN_GOALS: readonly (ArriveBySelector | "portfolio")[] = ["latest-departure", "fewest-transfers", "least-walking"];

/** The scan's wire is a departure time (and, for H81, the selector's
 * optimum) for this exact window and deadline, never a journey. A malformed
 * wire is contract drift, not a fallback. */
function decodeScan(value: unknown, s: ArriveByMovementScope, goal: ArriveBySelector): ArriveByLatestScan {
  check(value !== null && typeof value === "object", "invalid latest scan");
  const w = value as Record<string, unknown>;
  const selector = goal !== "latest-departure";
  check(selector ? w.schema === "selector-scan-v1" && w.goal === goal : w.schema === "latest-scan-v1", "incompatible latest scan");
  check(Array.isArray(w.window) && w.window.length === 2 && w.window[0] === s.windowStart && w.window[1] === s.windowEnd
    && w.arrivalDeadline === s.arrivalDeadline, "latest scan window/deadline mismatch");
  check(w.outOfScope === null || typeof w.outOfScope === "string" && w.outOfScope.length > 0, "invalid latest scan scope");
  check(w.departure === null || typeof w.departure === "number" && Number.isSafeInteger(w.departure)
    && w.departure >= s.windowStart && w.departure < s.windowEnd && w.outOfScope === null, "invalid latest departure");
  // H81: an optimum exactly when there is a departure.
  check(!selector || (w.departure === null ? w.optimum === null : typeof w.optimum === "number"
    && Number.isSafeInteger(w.optimum) && w.optimum >= 0), "invalid selector optimum");
  check(typeof w.indexBuilt === "boolean" && typeof w.scanIndexBytes === "number"
    && Number.isSafeInteger(w.scanIndexBytes) && w.scanIndexBytes >= 0, "invalid latest scan index");
  const departure = w.departure as number | null, outOfScope = w.outOfScope as string | null;
  return Object.freeze({ outcome: outOfScope !== null ? "out-of-scope" : departure === null ? "no-departure" : "narrowed",
    departure, optimum: selector ? w.optimum as number | null : null, outOfScope, error: null,
    indexBuilt: w.indexBuilt, scanIndexBytes: w.scanIndexBytes });
}

/** Methods must be called on the host queue. No asynchronous prewarm, global
 * cache, shared validation token or clock-now cutoff is introduced. */
export class ArriveByWorkerOwner {
  private owner: RawArriveByOwner | null = null;
  private transfers = new Uint8Array(0);
  private readonly bundle: Uint8Array;
  private generation = 1;
  private enabled = false;
  private transfersReady = true;
  private poisoned = false;
  private sourceCopyMs = 0;
  private constructions = 0;
  private retirements = 0;
  private retirementMs = 0;

  constructor(private readonly factory: ArriveByOwnerFactory, bytes: Uint8Array,
    private readonly mode: string, private readonly city: string) {
    check(typeof city === "string" && city.length > 0, "missing city binding");
    check(["off", "unbounded", "covering-merge"].includes(mode), "invalid pattern mode");
    const began = now(); this.bundle = bytes.slice(); this.sourceCopyMs += now() - began;
  }

  snapshot(): ArriveByOwnerState {
    return Object.freeze({ city: this.city, generation: this.generation, enabled: this.enabled,
      transfersReady: this.transfersReady, poisoned: this.poisoned, ownerLive: this.owner !== null,
      retainedInputBytes: this.bundle.byteLength + this.transfers.byteLength, sourceCopyMs: this.sourceCopyMs,
      constructions: this.constructions, retirements: this.retirements, retirementMs: this.retirementMs });
  }

  private retire(): void {
    const owner = this.owner; this.owner = null;
    if (!owner) return;
    const began = now();
    try { owner.free(); this.retirements++; }
    catch (error) { this.poisoned = true; throw error; }
    finally { this.retirementMs += now() - began; }
  }

  setEnabled(enabled: boolean): ArriveByOwnerState {
    check(typeof enabled === "boolean", "invalid opt-in flag");
    if (this.enabled !== enabled) {
      this.enabled = enabled; this.generation++;
      if (!enabled) this.retire();
    }
    return this.snapshot();
  }

  /** Invalidate BEFORE attempting the normal router update. If that update
   * fails, there is no usable old or new experimental walking table. */
  invalidateTransfers(): void {
    this.generation++; this.transfersReady = false; this.transfers = new Uint8Array(0); this.retire();
  }

  replaceTransfers(bytes: Uint8Array): void {
    check(!this.transfersReady && !this.owner, "transfers were not invalidated");
    const began = now(); this.transfers = bytes.slice(); this.sourceCopyMs += now() - began;
    this.transfersReady = true;
  }

  private build(marks: ArriveByOwnerMarks): void {
    marks.constructStart = now();
    // Protect the retained snapshots even if a factory mutates its inputs.
    marks.constructorCopyBytes = this.bundle.byteLength + this.transfers.byteLength;
    try { this.owner = this.factory(this.bundle.slice(), this.transfers.slice(), this.mode); this.constructions++; }
    finally { marks.constructEnd = now(); }
  }

  /** Builds the owner for the current generation without a query: the first
   * half of an H74 warm-up, so its query can still yield to a request that
   * arrives meanwhile. `ok` when the owner is live afterwards; otherwise the
   * failure a request would have met, with the marks of this attempt. */
  construct(): { readonly ok: true; readonly marks: Readonly<ArriveByOwnerMarks> } | ArriveByOwnerOutcome {
    const marks: ArriveByOwnerMarks = { start: now(), end: 0 };
    let stage: ArriveByFailure["stage"] = "availability";
    let code = "Disabled";
    try {
      check(this.enabled, "arrive-by experiment is disabled");
      code = "TransfersUnavailable"; check(this.transfersReady, "transfer update has not succeeded");
      code = "OwnerPoisoned"; check(!this.poisoned, "owner retirement failed; replace worker");
      if (!this.owner) { stage = "setup"; code = "OwnerConstructionFailed"; this.build(marks); }
      marks.end = now();
      return { ok: true, marks: Object.freeze(marks) };
    } catch (error) {
      marks.end = now();
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, failure: Object.freeze({ stage, code, message }), latestScan: null, state: this.snapshot(), marks: Object.freeze(marks) };
    }
  }

  run(req: ArriveByOwnerRequest): ArriveByOwnerOutcome {
    const marks: ArriveByOwnerMarks = { start: now(), end: 0 };
    let stage: ArriveByFailure["stage"] = "contract";
    let code = "InvalidRequest";
    // A stale/malformed request must not retire another request's valid owner.
    let touchedOwner = false;
    let latestScan: ArriveByLatestScan | null = null;
    try {
      validate(req);
      stage = "availability"; code = "StaleGeneration";
      check(req.generation === this.generation, "stale arrive-by input generation");
      code = "Disabled"; check(this.enabled, "arrive-by experiment is disabled");
      code = "TransfersUnavailable"; check(this.transfersReady, "transfer update has not succeeded");
      code = "OwnerPoisoned"; check(!this.poisoned, "owner retirement failed; replace worker");
      touchedOwner = true;
      if (!this.owner) { stage = "setup"; code = "OwnerConstructionFailed"; this.build(marks); }
      const owner = this.owner as RawArriveByOwner;
      const s = req.scope;
      const query = { entryStops: s.entryStops.map((x) => ({ ...x })), exitStops: s.exitStops.map((x) => ({ ...x })),
        date: String(s.serviceDate), departureSecs: s.windowStart, maxRounds: s.maxRounds,
        mobilityProfile: req.mobilityProfile, excludedModes: [...req.excludedModes],
        ...(req.excludedRouteIds?.length ? { excludedRouteIds: [...req.excludedRouteIds] } : {}),
        walkSpeedMps: req.walkSpeedMps, minTransferSecs: req.minTransferSecs };
      // H83: the stages of one request share the widest catalogue; a later
      // stage's is cut from it by copy, equal to its fresh build.
      const options = { windowStart: s.windowStart, windowEnd: s.windowEnd, arrivalDeadline: s.arrivalDeadline,
        objective: "m4", lookup: "lazy-cached", validation: "session", catalogue: "held-slice", traversal: "arrival-first",
        witnessComparison: "materialized-date-memo", frontierStorage: "event-indexed",
        prefixCertificate: req.prefixPolicy === "timetable-prepared" ? "timetable" : "duration",
        prefixSetup: req.prefixPolicy === "timetable-prepared" ? "prepared" : "rebuild",
        prefixBound: true, pointBound: true, staticBound: false, walkingBound: req.walkingTransferBounds,
        transferBound: req.walkingTransferBounds, forwardSeeds: false,
        maxSegments: 250_000, maxFrontierWidth: 64, maxStopScans: 10_000_000, maxLookupWork: 10_000_000 };
      // H58/H81: the scan only chooses the window; the exact selector below
      // still certifies the winner. Without a departure, out of the scan's
      // scope, or after a scan error, the full window runs as for `full-window`.
      let window: ArriveByMovementScope = s;
      const goal = req.goal as ArriveBySelector;
      const selectorScan = req.latestStage === "reverse-scan" && goal !== "latest-departure";
      if (req.latestStage === "reverse-scan") {
        let wire: unknown, scanError: string | null = null;
        marks.scanStart = now();
        try {
          if (selectorScan) {
            if (typeof owner.selectorDeparture !== "function") throw new Error("owner has no selector scan");
            wire = owner.selectorDeparture(goal, query, s.windowStart, s.windowEnd, s.arrivalDeadline);
          } else {
            if (typeof owner.latestDeparture !== "function") throw new Error("owner has no latest scan");
            wire = owner.latestDeparture(query, s.windowStart, s.windowEnd, s.arrivalDeadline);
          }
        } catch (error) { scanError = error instanceof Error ? error.message : String(error); }
        finally { marks.scanEnd = now(); }
        stage = "contract"; code = selectorScan ? "InvalidSelectorScan" : "InvalidLatestScan";
        latestScan = scanError !== null
          ? Object.freeze({ outcome: "scan-failed", departure: null, optimum: null, outOfScope: null, error: scanError,
            indexBuilt: false, scanIndexBytes: null })
          : decodeScan(wire, s, goal);
        if (latestScan.outcome === "narrowed") {
          const d = latestScan.departure as number;
          window = { ...s, windowStart: d, windowEnd: d + 1 };
        }
      }
      // H86: every journey as fast as the latest winner arrives by
      // windowEnd - 1 + its duration, so a fastest search to there (or to the
      // deadline, if sooner) keeps the winner and all its ties. Window and
      // prefix policy stay; the selector still certifies the winner.
      if (req.durationBound !== null) {
        const bounded = Math.min(s.arrivalDeadline, s.windowEnd - 1 + req.durationBound);
        if (bounded < s.arrivalDeadline) window = { ...s, arrivalDeadline: bounded };
      }
      const boundedFastest = window.arrivalDeadline !== s.arrivalDeadline;
      // H76: on the certified one-second origin window, the duration prefix
      // avoids the timetable profile's setup. The exact selector still proves
      // the complete canonical winner; fallback/portfolio keep their policy.
      const prepared = window === s ? options
        : boundedFastest ? { ...options, arrivalDeadline: window.arrivalDeadline }
        : { ...options, windowStart: window.windowStart, windowEnd: window.windowEnd, prefixCertificate: "duration" };
      stage = "prepare"; code = "PreparationFailed"; marks.prepareStart = now();
      try { owner.prepare(query, prepared); } finally { marks.prepareEnd = now(); }
      // WASM tags typed resource limits; search/replay integrity errors remain
      // unclassified. Never infer recoverability from the message text.
      stage = "search"; code = "WinnerJourneyFailed"; marks.searchStart = now();
      let raw: unknown;
      try { raw = owner.run_winner_journeys(req.goal, "row-prefix"); } finally { marks.searchEnd = now(); }
      stage = "contract"; code = "InvalidMovement"; marks.decodeStart = now();
      let decoded: readonly ArriveByJourneyOption[];
      try { decoded = decodeArriveByJourneys(raw, window, req.goal); } finally { marks.decodeEnd = now(); }
      // The scan found D, so the selector must certify a winner departing at D
      // (the decoder holds it to the window) and, for H81, with the optimum.
      // H86: the latest winner itself is in the bounded scope, so a bounded
      // fastest search must find exactly one winner.
      code = boundedFastest ? "FastestBoundMismatch" : selectorScan ? "SelectorScanMismatch" : "LatestScanMismatch";
      check(window === s || decoded.length === 1,
        boundedFastest ? "fastest bound and selector disagree" : "latest scan and selector disagree");
      if (selectorScan && window !== s) {
        const point = decoded[0]!.journey.point;
        check((goal === "fewest-transfers" ? point.actualTransfers : point.totalWalkSecs) === latestScan?.optimum,
          "selector scan optimum and winner disagree");
      }
      marks.end = now();
      return { ok: true, options: decoded, latestScan, state: this.snapshot(), marks: Object.freeze(marks) };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      const resourceLimit = error !== null && typeof error === "object"
        ? (error as { ptnResourceLimit?: unknown }).ptnResourceLimit : undefined;
      const resettable = (stage === "prepare" || stage === "search") && isArriveByResourceLimit(resourceLimit);
      let retireOwner = touchedOwner;
      if (touchedOwner && resettable && this.owner?.clear) {
        marks.resetStart = now();
        try { this.owner.clear(); retireOwner = false; }
        catch (reset) {
          stage = "setup"; code = "OwnerResetFailed";
          message += `; reset failed: ${reset instanceof Error ? reset.message : String(reset)}`;
        } finally { marks.resetEnd = now(); }
      }
      if (retireOwner) {
        try { this.retire(); }
        catch (retirement) {
          stage = "setup"; code = "OwnerRetirementFailed";
          message += `; retirement failed: ${retirement instanceof Error ? retirement.message : String(retirement)}`;
        }
      }
      marks.end = now();
      const resourceFailure = (stage === "prepare" || stage === "search") && isArriveByResourceLimit(resourceLimit)
        ? { code: "ResourceLimit", resourceLimit } : {};
      return { ok: false, failure: Object.freeze({ stage, code, message, ...resourceFailure }), latestScan, state: this.snapshot(), marks: Object.freeze(marks) };
    }
  }
}
