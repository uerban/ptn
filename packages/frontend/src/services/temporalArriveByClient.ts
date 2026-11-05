/**
 * Page-side client of the opt-in arrive-by owner in its own worker (H74). Only
 * an opt-in build bundles it, through `temporalArriveByLink.ts`; the default
 * entry hands `buildPtRouter` no link.
 *
 * A search runs four bounded requests: the latest with the H58 reverse scan, then fastest on the full
 * window, then fewest transfers and least walking with the H81 reverse scan.
 * The later three use the walking and transfer bounds. The fastest search
 * stops where the latest winner's duration proves it can (H86). The owner worker is
 * serial and a running request cannot be stopped (H61), so cancelling
 * suppresses delivery and later posts, not work already running.
 *
 * Times are GTFS `Time` in one service day's frame: seconds from noon minus
 * 12h, so a frame is linear in elapsed time across DST and past 24:00.
 * https://gtfs.org/documentation/schedule/reference/#field-types
 */
import type { ResolvedServiceTime } from "./raptorWasm.ts";
import type { ArriveByWarmReply } from "./ptArriveByOwnerHost.ts";
import type { ArriveByMovementScope, ArriveByJourneyOption } from "./temporalArriveByJourneys.ts";
import type {
  ArriveByLatestScan, ArriveByOwnerMarks, ArriveByOwnerOutcome, ArriveByOwnerRequest, ArriveByOwnerState,
} from "./temporalArriveByOwner.ts";
import {
  ARRIVE_BY_SELECTORS, isArriveByResourceFailure, arriveByPointKey, type ArriveByFailure, type ArriveBySelector,
} from "./temporalArriveByResults.ts";
import type { StopWalk } from "@pt/shared";

/** One owner-worker request without its id; the link assigns ids. */
export type ArriveByWireRequest =
  | { op: "setArriveByEnabled"; enabled: boolean }
  | { op: "arriveBy"; request: ArriveByOwnerRequest }
  | { op: "arriveByWarm"; request: Omit<ArriveByOwnerRequest, "generation"> }
  | { op: "arriveByCancelWarm" };
/** Resolves to the reply value; rejects when the worker answers with an error
 * or cannot answer (freed, crashed). */
export type ArriveByCall = (req: ArriveByWireRequest) => Promise<unknown>;

export interface ArriveBySearchInput {
  readonly scope: ArriveByMovementScope;
  readonly mobilityProfile: ArriveByOwnerRequest["mobilityProfile"];
  /** GTFS route types, as the normal planner's `excludedModes`. */
  readonly excludedModes: readonly number[];
  readonly excludedRouteIds?: readonly string[];
  readonly walkSpeedMps: ArriveByOwnerRequest["walkSpeedMps"];
  readonly minTransferSecs: ArriveByOwnerRequest["minTransferSecs"];
}

/** Epoch milliseconds on the page; owner marks are the worker's. */
export interface ArriveBySearchMarks {
  readonly start: number;
  readonly latest?: number;
  readonly complete?: number;
}
export interface ArriveBySearchState {
  readonly status: "pending" | "latest" | "complete" | "limited" | "failed" | "cancelled";
  /** Latest first. `latest` holds the latest option only (or none). */
  readonly options: readonly ArriveByJourneyOption[];
  readonly failure: ArriveByFailure | null;
  readonly latestScan: ArriveByLatestScan | null;
  /** The H81 scans of the fewest-transfers and least-walking requests. */
  readonly selectorScans: Readonly<Record<"fewest-transfers" | "least-walking", ArriveByLatestScan | null>>;
  /** Where the latest option came from: this search, or an H72 warm-up. */
  readonly latestSource: "request" | "warm-up" | null;
  readonly marks: ArriveBySearchMarks;
  /** Worker marks of each request that ran, by selector. */
  readonly ownerMarks: Readonly<Record<ArriveBySelector, ArriveByOwnerMarks | null>>;
}
export interface ArriveBySearch {
  readonly done: Promise<ArriveBySearchState>;
  cancel(): void;
}
/** `constructed`: the owner was built, but the query yielded to a request
 * that arrived meanwhile. */
