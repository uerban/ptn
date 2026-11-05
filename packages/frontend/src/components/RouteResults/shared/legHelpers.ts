import type { Itinerary, Leg, TransportMode } from "@pt/shared";

/**
 * Segment variants are constructed via `toSegments()` (engine-output → segments)
 * OR `deriveItineraryDisplay()` (display-time splice for buffer waits) — those
 * two paths keep the derived booleans (`tight`, `transferWalk`, `sameStop`)
 * in lock-step with the constructor rules. Consumers narrow via the `kind`
 * discriminator on the `Segment` union.
 */

/**
 * Synthetic leg representing a gap between two consecutive legs. The routing
 * engine doesn't emit waits explicitly — we derive them from the time between
 * one leg's arrival and the next leg's departure when the user stays at the
 * same stop (or needs to transfer on foot).
 */
export interface WaitSegment {
  kind: "wait";
  minutes: number;
  atStopName: string;
  /** True when board stop of next leg == alight stop of previous leg. */
  sameStop: boolean;
  /** True when the wait is short enough to be risky (< TIGHT_WAIT_MIN). */
  tight: boolean;
}

/** A ride leg from the itinerary. */
export interface RideSegment {
  kind: "ride";
  leg: Leg;
  minutes: number;
}

/** A walking leg (either edge walk or transfer walk between different stops). */
export interface WalkSegment {
  kind: "walk";
  leg: Leg;
  minutes: number;
  meters: number;
  /** True when the walk is between two transit stops (not origin/destination). */
  transferWalk: boolean;
}

/**
 * A pre-stop buffer wait — the few minutes a user should arrive early at the
 * first transit stop to avoid sprinting for the bus. Spliced into the segment
 * list at display time by `deriveItineraryDisplay`; never present in the
 * engine output.
 */
export interface BufferWaitSegment {
  kind: "buffer-wait";
  /** Applied buffer in seconds. Always ≥ 60 when emitted (sub-minute buffers are suppressed). */
  seconds: number;
  /** First transit leg's `from.name`. */
  atStopName: string;
}

export type Segment = RideSegment | WalkSegment | WaitSegment | BufferWaitSegment;

/** A wait under this many minutes is flagged as "tight" in the UI. */
export const TIGHT_WAIT_MIN = 3;

function legMinutes(leg: Leg): number {
  const s = leg.durationSeconds;
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.round(s / 60));
}

function waitMinutes(prev: Leg, next: Leg): number {
  const prevMs = new Date(prev.arrivalTime).getTime();
  const nextMs = new Date(next.departureTime).getTime();
  // Malformed ISO timestamps → NaN. Leaving that to propagate poisons
  // downstream layout math (e.g. ItineraryBar segment widths become NaN%
  // and the segment disappears without warning). Treat as no-wait.
  if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs)) return 0;
  const gapSecs = (nextMs - prevMs) / 1000;
  return Math.max(0, Math.round(gapSecs / 60));
}

function sameStop(prev: Leg, next: Leg): boolean {
  // Prefer stopId when present; fall back to coordinate equality.
  if (prev.to.stopId && next.from.stopId) {
    return prev.to.stopId === next.from.stopId;
  }
  return (
    Math.abs(prev.to.location.lat - next.from.location.lat) < 1e-6 &&
    Math.abs(prev.to.location.lon - next.from.location.lon) < 1e-6
  );
}

/**
 * Walk into an ordered segment list including synthetic `wait` segments
 * inserted between transit legs when there's a time gap at the same stop.
 *
 * Between two transit legs:
 *   - if the routing engine emitted a WALK leg in between, that walk is a
 *     transferWalk (its duration already accounts for the walking time).
 *   - otherwise, any time gap between prev.arrivalTime and next.departureTime
 *     becomes a wait segment.
 */
