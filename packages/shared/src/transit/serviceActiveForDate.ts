import type { CalendarRow } from "../types/scheduleTile.js";
import { yyyymmddToLocalMidnight } from "../util/ymd.js";

/**
 * Returns `true` iff service `row` is active on calendar date `ymd`
 * (a `YYYYMMDD` local-time string).
 *
 * Mirrors the legacy `getActiveServiceIdsForDate` predicate in
 * `packages/backend/src/gtfs/store.ts`. Exception precedence:
 *
 *   1. `added` overrides everything (date is active even outside window
 *      or on excluded weekdays).
 *   2. `removed` overrides the weekly schedule (date is inactive even
 *      inside window on an included weekday).
 *   3. Otherwise: `startDate <= ymd <= endDate` AND `days[dayIx]`.
 *
 * `dayIx` is computed from `yyyymmddToLocalMidnight(ymd).getDay()`
 * (Sun = 0) mapped to the `CalendarRow.days` convention (Mon = 0)
 * via `(getDay() + 6) % 7`.
 *
 * Date comparison is lexicographic on the 8-char YYYYMMDD strings — no
 * Date object is materialized for the in-window check. The day-of-week
 * derivation does allocate one Date via `yyyymmddToLocalMidnight`, but
 * only when the `added`/`removed` shortcuts don't decide first.
 */
export function serviceActiveForDate(ymd: string, row: CalendarRow): boolean {
  if (row.added.includes(ymd)) return true;
  if (row.removed.includes(ymd)) return false;
  if (ymd < row.startDate || ymd > row.endDate) return false;
  const dayIx = (yyyymmddToLocalMidnight(ymd).getDay() + 6) % 7;
  return row.days[dayIx] === true;
}
