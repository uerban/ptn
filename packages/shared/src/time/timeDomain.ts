/**
 * Service-day-seconds → unix-timestamp projection with DST handling.
 *
 * TypeScript mirror of the Rust oracle
 * `crates/pt-serve/src/domain/time_domain.rs::service_day_to_unix`. The two MUST
 * agree byte-for-byte over the committed cross-language fixture
 * `packages/shared/tests/__fixtures__/tz-cases.json` (originally generated with
 * chrono-tz, now regenerated with Jiff; a CI differential gate runs both).
 * If this file disagrees with the fixture,
 * fix THIS file — never the fixture.
 *
 * This legacy compatibility projection interprets `(service_date, secs)` as
 * a wall-clock offset from civil midnight, resolved in the city IANA zone.
 * It may be negative or exceed 86400 (overnight trips). PTB v2 GTFS origins
 * use local noon minus 12 elapsed hours instead; do not substitute this helper:
 * https://gtfs.org/documentation/schedule/reference/#field-types.
 *
 * ## Frozen DST semantics (identical to the Rust side)
 * - Single (unambiguous local time) → that instant.
 * - Ambiguous (fall-back overlap) → the EARLIER (pre-transition) instant.
 * - None (spring-forward gap) → SNAP FORWARD: interpret the non-existent local
 *   time with the pre-transition UTC offset (maps it to the instant the wall
 *   clock skips to).
 *
 * No tz library is used: gap/overlap classification is done by sampling the
 * zone's UTC offset via `Intl.DateTimeFormat` and round-trip-validating each
 * candidate instant — the JS equivalent of Jiff's local-time ambiguity check.
 * A naive ±3h window is NOT enough: an overnight time that lands
 * a valid wall-clock time within a few hours AFTER a transition straddles the
 * sampling window and would otherwise be mis-offset. The round-trip check fixes
 * that.
 */

/**
 * Memoized `Intl.DateTimeFormat` per IANA zone: both `offsetMinutesAtUtc` and
 * `unixToServiceDay` format wall-clock components in `tz`, and constructing a formatter per
 * call is the dominant cost. Output is identical to a fresh formatter, so this is a pure perf
 * memo (the differential gate stays byte-exact). Unbounded by construction but bounded in
 * practice — keys are city IANA zones (`CityConfig.tz`, ≤7), a closed set, never evicted; no
 * LRU needed.
 */
const WALL_CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(tz: string): Intl.DateTimeFormat {
  let dtf = WALL_CLOCK_FORMATTERS.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    WALL_CLOCK_FORMATTERS.set(tz, dtf);
  }
  return dtf;
}

/**
 * UTC offset in WHOLE MINUTES for `tz` at the absolute instant `utcMs`.
 * Positive = east of UTC (local ahead of UTC). Uses `Intl.DateTimeFormat` with
 * an explicit `timeZone`, so it is independent of the process `TZ` env.
 */
