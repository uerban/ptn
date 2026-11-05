import type { ComposedItinerary, RaptorLeg } from "@pt/shared";
import { RAPTOR_MIN_TRANSFER_SECS } from "@pt/shared/constants";
// Single source of truth for the freshness window — shared with the
// dashboard's `getNextDeparture` so the two paths agree about staleness.
// If this needs to change, change it in one place.
import { NEXT_DEPARTURE_FRESHNESS_WINDOW_MS as FRESHNESS_WINDOW_MS } from "./nextDeparture.ts";

type DelayLookup = (tripId: string) => {
  delaySeconds: number;
  cancelled: boolean;
  deleted?: boolean;
  receivedAt?: number;
} | null;

/**
 * Stale-RT policy: any update older than `FRESHNESS_WINDOW_MS` (re-
 * exported above) is treated as not-yet-arrived. The cause of staleness
 * varies — paused upstream feed, backend polling backlog, app resume
 * from background, slow city feed, tab-throttled poller — but the
 * consequence is the same: applying an old delta would shift legs into
 * impossible positions. Cities whose RT feeds update less often than
 * this window lose RT corrections under this policy; audit configured
 * cities before deploying.
 */

export interface RtComposedItinerary extends ComposedItinerary {
  cancelled?: boolean;
  timingUnreliable?: boolean;
}

/**
 * Apply real-time delay overlay to composed itineraries.
 *
 * For each transit leg, looks up the trip's delay and shifts the leg's
 * departure/arrival times by that delta. Two independent trust signals
 * come out of this, and they are deliberately not the same flag:
 *
 * - `cancelled` — an upstream trip-update flagged the trip CANCELED.
 * - `timingUnreliable` — nothing was cancelled, but a delay pushed a
 *   leg's arrival so late that the next leg's board can no longer be
 *   caught with the minimum transfer buffer.
 *
 * They were one flag until the UI needed to say which had happened:
 * "cancelled" is a fact about the operator's plan, "unreliable timing"
 * is an inference about a chain that no longer connects, and a banner
 * covering both could only be worded vaguely enough to be useless.
 * An itinerary can carry both, one, or neither.
 *
 * Broken-transfer handling specifically preserves the *scheduled* leg
 * times rather than the naively-shifted values. Shifting only the
 * delayed leg while leaving downstream legs at their scheduled times —
 * the prior behaviour — produced chronologically impossible displays
 * (e.g. a 3G leg relocated to 07:08–07:34 sitting between a 05:37 bus
 * and a 06:00 walk when the RT feed reported a stale 7 200-second
 * delay). The unviability is still surfaced, now via
 * `timingUnreliable`, but the leg chain the user sees stays internally
 * consistent.
 */
export function applyRtOverlay(
  itineraries: ComposedItinerary[],
  getDelay: DelayLookup,
  /** The rider's minimum transfer (`minTransferSecsFor`), as the engine used. */
  minTransferSecs: number = RAPTOR_MIN_TRANSFER_SECS,
): RtComposedItinerary[] {
  // Cache once per overlay invocation; per-leg recomputation in the loop
  // would issue a syscall on every leg of every itinerary.
  const nowMs = Date.now();

  // A trip the feed DELETED must not be shown to riders, not even as
  // cancelled: an itinerary that rides one is not offered at all. No
  // freshness guard — a removal does not go stale like a delay estimate.
  const rides = (itin: ComposedItinerary) =>
    itin.legs.every((leg) => leg.type !== "transit" || !leg.tripId || getDelay(leg.tripId)?.deleted !== true);

  return itineraries.filter(rides).map((itin) => {
    let anyCancelled = false;
    const shiftedLegs: RaptorLeg[] = itin.legs.map((leg) => {
      if (leg.type !== "transit" || !leg.tripId) return leg;

      const rt = getDelay(leg.tripId);
      if (!rt) return leg;

      // 120s freshness guard. Updates older than the window are likely
      // stale (feed paused, polling backlog, etc.) and applying them
      // risks shifting legs into impossible positions. Updates with no
      // `receivedAt` are honoured (backwards-compat — see the
      // `getReceivedAt` JSDoc on `useRtStore`). Boundary is exclusive:
      // 119s is honoured, 120s exactly is rejected.
      if (
        typeof rt.receivedAt === "number" &&
        nowMs - rt.receivedAt >= FRESHNESS_WINDOW_MS
      ) {
        return leg;
      }

      if (rt.cancelled) anyCancelled = true;

      return {
        ...leg,
        departSecs: leg.departSecs + rt.delaySeconds,
        arriveSecs: leg.arriveSecs + rt.delaySeconds,
        appliedDelaySeconds: rt.delaySeconds,
      };
    });

    // Detect chain breaks: if a shifted leg arrives so late that the next
    // transit leg's (shifted) board is no longer reachable with the
    // minimum transfer buffer, the itinerary is no longer viable. Walk
    // legs aren't present in RAPTOR output, so direct pairwise chaining
    // across transit legs suffices.
    let brokenByDelay = false;
    for (let i = 0; i < shiftedLegs.length - 1; i++) {
      const current = shiftedLegs[i];
      const next = shiftedLegs[i + 1];
      if (current.type !== "transit" || next.type !== "transit") continue;
      if (next.departSecs < current.arriveSecs + minTransferSecs) {
        brokenByDelay = true;
        break;
      }
    }

    // When broken, fall back to scheduled legs for display integrity —
    // `timingUnreliable` carries the signal without mutating individual
    // leg times into impossibilities.
    const adjustedLegs = brokenByDelay ? itin.legs : shiftedLegs;
    const lastLeg = adjustedLegs[adjustedLegs.length - 1];
    const arrivalSecs = lastLeg.arriveSecs + itin.destWalkSecs;
    const totalSecs = arrivalSecs - itin.departureSecs;

    return {
      ...itin,
      legs: adjustedLegs,
      arrivalSecs,
      totalSecs,
      ...(anyCancelled ? { cancelled: true } : {}),
      ...(brokenByDelay ? { timingUnreliable: true } : {}),
    };
  });
}