export type ArriveByWarmResult = "ran" | "failed" | "dropped" | "constructed" | "skipped";

export interface ArriveByChannel {
  /** The owner state the worker last reported; null before any report. */
  state(): ArriveByOwnerState | null;
  setEnabled(enabled: boolean): Promise<ArriveByOwnerState>;
  /** H72: start the owner on arrive-by intent with the likely query. */
  warm(input: ArriveBySearchInput): Promise<ArriveByWarmResult>;
  /** Starts a search and cancels the previous one. */
  search(input: ArriveBySearchInput, onUpdate?: (state: ArriveBySearchState) => void): ArriveBySearch;
  /** The link passes each transfer update's owner state here. */
  observeTransfers(value: unknown): void;
  /** Immediately revoke displayed/in-flight certificates, before a queued worker update. */
  invalidateInputs(): void;
}

/** The measured `early-4h` shape, not a chosen product window. */
export const ARRIVE_BY_WINDOW_SECS = 4 * 3600;

/**
 * The scope for a deadline, in the frame of the window's start:
 * `windowStart` is the deadline instant minus `ARRIVE_BY_WINDOW_SECS`, resolved
 * by the bundle (`PtRouterHandle.resolveTime`), so the deadline may pass
 * 24:00 in that frame, as GTFS times do.
 */
export function arriveByScope(
  windowStart: ResolvedServiceTime,
  entryStops: readonly StopWalk[],
  exitStops: readonly StopWalk[],
  maxRounds = 4,
): ArriveByMovementScope {
  const serviceDate = Number(windowStart.serviceDate);
  const start = windowStart.departureSecs;
  const deadline = start + ARRIVE_BY_WINDOW_SECS;
  return {
    serviceDate, windowStart: start, windowEnd: deadline + 1, arrivalDeadline: deadline, maxRounds,
    entryStops: entryStops.map((s) => ({ stopId: s.stopId, walkSecs: s.walkSecs })),
    exitStops: exitStops.map((s) => ({ stopId: s.stopId, walkSecs: s.walkSecs })),
  };
}

function now(): number { return performance.timeOrigin + performance.now(); }
function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }

type Stage = Pick<ArriveByOwnerRequest, "latestStage" | "walkingTransferBounds"> & { readonly goal: ArriveBySelector };
// The latest stage keeps its selected configuration (H58/H76). The later
// stages use the configuration the H81 audit checked: walking and transfer
// bounds, fastest on the full window, the other two by the selector scan.
const LATEST: Stage = { goal: "latest-departure", latestStage: "reverse-scan", walkingTransferBounds: false };
const LATER: readonly Stage[] = [
  { goal: "fastest", latestStage: "full-window", walkingTransferBounds: true },
  { goal: "fewest-transfers", latestStage: "reverse-scan", walkingTransferBounds: true },
  { goal: "least-walking", latestStage: "reverse-scan", walkingTransferBounds: true },
];

function body(input: ArriveBySearchInput, stage: Stage): Omit<ArriveByOwnerRequest, "generation"> {
  const s = input.scope;
  return {
    scope: {
      serviceDate: s.serviceDate, windowStart: s.windowStart, windowEnd: s.windowEnd,
      arrivalDeadline: s.arrivalDeadline, maxRounds: s.maxRounds,
      entryStops: s.entryStops.map((x) => ({ stopId: x.stopId, walkSecs: x.walkSecs })),
      exitStops: s.exitStops.map((x) => ({ stopId: x.stopId, walkSecs: x.walkSecs })),
    },
    goal: stage.goal, latestStage: stage.latestStage, prefixPolicy: "timetable-prepared",
    walkingTransferBounds: stage.walkingTransferBounds, durationBound: null,
    mobilityProfile: input.mobilityProfile, excludedModes: [...input.excludedModes],
    ...(input.excludedRouteIds?.length ? { excludedRouteIds: [...input.excludedRouteIds] } : {}),
    walkSpeedMps: input.walkSpeedMps, minTransferSecs: input.minTransferSecs,
  };
}

