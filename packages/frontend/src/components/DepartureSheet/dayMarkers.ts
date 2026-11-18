import type { Departure } from "@pt/shared";

export interface DayMarker {
  /** Calendar date to announce above this row, when it starts a new day. */
  dateDivider?: Date;
  /** Last departure of its service day before the next one starts. */
  lastOfServiceDay?: boolean;
  /** First departure of a service day that follows another in the list. */
  firstOfServiceDay?: boolean;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Marks where a schedule list crosses midnight and where one service day
 * hands over to the next. The service day comes from GTFS, so a 25:10 trip
 * still counts as the night before; no gap heuristics.
 */
export function dayMarkers(
  departures: readonly Departure[],
  now: Date = new Date(),
): DayMarker[] {
  const markers: DayMarker[] = departures.map(() => ({}));
  let prevDay = localDayKey(now);
  departures.forEach((dep, i) => {
    const when = new Date(dep.scheduledTime);
    const day = localDayKey(when);
    if (day !== prevDay) markers[i]!.dateDivider = when;
    prevDay = day;
    const next = departures[i + 1];
    if (dep.serviceDate && next?.serviceDate && next.serviceDate !== dep.serviceDate) {
      markers[i]!.lastOfServiceDay = true;
      markers[i + 1]!.firstOfServiceDay = true;
    }
  });
  return markers;
}
