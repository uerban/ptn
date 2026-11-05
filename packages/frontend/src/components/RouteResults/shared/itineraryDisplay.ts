import type { Itinerary, Leg } from "@pt/shared";
import { toSegments, type Segment, type BufferWaitSegment } from "./legHelpers.ts";

/**
 * Caller-supplied context for `deriveItineraryDisplay`. The helper is pure —
 * it never reads `serverTime`, settings, or any other ambient state.
 *   - referenceNowMs: pass `serverTime.now()`. Anchored to the search-result
 *     identity, not wall-clock; stable across scroll/re-renders.
 *   - bufferSeconds: resolved by caller via `selectPreStopBufferSeconds`
 *     (settingsStore). 0 = explicit "no buffer".
 *   - runSpeedRatio: resolved by caller via `selectRunSpeedRatio`.
 */
export interface ItineraryDisplayContext {
  referenceNowMs: number;
  bufferSeconds: number;
  /**
   * How many times faster than their walk the rider runs, set only while
   * run-to-catch is on. Without it nobody is told to run, and a walk the
   * planner timed at a run (`Leg.runToCatch`) is read at face value.
   */
  runSpeedRatio?: number;
  /**
   * Guidance only: the rider is on leg `legIndex` with `remainingFraction` of
   * it still ahead; the legs before it are behind them. Catch status and the
   * leave time then count the walk still to go, not the whole walk — a clock
   * that keeps ticking would otherwise tell someone half-way there to run.
   * A `legIndex` at or past the first ride means the walk is done.
   */
  underway?: { legIndex: number; remainingFraction: number };
  /**
   * Live RT correction of the first ride's departure against the itinerary's
   * own time (live delay − the delay already in the itinerary), in seconds.
   * Negative: the bus is running early.
   */
  firstDepartureShiftSeconds?: number;
  /** Live RT marks the first ride's trip cancelled. */
  firstRideCancelled?: boolean;
  /** Live RT marks the first ride's trip DELETED: removed, not cancelled. */
  firstRideRemoved?: boolean;
}

/**
 * Can the rider still make the first ride from `referenceNowMs`, and how?
 *   - on-time: walking normally leaves at least a minute at the stop.
 *   - tight: walking normally gets there with under a minute to spare.
 *   - hurry: walking is too slow, but a run still makes it (run-to-catch on).
 *   - likely-miss: neither a walk nor, where allowed, a run makes it.
 *   - departed: the first ride has already left.
 *   - cancelled: live data says the first ride is not running at all.
 *   - removed: live data DELETED the first ride — it "must not be shown to
 *     users … not shown as cancelled", e.g. replaced by substitute service.
 *     Said neutrally ("no longer scheduled"), never as a cancellation.
 */
export type CatchStatus =
  | "on-time"
  | "tight"
  | "hurry"
  | "likely-miss"
  | "departed"
  | "cancelled"
  | "removed";

/** Less time than this at the stop after walking there is a "tight" catch. */
const TIGHT_SLACK_MS = 60_000;

export interface ItineraryDisplay {
  /**
   * Recommended time to leave the origin: first transit dep − bufferSeconds −
   * the walk to the boarding stop, clamped to referenceNowMs — and
   * referenceNowMs itself when `catchStatus` is "hurry".
   */
  recommendedDepartureMs: number;
  /**
   * First transit leg's departureTime in ms (parsed once here so callers
   * don't re-parse ISO strings), moved by `firstDepartureShiftSeconds`. NaN
   * when parseFailed; equal to referenceNowMs for walk-only itineraries (no
   * transit at all).
   */
  firstTransitDepartureMs: number;
  /**
   * Buffer actually applied (≤ ctx.bufferSeconds). 0 when caller passed 0,
   * when clamp shrank to 0, or when itinerary has no transit.
   */
  bufferSeconds: number;
  /** recommendedDepartureMs − referenceNowMs, clamped at 0. */
  leadingWaitSeconds: number;
  /**
   * `toSegments(itinerary)` with a `BufferWaitSegment` spliced before the first
   * ride leg (only when applied bufferSeconds ≥ 60).
   */
  segments: Segment[];
  /**
   * `itinerary.legs` for the leg-by-leg rows, with the walk ahead of the first
   * ride re-timed to start at `recommendedDepartureMs`. The planner starts that
   * walk at the search time and leaves the rest of the gap unrepresented, so
   * its own times contradict the leave hint. Every other leg is the engine's
   * own object; the array IS `itinerary.legs` when nothing is re-timed.
   */
  legs: Leg[];
  /** True when applied buffer < ctx.bufferSeconds because the engine left less slack. */
  bufferClamped: boolean;
  /** True when the first transit leg's departure is at or before referenceNowMs. */
  alreadyDeparted: boolean;
  /** True when ISO parse failed for any leg used in derivation. UI hides buffer chrome entirely. */
  parseFailed: boolean;
  /** See `CatchStatus`. null when there is no ride to catch or the times are unusable. */
  catchStatus: CatchStatus | null;
}

