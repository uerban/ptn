/**
 * The nearby departures' rows, shared by the map's ETA strip and Text mode's
 * nearby departures list: the next run per line and headsign on each side
 * (`useNearbyDirections`), soonest first, and the stop that names the
 * opposite row. Map-free.
 */
import type { Departure, StopWithLines } from "@pt/shared";
import { POPUP_DEPARTED_CUTOFF_MINUTES } from "@pt/shared/constants";
import { minutesUntil } from "../hooks/useCountdown.ts";
import { groupDeparturesByLine } from "../utils/groupDeparturesByLine.ts";
import type { Row, Side } from "./nearbyDirections.ts";

export interface PillDeparture {
  /** Unique within the strip: stop, line, direction and headsign. */
  key: string;
  /** The departure this pill shows, handed back through `onSelect`. */
  departure: Departure;
  /** The stop it leaves from. */
  stop: StopWithLines;
  /** Its effective (predicted, else scheduled) instant, epoch ms. */
  time: number;
  /** Minutes until `time`, rounded up; ≤ 0 reads "Due". */
  minutes: number;
}

/**
 * The soonest departure per route+headsign group of one side that has not
 * left yet. Cancelled departures and departed ones (past
 * `POPUP_DEPARTED_CUTOFF_MINUTES`) are dropped *before* grouping: this surface
 * is for "next vehicle coming", so a group shows its next run still to come,
 * and a group whose runs are all cancelled or gone shows nothing.
 *
 * Filtering after grouping would key the group on a trip nobody can take: the
 * helper's between-group sort would order it by a cancelled time, and a
 * departed first run would hide the group although its next run is minutes
 * away (tiles return departures back to ten minutes ago).
 */
function pickNextPerGroup(side: Side, departures: Departure[], stop: StopWithLines, now: number): PillDeparture[] {
  const pills: PillDeparture[] = [];
  const upcoming = departures.filter(
    (d) =>
      !d.cancelled &&
      minutesUntil(Date.parse(d.predictedTime ?? d.scheduledTime), now) >= POPUP_DEPARTED_CUTOFF_MINUTES,
  );
  for (const group of groupDeparturesByLine(upcoming)) {
    const next = group.departures[0];
    const time = Date.parse(next.predictedTime ?? next.scheduledTime);
    pills.push({
      key: `${side.stopId}::${side.routeId}::${side.dirKey}::${group.headsign}`,
      departure: next,
      stop,
      time,
      minutes: minutesUntil(time, now),
    });
  }
  return pills;
}

/**
 * The pills of one row over all its sides, soonest first. The sort is stable,
 * so equal times keep side order, then group order. Not capped: each layout
 * caps what it shows.
 */
export function rowPills(
  row: Row,
  sides: Side[],
  departuresBySide: Map<Side, Departure[]>,
  stopFor: (id: string) => StopWithLines | undefined,
  now: number,
): PillDeparture[] {
  const pills: PillDeparture[] = [];
  for (const side of sides) {
    if (side.row !== row) continue;
    const stop = stopFor(side.stopId);
    if (!stop) continue;
    pills.push(...pickNextPerGroup(side, departuresBySide.get(side) ?? [], stop, now));
  }
  return pills.sort((a, b) => a.time - b.time);
}

/**
 * The stop that names the bottom row: the one carrying the most of its sides,
 * the first in side order on a tie. It depends on the sides only, so the
 * header does not flip as departures come and go.
 */
export function bottomStopOf(
  sides: Side[],
  stopFor: (id: string) => StopWithLines | undefined,
): StopWithLines | null {
  const counts = new Map<string, number>();
  for (const side of sides) {
    if (side.row !== "bottom" || !stopFor(side.stopId)) continue;
    counts.set(side.stopId, (counts.get(side.stopId) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [id, n] of counts) {
    if (best === null || n > counts.get(best)!) best = id;
  }
  return best === null ? null : stopFor(best) ?? null;
}
