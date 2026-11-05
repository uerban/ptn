import type { Departure } from "@pt/shared";

/**
 * Tuple shape that's both readonly and provably non-empty, so
 * `arr[0]` is always `T` instead of `T | undefined`.
 */
export type NonEmptyArray<T> = readonly [T, ...T[]];

export interface DepartureGroup {
  /** Stable key for React lists; format: "${routeId}::${headsign}". */
  readonly key: string;
  readonly routeId: string;
  readonly routeShortName: string;
  readonly routeColor?: string;
  readonly mode: Departure["mode"];
  readonly subMode?: string;
  readonly headsign: string;
  /** Sorted ascending by effective time; non-empty by construction. */
  readonly departures: NonEmptyArray<Departure>;
}

// Effective arrival time = predicted (RT) if available, else scheduled.
// Same key drives both the within-group and between-group sort, so
// `groups[0].departures[0]` is always the soonest upcoming row.
function effectiveTime(d: Departure): number {
  return new Date(d.predictedTime ?? d.scheduledTime).getTime();
}

/**
 * Group a flat list of departures by `(routeId, headsign)` and return
 * the groups in the order the next-departing line should render —
 * soonest first.
 *
 * Cancelled departures are kept in the result with `cancelled: true`;
 * filtering is the caller's policy because each surface treats
 * cancellations differently (StopPopup falls back to all-cancelled,
 * ETACards filters before grouping so the sort key tracks active
 * trips, DepartureSheet renders them as-is).
 *
 * Metadata fields (`routeShortName`, `routeColor`, `mode`, `subMode`)
 * are taken from the first encountered departure of each group;
 * later departures with diverging metadata are ignored. In practice
 * upstream data is keyed such that all members of a group share these
 * fields, so the first-wins rule avoids non-determinism without
 * losing information.
 *
 * Sort is stable, so ties in effective time preserve input order.
 */
export function groupDeparturesByLine(
  departures: readonly Departure[],
): DepartureGroup[] {
  interface Working {
    key: string;
    routeId: string;
    routeShortName: string;
    routeColor?: string;
    mode: Departure["mode"];
    subMode?: string;
    headsign: string;
    departures: [Departure, ...Departure[]];
  }
  const map = new Map<string, Working>();

  for (const dep of departures) {
    const key = `${dep.routeId}::${dep.headsign}`;
    const existing = map.get(key);
    if (existing) {
      existing.departures.push(dep);
    } else {
      map.set(key, {
        key,
        routeId: dep.routeId,
        routeShortName: dep.routeShortName,
        routeColor: dep.routeColor,
        mode: dep.mode,
        subMode: dep.subMode,
        headsign: dep.headsign,
        departures: [dep],
      });
    }
  }

  for (const group of map.values()) {
    group.departures.sort((a, b) => effectiveTime(a) - effectiveTime(b));
  }
  return Array.from(map.values()).sort(
    (a, b) => effectiveTime(a.departures[0]) - effectiveTime(b.departures[0]),
  );
}