/** Index of the first non-WALK leg, or -1 if none (walk-only itinerary). */
function findFirstTransitIndex(legs: Itinerary["legs"]): number {
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].mode !== "WALK") return i;
  }
  return -1;
}

/** `runSpeedRatio` when it can speed a rider up; anything else means "don't run". */
function usableRunRatio(ratio: number | undefined): number | undefined {
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio > 1 ? ratio : undefined;
}

/**
 * Seconds this access leg takes at the chosen pace. The planner's duration is
 * a walking time, or a running time when it flagged `runToCatch`; `ratio`
 * converts between the two. Without a ratio it is read at face value.
 */
function legPaceSeconds(leg: Leg, running: boolean, ratio: number | undefined): number {
  const s = Math.max(0, leg.durationSeconds);
  if (ratio === undefined) return s;
  if (running) return leg.runToCatch ? s : s / ratio;
  return leg.runToCatch ? s * ratio : s;
}

/** Fraction of access leg `i` still ahead of the rider — 1 when not underway. */
function remainingShare(
  i: number,
  firstTransitIdx: number,
  underway: ItineraryDisplayContext["underway"],
): number {
  if (!underway) return 1;
  if (underway.legIndex >= firstTransitIdx || i < underway.legIndex) return 0;
  if (i > underway.legIndex) return 1;
  const f = underway.remainingFraction;
  return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 1;
}

/**
 * Milliseconds from the origin — or from where an underway rider is — to the
 * first boarding stop at the chosen pace: the WALK legs ahead of the first
 * transit leg. The leave time has to come off
 * this: the pre-stop buffer is time spent AT the stop, so "departure − buffer"
 * is when to be at the stop, not when to set off. NaN when a leg's duration is
 * unusable, so the caller hides the chrome rather than announcing a leave time
 * that silently drops the walk.
 */
function accessMs(
  legs: Leg[],
  firstTransitIdx: number,
  running: boolean,
  ratio: number | undefined,
  underway?: ItineraryDisplayContext["underway"],
): number {
  let total = 0;
  for (let i = 0; i < firstTransitIdx; i++) {
    if (!Number.isFinite(legs[i].durationSeconds)) return NaN;
    total += legPaceSeconds(legs[i], running, ratio) * remainingShare(i, firstTransitIdx, underway);
  }
  return Math.round(total * 1000);
}

/**
 * Re-time the legs ahead of the first ride to run back to back, whole, at the
 * chosen pace, ending when the rider reaches the boarding stop
 * (`arriveAtStopMs`). Stacked back from the stop so an underway rider's walk
 * row still spans the whole walk and ends where the remaining walk does.
 * `runToCatch` on a shown leg keeps its meaning — its duration is a running
 * time — so it is set only when running.
 */
function retimeAccessWalk(
  legs: Leg[],
  firstTransitIdx: number,
  arriveAtStopMs: number,
  running: boolean,
  ratio: number | undefined,
): Leg[] {
  if (firstTransitIdx <= 0) return legs;
  const out = legs.slice();
  let t = arriveAtStopMs;
  for (let i = firstTransitIdx - 1; i >= 0; i--) {
    const leg = legs[i];
    const legMs = Math.round(legPaceSeconds(leg, running, ratio) * 1000);
    const shown: Leg = {
      ...leg,
      departureTime: new Date(t - legMs).toISOString(),
      arrivalTime: new Date(t).toISOString(),
      durationSeconds: Math.round(legMs / 1000),
    };
    if (ratio !== undefined) {
      if (running) shown.runToCatch = true;
      else delete shown.runToCatch;
    }
    out[i] = shown;
    t -= legMs;
  }
  return out;
}

