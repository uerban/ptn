import { serviceDayOriginUnix, unixToGtfsSecs, unixToServiceDate } from "@pt/shared/time";
import { addDaysCivil } from "@pt/shared/util";

/**
 * The GTFS service-day frame an instant reads in: today's civil service date
 * and yesterday's. A feed's `departureSecs` are GTFS `Time`, measured from local
 * noon minus 12 h, so "now" has to be read in that same frame. Reading the wall
 * clock instead is an hour off on a DST date, and the departure lists built on
 * it would drop an hour of trips.
 */
export interface ServiceDayFrame {
  todayYmd: string;
  /** `now` in today's GTFS frame. */
  nowSecs: number;
  yesterdayYmd: string;
  /**
   * `origin(today) - origin(yesterday)`: 86400 on an ordinary day, 82800 or
   * 90000 across a DST change. A yesterday-frame time `d` reads as
   * `d - yesterdayShiftSecs` in today's frame.
   */
  yesterdayShiftSecs: number;
}

/**
 * The frame of `unixSec` in the feed zone, or the device zone when no feed zone
 * is known. Both `now` and the yesterday shift come from the same origins the
 * bundle stores, so the frame matches the departures it is compared with.
 */
export function serviceDayFrame(unixSec: number, feedTz?: string): ServiceDayFrame {
  const tz = feedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The GTFS service date (the engine's rule), not the civil date: near a DST
  // change the two differ for an hour, and that hour belongs to the next date.
  const today = unixToServiceDate(unixSec, tz);
  const yesterdayYmd = addDaysCivil(String(today), -1);
  return {
    todayYmd: String(today),
    nowSecs: unixToGtfsSecs(unixSec, today, tz),
    yesterdayYmd,
    yesterdayShiftSecs: serviceDayOriginUnix(today, tz) - serviceDayOriginUnix(Number(yesterdayYmd), tz),
  };
}