export function toSegments(itinerary: Itinerary): Segment[] {
  const out: Segment[] = [];
  const legs = itinerary.legs;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.mode === "WALK") {
      const prev = legs[i - 1];
      const next = legs[i + 1];
      const transferWalk =
        !!prev && !!next && prev.mode !== "WALK" && next.mode !== "WALK";
      out.push({
        kind: "walk",
        leg,
        minutes: legMinutes(leg),
        meters: Math.max(0, Math.round(leg.distanceMeters ?? 0)),
        transferWalk,
      });
      continue;
    }
    // Ride leg
    const prev = legs[i - 1];
    if (prev && prev.mode !== "WALK") {
      // Transit → transit; check if we need a synthetic wait
      const wait = waitMinutes(prev, leg);
      if (wait > 0) {
        out.push({
          kind: "wait",
          minutes: wait,
          atStopName: leg.from.name,
          sameStop: sameStop(prev, leg),
          tight: wait < TIGHT_WAIT_MIN,
        });
      }
    }
    out.push({ kind: "ride", leg, minutes: legMinutes(leg) });
  }
  return out;
}

/** Transit legs only, preserving order. */
export function transitLegs(itinerary: Itinerary): Leg[] {
  return itinerary.legs.filter((l) => l.mode !== "WALK");
}

/** Total seconds actually spent on a vehicle (excluding walking/waiting). */
export function rideSeconds(itinerary: Itinerary): number {
  return itinerary.legs
    .filter((l) => l.mode !== "WALK")
    .reduce((s, l) => s + l.durationSeconds, 0);
}

/**
 * Peak delay across an itinerary's transit legs, derived from `leg.delaySeconds`.
 * Returns minutes; 0 if no realtime data.
 */
export function peakDelayMinutes(itinerary: Itinerary): {
  minutes: number;
  line: string | null;
} {
  let max = 0;
  let line: string | null = null;
  for (const leg of itinerary.legs) {
    if (leg.mode === "WALK") continue;
    const delay = typeof leg.delaySeconds === "number" ? leg.delaySeconds : 0;
    const m = Math.round(delay / 60);
    if (m > max) {
      max = m;
      line = leg.routeShortName ?? null;
    }
  }
  return { minutes: max, line };
}

/**
 * Returns "tight" when any synthetic wait is shorter than TIGHT_WAIT_MIN,
 * "miss" when the live delay on the ride leg *immediately before* that
 * wait would consume it entirely, or null.
 *
 * Accepts either a raw `Itinerary` (will call `toSegments()` internally) or
 * a pre-computed `Segment[]` — e.g. `display.segments` from
 * `deriveItineraryDisplay`, which avoids segmenting the same itinerary
 * twice per render. Cards prefer the segment overload
 * for that reason.
 *
 * `BufferWaitSegment` entries are inert here: the function filters on
 * `seg.kind === "wait"`, so a buffer-wait spliced ahead of a tight
 * `WaitSegment` does not change the result.
 *
 * Scope note: only the directly-preceding ride is inspected. Delay
 * chains across transfer walks or multi-leg compounding aren't tracked
 * here — that'd need full liveTimelineAnnotations-style propagation.
 */
export function transferRisk(
  input: Itinerary | Segment[],
): "tight" | "miss" | null {
  // Discriminate on the Itinerary shape (object with `legs`), not Array.isArray —
  // a future Itinerary that's array-like would route incorrectly otherwise.
  const segs = "legs" in input ? toSegments(input) : input;
  let tight = false;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.kind !== "wait" || !s.tight) continue;
    tight = true;
    // Look at the ride leg immediately before this wait
    const prev = segs[i - 1];
    if (prev && prev.kind === "ride") {
      const delayMin = Math.round(
        (prev.leg.delaySeconds ?? 0) / 60,
      );
      if (delayMin >= s.minutes) return "miss";
    }
  }
  return tight ? "tight" : null;
}

/**
 * Does this mode map to a transit vehicle (as opposed to a walk/bike/car)?
 * Used for decisions like "should this leg get a colored stripe".
 */
export function isTransitMode(mode: TransportMode): boolean {
  return (
    mode !== "WALK" &&
    mode !== "BIKE" &&
    mode !== "BIKE_SHARE" &&
    mode !== "SCOOTER" &&
    mode !== "CAR"
  );
}