/**
 * Derive the display shape for an itinerary card.
 *
 * Behaviour by case:
 *   - Walk-only itinerary: no buffer, segments unchanged, catchStatus null.
 *   - First transit leg dep or the access walk's duration is unusable:
 *     parseFailed: true; UI hides buffer chrome.
 *   - First transit leg dep ≤ referenceNow: alreadyDeparted: true; segments unchanged.
 *   - Caller passes bufferSeconds ≤ 0: no buffer chrome; catchStatus and the
 *     re-timed walk still apply.
 *   - Slack left after walking to the stop < ctx.bufferSeconds: shrink
 *     (bufferClamped: true). No slack at all: no buffer, catchStatus says
 *     whether a run still makes it.
 *   - Sub-minute applied buffer (< 60s): no segment emitted, bufferSeconds preserved.
 *
 * `recommendedDepartureMs` is always clamped at `referenceNowMs`;
 * `leadingWaitSeconds` = max(0, recommendedDepartureMs − referenceNowMs).
 */
export function deriveItineraryDisplay(
  itinerary: Itinerary,
  ctx: ItineraryDisplayContext,
): ItineraryDisplay {
  const segments = toSegments(itinerary);
  const firstTransitIdx = findFirstTransitIndex(itinerary.legs);

  // Walk-only itinerary
  if (firstTransitIdx === -1) {
    return {
      recommendedDepartureMs: new Date(itinerary.departureTime).getTime(),
      firstTransitDepartureMs: ctx.referenceNowMs,
      bufferSeconds: 0,
      leadingWaitSeconds: 0,
      segments,
      legs: itinerary.legs,
      bufferClamped: false,
      alreadyDeparted: false,
      parseFailed: false,
      catchStatus: null,
    };
  }

  const firstTransit = itinerary.legs[firstTransitIdx];
  const shiftMs = Number.isFinite(ctx.firstDepartureShiftSeconds)
    ? (ctx.firstDepartureShiftSeconds as number) * 1000
    : 0;
  const firstTransitDepMs = new Date(firstTransit.departureTime).getTime() + shiftMs;
  const ratio = usableRunRatio(ctx.runSpeedRatio);
  const walkMs = accessMs(itinerary.legs, firstTransitIdx, false, ratio, ctx.underway);

  // Fail-soft on ISO parse failure — UI hides buffer chrome entirely
  if (!Number.isFinite(firstTransitDepMs) || !Number.isFinite(walkMs)) {
    return {
      recommendedDepartureMs: ctx.referenceNowMs,
      firstTransitDepartureMs: NaN,
      bufferSeconds: 0,
      leadingWaitSeconds: 0,
      segments,
      legs: itinerary.legs,
      bufferClamped: false,
      alreadyDeparted: false,
      parseFailed: true,
      catchStatus: null,
    };
  }

  // Cancelled — nothing to catch and no walk to time: no buffer, the plan's
  // own rows. Checked before the departure time, because a cancelled bus
  // never left; firstTransitDepartureMs stays so the next one can be found.
  if (ctx.firstRideCancelled || ctx.firstRideRemoved) {
    return {
      recommendedDepartureMs: ctx.referenceNowMs,
      firstTransitDepartureMs: firstTransitDepMs,
      bufferSeconds: 0,
      leadingWaitSeconds: 0,
      segments,
      legs: itinerary.legs,
      bufferClamped: false,
      alreadyDeparted: false,
      parseFailed: false,
      catchStatus: ctx.firstRideRemoved ? "removed" : "cancelled",
    };
  }

  // Past departure — fall back to original segments, no buffer
  if (firstTransitDepMs <= ctx.referenceNowMs) {
    return {
      recommendedDepartureMs: firstTransitDepMs,
      firstTransitDepartureMs: firstTransitDepMs,
      bufferSeconds: 0,
      leadingWaitSeconds: 0,
      segments,
      legs: itinerary.legs,
      bufferClamped: false,
      alreadyDeparted: true,
      parseFailed: false,
      catchStatus: "departed",
    };
  }

  // Walking pace first; a run only when walking no longer makes it. A NaN
  // run time (run-to-catch off) fails the comparison and reads as a miss.
  const slackMs = firstTransitDepMs - walkMs - ctx.referenceNowMs;
  const runMs =
    ratio !== undefined
      ? accessMs(itinerary.legs, firstTransitIdx, true, ratio, ctx.underway)
      : NaN;
  const catchStatus: CatchStatus =
    slackMs >= TIGHT_SLACK_MS
      ? "on-time"
      : slackMs >= 0
        ? "tight"
        : firstTransitDepMs - runMs - ctx.referenceNowMs >= 0
          ? "hurry"
          : "likely-miss";
  const running = catchStatus === "hurry";

  // Compute applied buffer: full unless the slack left after walking to the
  // stop is shorter. Negative slack (the walk alone no longer fits) applies no
  // buffer and clamps the leave time to now. A caller-disabled buffer applies
  // none and suppresses the buffer chrome.
  const bufferOff = ctx.bufferSeconds <= 0;
  const requestedBufferMs = bufferOff ? 0 : ctx.bufferSeconds * 1000;
  const appliedBufferMs = Math.max(0, Math.min(requestedBufferMs, slackMs));
  const appliedBufferSecs = Math.floor(appliedBufferMs / 1000);
  const bufferClamped = appliedBufferMs < requestedBufferMs;

  // Hurrying means going now: a run that could start a minute later is a run
  // with no margin at all.
  const recommendedDepartureMs = running
    ? ctx.referenceNowMs
    : Math.max(ctx.referenceNowMs, firstTransitDepMs - walkMs - appliedBufferMs);
  // With the buffer off the hint is suppressed, and it keys off this — keep it
  // 0 rather than the raw gap.
  const leadingWaitSeconds = bufferOff
    ? 0
    : Math.max(0, Math.floor((recommendedDepartureMs - ctx.referenceNowMs) / 1000));

  const displayLegs = retimeAccessWalk(
    itinerary.legs,
    firstTransitIdx,
    recommendedDepartureMs + (running ? runMs : walkMs),
    running,
    ratio,
  );
  // Rebuilt from the shown legs so the bar agrees with the rows when the walk
  // is shown at a different pace than the planner timed it.
  const shownSegments =
    displayLegs === itinerary.legs ? segments : toSegments({ ...itinerary, legs: displayLegs });

  // Splice BufferWaitSegment only when applied buffer ≥ 60s
  let displaySegments: Segment[] = shownSegments;
  if (appliedBufferSecs >= 60) {
    const bufferSeg: BufferWaitSegment = {
      kind: "buffer-wait",
      seconds: appliedBufferSecs,
      atStopName: firstTransit.from.name,
    };
    const firstRideSegIdx = shownSegments.findIndex((s) => s.kind === "ride");
    if (firstRideSegIdx === -1) {
      // Defensive: if toSegments emitted no ride (shouldn't happen when
      // firstTransitIdx >= 0), prepend the buffer.
      displaySegments = [bufferSeg, ...shownSegments];
    } else {
      displaySegments = [
        ...shownSegments.slice(0, firstRideSegIdx),
        bufferSeg,
        ...shownSegments.slice(firstRideSegIdx),
      ];
    }
  }

  return {
    recommendedDepartureMs,
    firstTransitDepartureMs: firstTransitDepMs,
    bufferSeconds: appliedBufferSecs,
    leadingWaitSeconds,
    segments: displaySegments,
    legs: displayLegs,
    bufferClamped,
    alreadyDeparted: false,
    parseFailed: false,
    catchStatus,
  };
}

