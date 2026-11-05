/**
 * Local-time YYYYMMDD helpers. Mirror legacy backend semantics:
 *   - `secsToDate` in `packages/backend/src/gtfs/store.ts` uses local-time `setHours(0,0,0,0)`.
 *   - `formatDateYYYYMMDD` in the same file uses local-time getters.
 *
 * The process must run with the `TZ` environment variable set to a
 * `Europe/*` zone matching the transit agency's local time; tests must
 * pin `TZ` explicitly or accept that local-time output is environment-dependent.
 */

/** Format a Date as `YYYYMMDD` in local time. */
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

/** Add `delta` calendar days to a `YYYYMMDD` string and return the resulting `YYYYMMDD`. */
export function addDaysYMD(yyyymmdd: string, delta: number): string {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6) - 1;
  const d = +yyyymmdd.slice(6, 8);
  const dt = new Date(y, m, d);
  dt.setDate(dt.getDate() + delta);
  return ymdLocal(dt);
}

/**
 * Construct a Date at local midnight for the given `YYYYMMDD`.
 * Equivalent to legacy `secsToDate(baseDate, 0)` modulo the wrapping Date instance.
 */
export function yyyymmddToLocalMidnight(yyyymmdd: string): Date {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6) - 1;
  const d = +yyyymmdd.slice(6, 8);
  const dt = new Date(y, m, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

/**
 * Add `delta` calendar days to a `YYYYMMDD` string — PURE civil-date arithmetic
 * via `Date.UTC` (never a local `Date`), so it is DST- and TZ-invariant. Unlike
 * `addDaysYMD` (local-time), safe for service-day math that must agree
 * byte-for-byte with the Rust `days_add`. Mirrors the harness `addDaysYmd`.
 */
export function addDaysCivil(yyyymmdd: string, delta: number): string {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6);
  const d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86400_000);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Local-NOON `Date` for a `YYYYMMDD` — the service-resolution boundary helper.
 * Noon (not midnight) keeps `resolveActiveServices`'s local `getDate()`/`getDay()`
 * robust against DST/offset edges (mirrors the differential harness `dateFromYmd`).
 */
export function yyyymmddToLocalNoon(yyyymmdd: string): Date {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(4, 6) - 1;
  const d = +yyyymmdd.slice(6, 8);
  return new Date(y, m, d, 12, 0, 0, 0);
}