/** Field order is fixed here, so equal requests give equal keys. */
function requestKey(r: ArriveByOwnerRequest): string {
  const s = r.scope;
  return JSON.stringify([r.generation, r.goal, r.latestStage, r.prefixPolicy, r.walkingTransferBounds, r.durationBound, r.mobilityProfile, r.excludedModes, r.excludedRouteIds ?? [],
    r.walkSpeedMps, r.minTransferSecs, s.serviceDate, s.windowStart, s.windowEnd, s.arrivalDeadline, s.maxRounds,
    s.entryStops.map((x) => [x.stopId, x.walkSecs]), s.exitStops.map((x) => [x.stopId, x.walkSecs])]);
}

function isState(value: unknown): value is ArriveByOwnerState {
  const v = value as ArriveByOwnerState | null;
  return v !== null && typeof v === "object" && Number.isSafeInteger(v.generation) && typeof v.enabled === "boolean";
}
function isOutcome(value: unknown): value is ArriveByOwnerOutcome {
  const v = value as ArriveByOwnerOutcome | null;
  return v !== null && typeof v === "object" && typeof v.ok === "boolean" && isState(v.state)
    && (v.ok ? Array.isArray(v.options) : v.failure !== null && typeof v.failure === "object");
}

class SearchFailure extends Error {
  constructor(readonly failure: ArriveByFailure) { super(failure.message); }
}

function disagree(message: string): SearchFailure {
  return new SearchFailure({ stage: "contract", code: "SelectorsDisagree", message });
}

/** One option per distinct winner, in the portfolio's selector order. Each
 * stage has exactly one winner once the latest stage found a journey; none
 * departs after the latest; a shared winner has one movement. */
function mergeStages(byGoal: ReadonlyMap<ArriveBySelector, readonly ArriveByJourneyOption[]>): readonly ArriveByJourneyOption[] {
  const latest = byGoal.get("latest-departure")![0]!.journey.point.departureSecs;
  const merged = new Map<string, { journey: ArriveByJourneyOption["journey"]; movement: string; selectors: ArriveBySelector[] }>();
  for (const goal of ARRIVE_BY_SELECTORS) {
    const options = byGoal.get(goal)!;
    if (options.length !== 1 || options[0]!.selectors.length !== 1 || options[0]!.selectors[0] !== goal) {
      throw disagree(`${goal} stage did not return its one winner`);
    }
    const journey = options[0]!.journey;
    if (journey.point.departureSecs > latest) throw disagree(`${goal} winner departs after the latest`);
    const key = arriveByPointKey(journey.point), movement = JSON.stringify(journey);
    const previous = merged.get(key);
    if (!previous) merged.set(key, { journey, movement, selectors: [goal] });
    else if (previous.movement !== movement) throw disagree(`${goal} winner has another movement`);
    else previous.selectors.push(goal);
  }
  return Object.freeze([...merged.values()].map(({ journey, selectors }) =>
    Object.freeze({ journey, selectors: Object.freeze(selectors) })));
}

