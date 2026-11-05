/**
 * Arrive-by deadline helpers. The rider enters a wall-clock date and time in
 * the city's zone; the search uses that one instant, and the bundle resolves
 * it into GTFS service-day time (`PtRouterHandle.resolveTime`).
 * https://gtfs.org/documentation/schedule/reference/#field-types
 */
import type { Itinerary } from "@pt/shared";
import { serviceDayToUnix, unixToServiceDay } from "@pt/shared/time";

const MINUTE = 60;
const pad = (n: number): string => String(n).padStart(2, "0");

/** A wall-clock reading in the city's zone, as `<input type=date|time>` values. */
export interface CityWallClock {
  readonly date: string; // YYYY-MM-DD
  readonly time: string; // HH:MM
}

export function toCityWallClock(ms: number, tz: string): CityWallClock {
  const { serviceDateYmd: ymd, secsOfServiceDay: secs } = unixToServiceDay(Math.floor(ms / 1000), tz);
  const y = Math.floor(ymd / 10000), m = Math.floor(ymd / 100) % 100, d = ymd % 100;
  return { date: `${y}-${pad(m)}-${pad(d)}`, time: `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}` };
}

/**
 * The instant a wall-clock date and time name in `tz`, or null when either is
 * incomplete. A time the clock skips at a DST change, or reads twice, follows
 * the shared projection's documented policy (`serviceDayToUnix`).
 */
export function fromCityWallClock(date: string, time: string, tz: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const hh = Number(t[1]), mm = Number(t[2]);
  if (hh > 23 || mm > 59) return null;
  const ymd = Number(d[1]) * 10000 + Number(d[2]) * 100 + Number(d[3]);
  return serviceDayToUnix(ymd, hh * 3600 + mm * MINUTE, tz) * 1000;
}

/**
 * Round up to the next wall-clock multiple of `minutes` in `tz`, adding the
 * difference as elapsed time. A zone change inside the (at most five-minute)
 * step can shift the reading; the city zones change at whole hours, where
 * the result is still a whole multiple.
 */
function roundUp(ms: number, minutes: number, tz: string): number {
  const unix = Math.ceil(ms / 1000);
  const { secsOfServiceDay } = unixToServiceDay(unix, tz);
  const step = minutes * MINUTE;
  return (unix + Math.ceil(secsOfServiceDay / step) * step - secsOfServiceDay) * 1000;
}

/**
 * The spec's default deadline: the earliest arrival on the initial
 * Recommended page, rounded up to a minute; without one, the captured now plus
 * one hour, rounded up to five minutes.
 */
export function defaultDeadlineMs(recommended: readonly Itinerary[], nowMs: number, tz: string): number {
  const arrivals = recommended.map((i) => Date.parse(i.arrivalTime)).filter((ms) => Number.isFinite(ms));
  if (arrivals.length > 0) return roundUp(Math.min(...arrivals), 1, tz);
  return roundUp(nowMs + 3_600_000, 5, tz);
}
