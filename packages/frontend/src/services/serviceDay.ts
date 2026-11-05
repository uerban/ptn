import { unixToServiceDay } from "@pt/shared/time";
import type { RaptorIndexService } from "./raptorIndex.ts";

/**
 * Format a Date as YYYYMMDD string for calendar comparison.
 */
function formatDateYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** YYYYMMDD per service-day calendar — same shape `gtfs-export.ts` uses. */
export function formatDateYYYYMMDD(d: Date): string {
  return formatDateYMD(d);
}

/** Mon-first (0=Mon..6=Sun) weekday of a YYYYMMDD integer, device-tz-independent. */
function monFirstWeekday(ymd: number): number {
  const y = Math.floor(ymd / 10000);
  const m = Math.floor((ymd % 10000) / 100);
  const d = ymd % 100;
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return jsDay === 0 ? 6 : jsDay - 1;
}

/**
 * Resolve active services for an EXPLICIT feed-tz service date (YYYYMMDD string).
 * No Date, no tz round-trip — the day-of-week is derived purely from the civil
 * date. This is the primitive; callers that have a feed-tz YMD already (overnight
 * prev-day, useVisibleStops) should call this directly.
 *
 * Uses GTFS calendar rules:
 * 1. Check if date is within service's [startDate, endDate] range
 * 2. Check day-of-week flags: days is Monday-first [mon,tue,wed,thu,fri,sat,sun]
 *    (matching the RaptorIndex layout from Plan 1)
 * 3. Apply calendar_dates exceptions: 1=added, 2=removed
 */
export function resolveActiveServicesForYmd(
  services: Map<string, RaptorIndexService>,
  dateStr: string,
): Set<string> {
  const daysIdx = monFirstWeekday(Number(dateStr));
  const active = new Set<string>();

  for (const [serviceId, svc] of services) {
    const exception = svc.exceptions[dateStr];

    // Exception type 2 = removed — skip regardless of calendar
    if (exception === 2) continue;

    // Exception type 1 = added — include regardless of calendar
    if (exception === 1) {
      active.add(serviceId);
      continue;
    }

    // Normal calendar check: date range + day of week
    if (dateStr < svc.startDate || dateStr > svc.endDate) continue;
    if (!svc.days[daysIdx]) continue;

    active.add(serviceId);
  }

  return active;
}

/**
 * Resolve which service IDs are active for a rider instant.
 *
 * When `feedTz` is set, the civil service date + weekday are taken from the
 * FEED-TZ wall clock (correct for a cross-tz device — a query near local
 * midnight from a foreign device else resolves the device's weekday and returns
 * the wrong day's services). When absent, the legacy device-local YMD is used
 * (a local user's device tz == feed tz, so the two agree). Both paths route
 * through the same Mon-first `daysIdx` derivation in `resolveActiveServicesForYmd`.
 */
export function resolveActiveServices(
  services: Map<string, RaptorIndexService>,
  date: Date,
  feedTz?: string,
): Set<string> {
  // Feed-tz civil date (correct for a cross-tz device) when feedTz is set;
  // legacy device-local YMD otherwise (local user: device tz == feed tz).
  const dateStr = feedTz
    ? String(unixToServiceDay(Math.floor(date.getTime() / 1000), feedTz).serviceDateYmd)
    : formatDateYMD(date);
  return resolveActiveServicesForYmd(services, dateStr);
}
