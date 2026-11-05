import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
} from "../parser.js";
import type { CanonicalStore } from "../canonical/CanonicalStore.js";
import type { Departure } from "@pt/shared";

// ── Fixture: overnight city ─────────────────────────────────────────────────
//
// One stop (`stop-1`), one route, one always-active service.
// Trips span around midnight to exercise binary-search window logic.
//
// departureSecs reference:
//   T_13H  → 46800   (13:00 — midday, entirely inside a day)
//   T_22H  → 79200   (22:00)
//   T_23H  → 82800   (23:00)
//   T_2345 → 85500   (23:45 — inside the 23:20→00:00 pre-midnight part of the window)
//   T_0030 → 88200   (00:30 next day — yesterday's base + 24.5h)
//   T_0300 → 97200   (03:00 next day — yesterday's base + 27h)

export const fixtureStops: GtfsStop[] = [
  { id: "stop-1", name: "Night Hub", lat: 54.35, lon: 18.65, parentStation: "" },
];

export const fixtureRoutes: GtfsRoute[] = [
  {
    id: "R-OWN",
    shortName: "N1",
    longName: "Night Line One",
    mode: "BUS",
    color: "003399",
    textColor: "FFFFFF",
  },
];

export const fixtureTrips: GtfsTrip[] = [
  { tripId: "T_13H",  routeId: "R-OWN", serviceId: "SVC-OWN", headsign: "Night Hub" },
  { tripId: "T_22H",  routeId: "R-OWN", serviceId: "SVC-OWN", headsign: "Night Hub" },
  { tripId: "T_23H",  routeId: "R-OWN", serviceId: "SVC-OWN", headsign: "Night Hub" },
  { tripId: "T_2345", routeId: "R-OWN", serviceId: "SVC-OWN", headsign: "Night Hub" },
  { tripId: "T_0030", routeId: "R-OWN", serviceId: "SVC-OWN", headsign: "Night Hub" },
  { tripId: "T_0300", routeId: "R-OWN", serviceId: "SVC-OWN", headsign: "Night Hub" },
];

export const fixtureStopTimes: GtfsStopTime[] = [
  { tripId: "T_13H",  stopId: "stop-1", departureTime: "13:00:00", stopSequence: 1 },
  { tripId: "T_22H",  stopId: "stop-1", departureTime: "22:00:00", stopSequence: 1 },
  { tripId: "T_23H",  stopId: "stop-1", departureTime: "23:00:00", stopSequence: 1 },
  { tripId: "T_2345", stopId: "stop-1", departureTime: "23:45:00", stopSequence: 1 },
  { tripId: "T_0030", stopId: "stop-1", departureTime: "24:30:00", stopSequence: 1 },
  { tripId: "T_0300", stopId: "stop-1", departureTime: "27:00:00", stopSequence: 1 },
];

export const fixtureServices: GtfsService[] = [
  {
    serviceId: "SVC-OWN",
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: true,
    sunday: true,
    startDate: "20200101",
    endDate: "20991231",
  },
];

// ── Helpers mirrored from store.ts (private) ──────────────────────────────

const DAY_FIELDS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function formatDateYYYYMMDD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function secsToDate(baseDate: Date, secs: number): Date {
  const result = new Date(baseDate);
  result.setHours(0, 0, 0, 0);
  result.setSeconds(secs);
  return result;
}

function getActiveServiceIdsForDate(
  canonical: CanonicalStore,
  date: Date,
): Set<string> {
  const dayOfWeek = date.getDay();
  const dateStr = formatDateYYYYMMDD(date);
  const dayField = DAY_FIELDS[dayOfWeek];

  const result = new Set<string>();
  canonical.iterServices((serviceId, service) => {
    const exception = service.exceptions.get(dateStr);
    if (exception === 1) { result.add(serviceId); return; }
    if (exception === 2) return;
    if (
      service.startDate && service.endDate &&
      dateStr >= service.startDate && dateStr <= service.endDate &&
      service[dayField]
    ) {
      result.add(serviceId);
    }
  });
  return result;
}

// ── Oracle ────────────────────────────────────────────────────────────────