function offsetMinutesAtUtc(utcMs: number, tz: string): number {
  const parts = wallClockFormatter(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  // `hour` can format as "24" at local midnight in some engines; `% 24` folds
  // it back to 0 so the reconstructed wall clock matches.
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * Project a GTFS `(serviceDateYmd, secs)` pair to a unix timestamp (seconds)
 * in the IANA zone `tz`, applying the frozen DST policy above.
 *
 * @param serviceDateYmd integer YYYYMMDD (e.g. 20260329)
 * @param secs           seconds of the service day (may be <0 or >86400)
 * @param tz             IANA zone name (e.g. "Europe/Vilnius")
 */
export function serviceDayToUnix(serviceDateYmd: number, secs: number, tz: string): number {
  const y = Math.floor(serviceDateYmd / 10000);
  const m = Math.floor((serviceDateYmd % 10000) / 100);
  const d = serviceDateYmd % 100;

  // The naive LOCAL wall-clock instant, expressed as if it were UTC. We never
  // treat this as a real instant — only as a (date, time-of-day) carrier from
  // which `secs - offset` recovers the true UTC second.
  const naiveAsUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) + secs * 1000;
  const naiveSec = Math.floor(naiveAsUtcMs / 1000);

  // Bracket the naive instant by a wide margin (±24h ≫ any DST jump; the
  // largest in the IANA db is 2h, Antarctica/Troll) to obtain the pre- and
  // post-transition offset guesses.
  const offBefore = offsetMinutesAtUtc(naiveAsUtcMs - 24 * 3600 * 1000, tz);
  const offAfter = offsetMinutesAtUtc(naiveAsUtcMs + 24 * 3600 * 1000, tz);

  const withOffset = (offMin: number) => naiveSec - offMin * 60;

  // No transition in the bracket → single, unambiguous offset.
  if (offBefore === offAfter) return withOffset(offBefore);

  // A candidate instant `naiveSec - off` is VALID iff the zone's offset at that
  // instant is `off` (round-trip). This is the JS analogue of chrono's
  // `from_local_datetime` validity test.
  const candValid = (offMin: number) =>
    offsetMinutesAtUtc(withOffset(offMin) * 1000, tz) === offMin;

  const beforeValid = candValid(offBefore);
  const afterValid = candValid(offAfter);

  if (beforeValid && afterValid) {
    // Ambiguous (fall-back overlap): both offsets yield a valid instant. Policy
    // = take the EARLIER instant (smaller unix second = larger UTC offset =
    // pre-transition).
    return Math.min(withOffset(offBefore), withOffset(offAfter));
  }
  if (beforeValid) return withOffset(offBefore);
  if (afterValid) return withOffset(offAfter);

  // None (spring-forward gap): neither candidate round-trips. Snap forward by
  // interpreting with the pre-transition offset.
  return withOffset(offBefore);
}

/**
 * Wall-clock inverse of {@link serviceDayToUnix}. Given an absolute instant
 * `unixSec` and the feed IANA zone `tz`, return the civil date and the
 * seconds-since-local-midnight of that instant AS READ ON THE FEED'S WALL CLOCK.
 *
 * This is the true inverse for GTFS query resolution: it reports which service
 * date the instant falls on in `tz` and its wall-clock offset from that date's
 * local midnight — exactly what `getHours()*3600+...` produces for a LOCAL user,
 * generalized to any device tz. It is deliberately NOT
 * `unixSec - serviceDayToUnix(ymd, 0, tz)` (that is ELAPSED seconds across the
 * day and is off by the DST amount on a transition day).
 *
 * `secsOfServiceDay` is always in `[0, 86400)`: it is the civil wall-clock
 * decomposition, not the GTFS service-day assignment (an instant at 01:30 that a
 * feed files under the previous day as 25:30 decomposes here to the next civil
 * date at 01:30 = 5400s; the previous-day reassignment needs trip context and is
 * handled by the overnight pass, not here). See
 * https://gtfs.org/documentation/schedule/reference/#stop_timestxt.
 *
 * Round-trip caveat: inside a fall-back overlap the forward fn's frozen policy
 * collapses both occurrences to the earlier instant, so the LATER occurrence does
 * not round-trip — an accepted property of the frozen policy (display formats the
 * projected instant directly and never round-trips a displayed time back).
 */
export function unixToServiceDay(
  unixSec: number,
  tz: string,
): { serviceDateYmd: number; secsOfServiceDay: number } {
  const parts = wallClockFormatter(tz).formatToParts(new Date(unixSec * 1000));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const hh = get("hour") % 24; // fold a "24" midnight back to 0
  const mm = get("minute");
  const ss = get("second");
  return {
    serviceDateYmd: y * 10000 + m * 100 + d,
    secsOfServiceDay: hh * 3600 + mm * 60 + ss,
  };
}

/**
 * GTFS service-day origin of `serviceDateYmd`: local noon minus 12 elapsed
 * hours, the `Time` reference frame of GTFS
 * (https://gtfs.org/documentation/schedule/reference/#field-types). This is the
 * instant the PTB v2 `ServiceDayOrigins` table stores for that date, so a GTFS
 * `Time` is `unix - serviceDayOriginUnix(ymd, tz)` on every date, DST transition
 * dates included. Local midnight is NOT the origin on those dates.
 */
export function serviceDayOriginUnix(serviceDateYmd: number, tz: string): number {
  return serviceDayToUnix(serviceDateYmd, 43_200, tz) - 43_200;
}

/**
 * Seconds in the GTFS `Time` frame of `serviceDateYmd` that the absolute instant
 * `unixSec` reads. A date's trips and this value share one frame, so the caller
 * compares them directly: no wall-clock mod-86400 reading, which is one hour
 * off on a DST date. Pass the previous date to read an instant in yesterday's
 * overnight frame.
 */
export function unixToGtfsSecs(unixSec: number, serviceDateYmd: number, tz: string): number {
  return unixSec - serviceDayOriginUnix(serviceDateYmd, tz);
}

/**
 * GTFS service date of the absolute instant `unixSec`: the latest date whose
 * {@link serviceDayOriginUnix} is at or before `unixSec`. This is the engine's
 * own rule, so it can differ from the civil date. On a spring-forward eve the
 * next date's origin is 23:00 of the civil date, so 23:00-24:00 belongs to the
 * next service date.
 */
export function unixToServiceDate(unixSec: number, tz: string): number {
  const civil = unixToServiceDay(unixSec, tz).serviceDateYmd;
  const next = addCivilDays(civil, 1);
  if (unixSec >= serviceDayOriginUnix(next, tz)) return next;
  if (unixSec < serviceDayOriginUnix(civil, tz)) return addCivilDays(civil, -1);
  return civil;
}

/** Civil YYYYMMDD `delta` days from `ymd`, by UTC calendar arithmetic (no DST). */
function addCivilDays(ymd: number, delta: number): number {
  const d = new Date(Date.UTC(Math.floor(ymd / 10000), Math.floor((ymd % 10000) / 100) - 1, ymd % 100 + delta));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