/**
 * What a header says about the trip — the card's "17:34 → 18:21 · 47 min",
 * guidance's "Arrive 18:21 · 47 min", the spoken length. The trip starts when
 * the rider sets off (the re-timed first leg; a trip that starts on the bus
 * starts when the bus leaves), not when the planner started counting — that
 * was the search time, which made an 84-min wait at home part of a 26-min
 * trip. A single-ride trip arrives as early or late as live data moves that
 * ride; with a transfer the later rides are on the timetable, so the
 * arrival stays as planned. Once the first ride has gone or been cancelled,
 * or the times are unusable, the itinerary's own figures.
 */
export function shownTripSpan(
  itinerary: Itinerary,
  display: ItineraryDisplay,
): { departureTime: string; arrivalTime: string; durationSeconds: number } {
  const own = {
    departureTime: itinerary.departureTime,
    arrivalTime: itinerary.arrivalTime,
    durationSeconds: itinerary.durationSeconds,
  };
  const start = display.legs[0];
  if (
    display.parseFailed ||
    display.alreadyDeparted ||
    display.catchStatus === "cancelled" ||
    display.catchStatus === "removed" ||
    !start
  ) {
    return own;
  }

  const rides = itinerary.legs.filter((l) => l.mode !== "WALK");
  let arrivalTime = itinerary.arrivalTime;
  if (rides.length === 1) {
    const shiftMs = display.firstTransitDepartureMs - Date.parse(rides[0].departureTime);
    if (Number.isFinite(shiftMs) && shiftMs !== 0) {
      arrivalTime = new Date(Date.parse(itinerary.arrivalTime) + shiftMs).toISOString();
    }
  }
  const durationMs = Date.parse(arrivalTime) - Date.parse(start.departureTime);
  if (!Number.isFinite(durationMs)) return own;
  return {
    departureTime: start.departureTime,
    arrivalTime,
    durationSeconds: Math.max(0, Math.round(durationMs / 1000)),
  };
}