/**
 * Reference implementation of getDepartures that mirrors the pre-optimization
 * linear-scan behavior of GtfsStore.getDepartures. Used as a trusted oracle
 * for fidelity tests of the binary-search optimized implementation.
 *
 * Do NOT optimize — this is intentionally the old algorithm verbatim so
 * any behavioral divergence in the fast path shows up as a diff.
 */
export function bruteForceDepartures(
  canonical: CanonicalStore,
  stopId: string,
  date: Date,
  limit: number,
  lookAheadHours?: number,
): Departure[] {
  const ct = canonical.getCompactStopTimes(stopId);
  if (!ct) return [];
  const { tripIdIdx, departureSecs: depSecsArr } = ct;

  const previousDay = new Date(date);
  previousDay.setDate(previousDay.getDate() - 1);

  const activeToday = getActiveServiceIdsForDate(canonical, date);
  const activeYesterday = getActiveServiceIdsForDate(canonical, previousDay);

  const tenMinutesMs = 10 * 60 * 1000;
  const cutoff = new Date(date.getTime() - tenMinutesMs);
  const upperCutoff = lookAheadHours
    ? new Date(date.getTime() + lookAheadHours * 60 * 60 * 1000)
    : null;

  const baseDates: { base: Date; services: Set<string> }[] = [
    { base: date, services: activeToday },
    { base: previousDay, services: activeYesterday },
  ];
  if (upperCutoff) {
    const cursor = new Date(date);
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() + 1);
    while (cursor <= upperCutoff) {
      baseDates.push({
        base: new Date(cursor),
        services: getActiveServiceIdsForDate(canonical, new Date(cursor)),
      });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // No realtime updates in the oracle — empty Map mirrors store behavior when
  // there is no RT data (predictedTime/delaySeconds/cancelled all undefined).
  const realtimeUpdates = new Map<string, { delaySeconds: number; cancelled: boolean }>();

  const departures: Departure[] = [];

  for (const { base: baseDate, services: activeServices } of baseDates) {
    for (let i = 0; i < tripIdIdx.length; i++) {
      const tripId = canonical.getTripIdForIx(tripIdIdx[i]!);
      if (!tripId) continue;
      const trip = canonical.getTrip(tripId);
      if (!trip) continue;
      if (!activeServices.has(trip.serviceId)) continue;

      const route = canonical.getRoute(trip.routeId);
      if (!route) continue;

      const scheduledDate = secsToDate(baseDate, depSecsArr[i]!);

      if (scheduledDate < cutoff) continue;
      if (upperCutoff && scheduledDate > upperCutoff) continue;

      const baseDateStr = formatDateYYYYMMDD(baseDate);
      const rt = realtimeUpdates.get(`${trip.tripId}|${baseDateStr}`)
        ?? realtimeUpdates.get(trip.tripId);

      let predictedTime: string | undefined;
      let delaySeconds: number | undefined;
      let cancelled: boolean | undefined;

      if (rt) {
        delaySeconds = rt.delaySeconds;
        cancelled = rt.cancelled || undefined;
        if (rt.delaySeconds !== 0) {
          const predicted = new Date(
            scheduledDate.getTime() + rt.delaySeconds * 1000,
          );
          predictedTime = predicted.toISOString();
        }
      }

      departures.push({
        routeId: route.id,
        routeShortName: route.shortName,
        // NOTE: The production getDepartures resolves routeColor/subMode via
        // routeSubModeMap + subModeById (populated asynchronously by
        // scheduleColorConfig/setImmediate). Tests call getDepartures
        // synchronously after swap(), so those maps are still empty and the
        // production code falls through to the raw-GTFS fallback path — which
        // is what we hardcode here. If a future test flushes setImmediate
        // before asserting, this oracle needs to populate the same maps or
        // use a shared helper.
        routeColor: route.color ? `#${route.color}` : undefined,
        mode: route.mode,
        subMode: route.mode,
        headsign: trip.headsign,
        scheduledTime: scheduledDate.toISOString(),
        predictedTime,
        delaySeconds,
        tripId: trip.tripId,
        cancelled,
      });
    }
  }

  departures.sort(
    (a, b) =>
      new Date(a.scheduledTime).getTime() -
      new Date(b.scheduledTime).getTime(),
  );

  return departures.slice(0, limit);
}
