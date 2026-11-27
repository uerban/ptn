import {
  serviceDayToUnix,
  unixToServiceDate,
  type Departure,
  type Leg,
  type RoutingBundleRoute,
  type RoutingBundleService,
  type ServiceNotice,
} from "@pt/shared";

/**
 * Matching rules for service notices (`serviceNotices.ts`). Every match uses
 * the SCHEDULED boarding instant against half-open UTC windows `[start, end)`;
 * a realtime delay never moves a ride in or out of a notice.
 */

/** Notice id → trip ids its `trips` starts resolved to in the current bundle. */
export type NoticeTrips = ReadonlyMap<string, ReadonlySet<string>>;

const LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

function inWindow(notice: ServiceNotice, ms: number): boolean {
  return notice.windows.some(w => Date.parse(w.start) <= ms && ms < Date.parse(w.end));
}

function matches(notice: ServiceNotice, routeId: string, tripId: string | undefined, ms: number, trips?: NoticeTrips): boolean {
  if (!(notice.city || notice.routeIds?.includes(routeId)) || !inWindow(notice, ms)) return false;
  // Trip-level notices only match the resolved trips; unresolved never guesses.
  return !notice.trips || (tripId !== undefined && trips?.get(notice.id)?.has(tripId) === true);
}

export function noticesForLeg(notices: readonly ServiceNotice[], leg: Leg, trips?: NoticeTrips): ServiceNotice[] {
  if (leg.mode === "WALK" || !leg.routeId) return [];
  const scheduled = Date.parse(leg.departureTime) - (leg.appliedDelaySeconds ?? 0) * 1000;
  if (!Number.isFinite(scheduled)) return [];
  return notices.filter(n => matches(n, leg.routeId!, leg.tripId, scheduled, trips));
}

export function noticesForDeparture(notices: readonly ServiceNotice[], departure: Departure, trips?: NoticeTrips): ServiceNotice[] {
  const scheduled = Date.parse(departure.scheduledTime);
  if (!Number.isFinite(scheduled)) return [];
  return notices.filter(n => matches(n, departure.routeId, departure.tripId, scheduled, trips));
}

/** Notices active now or starting within the next 24h, soonest first. */
export function activeNotices(notices: readonly ServiceNotice[], nowMs: number): ServiceNotice[] {
  const next = (n: ServiceNotice) => n.windows
    .filter(w => Date.parse(w.end) > nowMs && Date.parse(w.start) <= nowMs + LOOKAHEAD_MS)
    .map(w => Math.max(Date.parse(w.start), nowMs))[0];
  return notices
    .map(n => ({ n, at: next(n) }))
    .filter((x): x is { n: ServiceNotice; at: number } => x.at !== undefined)
    .sort((a, b) => a.at - b.at)
    .map(x => x.n);
}

/** Editor text: the user's locale, then its language, then the entry's first language. */
export function noticeText(notice: ServiceNotice, locale: string): string | undefined {
  const text = notice.text;
  if (!text) return undefined;
  return text[locale] ?? text[locale.split("-")[0]!] ?? Object.values(text)[0];
}

function serviceActive(service: RoutingBundleService, ymd: number): boolean {
  const key = String(ymd);
  const exception = service.exceptions[key];
  if (exception === 1) return true;
  if (exception === 2) return false;
  if (key < service.startDate || key > service.endDate) return false;
  const day = new Date(Date.UTC(Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100 - 1, ymd % 100)).getUTCDay();
  return service.days[(day + 6) % 7] === true;
}

function previousDay(ymd: number): number {
  const d = new Date(Date.UTC(Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100 - 1, ymd % 100 - 1));
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Resolve each trip-level notice's first-stop starts to trip ids: a trip
 * matches a start when it runs on that service date and leaves its first
 * stop exactly then. A start after midnight also tries the previous service
 * date (GTFS 24:xx times).
 */
export function resolveNoticeTrips(
  notices: readonly ServiceNotice[],
  routes: readonly RoutingBundleRoute[],
  calendar: readonly RoutingBundleService[],
  tz: string,
): Map<string, Set<string>> {
  const services = new Map(calendar.map(s => [s.serviceId, s]));
  const result = new Map<string, Set<string>>();
  for (const notice of notices) {
    if (!notice.trips || notice.routeIds?.length !== 1) continue;
    const route = routes.find(r => r.id === notice.routeIds![0]);
    if (!route) continue;
    const found = new Set<string>();
    for (const start of notice.trips) {
      const unix = Date.parse(start) / 1000;
      const date = unixToServiceDate(unix, tz);
      for (const ymd of [date, previousDay(date)]) {
        for (const trip of route.trips) {
          const first = trip.departureSecs.find(secs => secs >= 0);
          const service = services.get(trip.serviceId);
          if (first !== undefined && service && serviceDayToUnix(ymd, first, tz) === unix && serviceActive(service, ymd)) {
            found.add(trip.tripId);
          }
        }
      }
    }
    if (found.size) result.set(notice.id, found);
  }
  return result;
}