export function createArriveByChannel(call: ArriveByCall): ArriveByChannel {
  let current: ArriveByOwnerState | null = null;
  let enabling: Promise<ArriveByOwnerState> | null = null;
  // One successful warm-up result, used once by an identical request.
  let warmed: { key: string; body: string; outcome: ArriveByOwnerOutcome } | null = null;
  let warming: { body: string; promise: Promise<ArriveByWarmResult> } | null = null;
  let active: { cancel(): void; invalidateContext(): void } | null = null;
  let displayed: { invalidate(): void; invalidateContext(): void } | null = null;
  let contextRevision = 0;

  const observe = (state: ArriveByOwnerState): void => {
    if (current && state.generation < current.generation) return;
    if (current && state.generation !== current.generation) {
      warmed = null;
      displayed?.invalidateContext(); displayed = null;
      active?.invalidateContext();
    }
    current = state;
  };

  const setEnabled = async (enabled: boolean): Promise<ArriveByOwnerState> => {
    const value = await call({ op: "setArriveByEnabled", enabled });
    if (!isState(value)) throw new Error("invalid arrive-by state reply");
    observe(value);
    return value;
  };
  const ensureEnabled = (): Promise<ArriveByOwnerState> => {
    if (current?.enabled) return Promise.resolve(current);
    enabling ??= setEnabled(true).finally(() => { enabling = null; });
    return enabling;
  };

  const run = async (request: ArriveByOwnerRequest): Promise<ArriveByOwnerOutcome> => {
    let value: unknown;
    try { value = await call({ op: "arriveBy", request }); }
    catch (err) { throw new SearchFailure({ stage: "transport", code: "WorkerUnavailable", message: message(err) }); }
    if (!isOutcome(value)) throw new SearchFailure({ stage: "contract", code: "InvalidOwnerReply", message: "invalid arrive-by reply" });
    observe(value.state);
    return value;
  };

  const warm = (input: ArriveBySearchInput): Promise<ArriveByWarmResult> => {
    const revision = contextRevision;
    const stageBody = body(input, LATEST);
    const bodyKey = JSON.stringify(stageBody);
    if (active || warming?.body === bodyKey || warmed?.body === bodyKey) return Promise.resolve("skipped");
    // Post the enable and the warm-up back to back: the warm-up waits for the
    // enable in the worker queue, where a later request can still drop it.
    ensureEnabled().catch(() => {});
    const promise = call({ op: "arriveByWarm", request: stageBody }).then((value): ArriveByWarmResult => {
      if (revision !== contextRevision) return "dropped";
      const reply = value as ArriveByWarmReply | null;
      if (reply?.dropped === true) return reply.constructed === true ? "constructed" : "dropped";
      if (reply?.dropped !== false || !isOutcome(reply.outcome)) return "failed";
      observe(reply.outcome.state);
      if (!reply.outcome.ok) return "failed";
      warmed = { key: requestKey(reply.request), body: bodyKey, outcome: reply.outcome };
      return "ran";
    }, (): ArriveByWarmResult => "failed");
    const entry = { body: bodyKey, promise };
    warming = entry;
    void promise.then(() => { if (warming === entry) warming = null; });
    return promise;
  };

  const search = (input: ArriveBySearchInput, onUpdate?: (state: ArriveBySearchState) => void): ArriveBySearch => {
    // Both stages share a copied input snapshot, even if a caller mutates its input.
    const latestBody = body(input, LATEST);
    displayed?.invalidate(); displayed = null;
    active?.cancel();
    // A warm-up for another query that has not started yet yields to this
    // search instead of running first (one that has started cannot stop).
    if (warming && warming.body !== JSON.stringify(latestBody)) {
      void call({ op: "arriveByCancelWarm" }).catch(() => {});
    }
    let cancelled = false, terminal = false;
    let certifiedLatest: readonly ArriveByJourneyOption[] = [];
    let requestGeneration: number | null = null;
    const marks: { start: number; latest?: number; complete?: number } = { start: now() };
    const ownerMarks: Record<ArriveBySelector, ArriveByOwnerMarks | null> = {
      "latest-departure": null, fastest: null, "fewest-transfers": null, "least-walking": null };
    const selectorScans: Record<"fewest-transfers" | "least-walking", ArriveByLatestScan | null> = {
      "fewest-transfers": null, "least-walking": null };
    let latestScan: ArriveByLatestScan | null = null, latestSource: ArriveBySearchState["latestSource"] = null;
    const snapshot = (status: ArriveBySearchState["status"], options: readonly ArriveByJourneyOption[] = [],
      failure: ArriveByFailure | null = null): ArriveBySearchState => Object.freeze({
      status, options: Object.freeze([...options]), failure, latestScan, selectorScans: Object.freeze({ ...selectorScans }),
      latestSource, marks: Object.freeze({ ...marks }), ownerMarks: Object.freeze({ ...ownerMarks }),
    });
    let last = snapshot("pending");
    const emit = (state: ArriveBySearchState): ArriveBySearchState => {
      last = state;
      if (state.options.length) displayed = handle;
      else if (displayed === handle) displayed = null;
      if (state.status !== "pending" && state.status !== "latest") terminal = true;
      onUpdate?.(state);
      return state;
    };
    const handle = {
      invalidateContext(): void {
        if (cancelled || requestGeneration === null) return;
        cancelled = true;
        certifiedLatest = [];
        emit(snapshot("failed", [], { stage: "availability", code: "InputChanged", message: "Routing context changed; search again." }));
      },
      invalidate(): void {
        if (cancelled) return;
        cancelled = true;
        certifiedLatest = [];
        emit(snapshot("cancelled"));
      },
      cancel(): void {
        if (cancelled || (terminal && last.status !== "limited")) return;
        handle.invalidate();
      },
    };
    active = handle;

    const latestOutcome = async (request: ArriveByOwnerRequest): Promise<ArriveByOwnerOutcome> => {
      const key = requestKey(request);
      // An identical warm-up still in flight answers this request instead of
      // a second one queued behind it.
      if (warmed?.key !== key && warming?.body === JSON.stringify(latestBody)) await warming.promise;
      if (warmed?.key === key) {
        const hit = warmed.outcome; warmed = null; latestSource = "warm-up";
        return hit;
      }
      latestSource = "request";
      return run(request);
    };

    const done = (async (): Promise<ArriveBySearchState> => {
      emit(last);
      try {
        let state: ArriveByOwnerState;
        try { state = await ensureEnabled(); }
        catch (err) { throw new SearchFailure({ stage: "availability", code: "RuntimeUnavailable", message: message(err) }); }
        if (cancelled) return last;
        const generation = state.generation;
        requestGeneration = generation;
        const latestRequest = { generation, ...latestBody };
        const latest = await latestOutcome(latestRequest);
        if (cancelled) return last;
        ownerMarks["latest-departure"] = latest.marks; latestScan = latest.latestScan;
        if (!latest.ok) throw new SearchFailure(latest.failure);
        if (latest.state.generation !== generation || current?.generation !== generation || latest.options.length > 1) {
          throw new SearchFailure({ stage: "contract", code: "InvalidOwnerReply", message: "latest reply does not match its request" });
        }
        marks.latest = now();
        // No journey meets the deadline, so no selector has a winner.
        if (latest.options.length === 0) { marks.complete = marks.latest; return emit(snapshot("complete")); }
        certifiedLatest = latest.options;
        emit(snapshot("latest", latest.options));
        const byGoal = new Map<ArriveBySelector, readonly ArriveByJourneyOption[]>([["latest-departure", latest.options]]);
        // H86: the certified latest winner bounds how long the fastest one takes.
        const latestPoint = latest.options[0]!.journey.point;
        for (const stage of LATER) {
          if (cancelled) return last;
          const durationBound = stage.goal === "fastest" ? latestPoint.arrivalSecs - latestPoint.departureSecs : null;
          const reply = await run({ generation, ...latestBody, ...stage, durationBound });
          if (cancelled) return last;
          ownerMarks[stage.goal] = reply.marks;
          if (stage.goal === "fewest-transfers" || stage.goal === "least-walking") selectorScans[stage.goal] = reply.latestScan;
          if (!reply.ok) throw new SearchFailure(reply.failure);
          if (reply.state.generation !== generation || current?.generation !== generation) {
            throw new SearchFailure({ stage: "contract", code: "InvalidOwnerReply", message: `${stage.goal} reply does not match its request` });
          }
          byGoal.set(stage.goal, reply.options);
        }
        const options = mergeStages(byGoal);
        marks.complete = now();
        return emit(snapshot("complete", options));
      } catch (err) {
        if (cancelled) return last;
        const failure = err instanceof SearchFailure ? err.failure
          : { stage: "contract" as const, code: "ClientError", message: message(err) };
        const retained = certifiedLatest.length === 1 && isArriveByResourceFailure(failure)
          && current?.generation === requestGeneration && current.enabled && current.transfersReady && !current.poisoned;
        return emit(snapshot(retained ? "limited" : "failed", retained ? certifiedLatest : [], Object.freeze({ ...failure })));
      } finally {
        if (active === handle) active = null;
      }
    })();
    return { done, cancel: () => handle.cancel() };
  };

  return {
    state: () => current,
    setEnabled,
    warm,
    search,
    observeTransfers(value: unknown): void { if (isState(value)) observe(value); },
    invalidateInputs(): void {
      contextRevision++;
      warmed = null;
      displayed?.invalidateContext(); displayed = null;
      active?.invalidateContext();
    },
  };
}
