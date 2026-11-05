import type {
  GtfsStop,
  GtfsRoute,
  GtfsTrip,
  GtfsStopTime,
  GtfsService,
} from "../parser.js";
import type { CanonicalStore } from "../canonical/CanonicalStore.js";

// ── Fixture: variant-pattern city ──────────────────────────────────────────
//
// Two routes with different stop-pattern structures:
//
//   Route R1 — three trip patterns:
//     Canonical (long):  [A, B, C, D, E]  — picked by index-builder as canonical
//                        (longest = 5 stops)
//     Variant 1 (short): [A, B, E]        — skips C and D
//     Variant 2:         [A, F, B]        — stop F is NOT in the canonical sequence
//
//   Route R2 — single pattern: [X, Y, Z]
//
// All stops:  A, B, C, D, E, F  (for R1)   +   X, Y, Z  (for R2)
//
// Stop coverage:
//   A, B      — in BOTH R1 patterns (canonical and variants)
//   C, D      — ONLY in R1 canonical (long) pattern → fast path
//   E         — in R1 canonical and variant 1
//   F         — ONLY in R1 variant 2 (T_R1_VAR2) → exercises fallback path
//   X, Y, Z   — only in R2
//
// Service: always-active (all days, 2020-01-01 → 2099-12-31)
//
// Active trips in an 08:00-10:00 window (query date 2026-04-20T08:00:00Z):
//   R1 canonical trip T_R1_LONG  — departs A at 08:00, B at 08:02, C at 08:04,
//                                   D at 08:06, E at 08:08
//   R1 variant trip   T_R1_VAR   — departs A at 09:00, B at 09:02, E at 09:04
//   R1 variant trip   T_R1_VAR2  — departs A at 09:10, F at 09:12, B at 09:14
//   R2 trip           T_R2       — departs X at 08:30, Y at 08:32, Z at 08:34

export const fixtureStops: GtfsStop[] = [
  { id: "A", name: "Stop A", lat: 48.85, lon: 2.34, parentStation: "" },
  { id: "B", name: "Stop B", lat: 48.86, lon: 2.35, parentStation: "" },
  { id: "C", name: "Stop C", lat: 48.87, lon: 2.36, parentStation: "" },
  { id: "D", name: "Stop D", lat: 48.88, lon: 2.37, parentStation: "" },
  { id: "E", name: "Stop E", lat: 48.89, lon: 2.38, parentStation: "" },
  { id: "F", name: "Stop F", lat: 48.84, lon: 2.33, parentStation: "" },
  { id: "X", name: "Stop X", lat: 48.80, lon: 2.30, parentStation: "" },
  { id: "Y", name: "Stop Y", lat: 48.81, lon: 2.31, parentStation: "" },
  { id: "Z", name: "Stop Z", lat: 48.82, lon: 2.32, parentStation: "" },
];

export const fixtureRoutes: GtfsRoute[] = [
  {
    id: "R1",
    shortName: "1",
    longName: "Route One (variant pattern)",
    mode: "BUS",
    color: "FF0000",
    textColor: "FFFFFF",
  },
  {
    id: "R2",
    shortName: "2",
    longName: "Route Two (single pattern)",
    mode: "BUS",
    color: "0000FF",
    textColor: "FFFFFF",
  },
];

export const fixtureTrips: GtfsTrip[] = [
  // R1 canonical (long) trip — covers [A, B, C, D, E]
  { tripId: "T_R1_LONG", routeId: "R1", serviceId: "SVC_VP", headsign: "Stop E" },
  // R1 variant 1 (short) trip — covers [A, B, E]
  { tripId: "T_R1_VAR",  routeId: "R1", serviceId: "SVC_VP", headsign: "Stop E" },
  // R1 variant 2 — covers [A, F, B] — stop F is absent from the canonical sequence
  { tripId: "T_R1_VAR2", routeId: "R1", serviceId: "SVC_VP", headsign: "Stop B" },
  // R2 trip — covers [X, Y, Z]
  { tripId: "T_R2",      routeId: "R2", serviceId: "SVC_VP", headsign: "Stop Z" },
];

// departureSecs reference (seconds since midnight):
//   08:00 = 28800   08:02 = 28920   08:04 = 29040   08:06 = 29160   08:08 = 29280
//   08:30 = 30600   08:32 = 30720   08:34 = 30840
//   09:00 = 32400   09:02 = 32520   09:04 = 32640
//   09:10 = 33000   09:12 = 33120   09:14 = 33240

export const fixtureStopTimes: GtfsStopTime[] = [
  // T_R1_LONG — canonical long pattern: A(0) B(1) C(2) D(3) E(4)
  { tripId: "T_R1_LONG", stopId: "A", departureTime: "08:00:00", stopSequence: 1 },
  { tripId: "T_R1_LONG", stopId: "B", departureTime: "08:02:00", stopSequence: 2 },
  { tripId: "T_R1_LONG", stopId: "C", departureTime: "08:04:00", stopSequence: 3 },
  { tripId: "T_R1_LONG", stopId: "D", departureTime: "08:06:00", stopSequence: 4 },
  { tripId: "T_R1_LONG", stopId: "E", departureTime: "08:08:00", stopSequence: 5 },
  // T_R1_VAR — variant 1 short pattern: A(0) B(1) E(2) — skips C and D
  { tripId: "T_R1_VAR",  stopId: "A", departureTime: "09:00:00", stopSequence: 1 },
  { tripId: "T_R1_VAR",  stopId: "B", departureTime: "09:02:00", stopSequence: 2 },
  { tripId: "T_R1_VAR",  stopId: "E", departureTime: "09:04:00", stopSequence: 3 },
  // T_R1_VAR2 — variant 2 pattern: A(0) F(1) B(2) — F is absent from canonical
  { tripId: "T_R1_VAR2", stopId: "A", departureTime: "09:10:00", stopSequence: 1 },
  { tripId: "T_R1_VAR2", stopId: "F", departureTime: "09:12:00", stopSequence: 2 },
  { tripId: "T_R1_VAR2", stopId: "B", departureTime: "09:14:00", stopSequence: 3 },
  // T_R2 — single pattern: X(0) Y(1) Z(2)
  { tripId: "T_R2",      stopId: "X", departureTime: "08:30:00", stopSequence: 1 },
  { tripId: "T_R2",      stopId: "Y", departureTime: "08:32:00", stopSequence: 2 },
  { tripId: "T_R2",      stopId: "Z", departureTime: "08:34:00", stopSequence: 3 },
];

export const fixtureServices: GtfsService[] = [
  {
    serviceId: "SVC_VP",
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

// ── Helpers (mirrored from store.ts private scope) ────────────────────────

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
 * Reference implementation of getActiveRoutesByStop that mirrors the
 * pre-CT5 linear-scan behavior. Used as a trusted oracle for fidelity
 * tests of the routeStopIndex-based fast path. Do NOT optimize.
 *
 * IMPORTANT: matches the production algorithm that existed BEFORE the
 * CT5 rewrite. If production is changed, update this only to pick up
 * bug fixes, never to mirror optimizations.
 */
export function bruteForceActiveRoutes(
  canonical: CanonicalStore,
  date: Date,
  lookaheadHours: number,
): Map<string, Set<string>> {
  const previousDay = new Date(date);
  previousDay.setDate(previousDay.getDate() - 1);

  const activeToday = getActiveServiceIdsForDate(canonical, date);
  const activeYesterday = getActiveServiceIdsForDate(canonical, previousDay);

  const tenMinutesMs = 10 * 60 * 1000;
  const cutoff = new Date(date.getTime() - tenMinutesMs);
  const upperCutoff = new Date(date.getTime() + lookaheadHours * 60 * 60 * 1000);

  const baseDates: { base: Date; services: Set<string> }[] = [
    { base: date, services: activeToday },
    { base: previousDay, services: activeYesterday },
  ];
  {
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

  const result = new Map<string, Set<string>>();

  for (const { base: baseDate, services: activeServices } of baseDates) {
    const scheduledMidnight = new Date(baseDate);
    scheduledMidnight.setHours(0, 0, 0, 0);
    const baseMs = scheduledMidnight.getTime();

    canonical.iterCompactStopTimes((stopId, ct) => {
      const { tripIdIdx, departureSecs } = ct;
      for (let i = 0; i < tripIdIdx.length; i++) {
        const tripId = canonical.getTripIdForIx(tripIdIdx[i]!);
        if (!tripId) continue;
        const trip = canonical.getTrip(tripId);
        if (!trip) continue;
        if (!activeServices.has(trip.serviceId)) continue;

        const scheduledDate = new Date(baseMs + departureSecs[i]! * 1000);
        if (scheduledDate < cutoff || scheduledDate > upperCutoff) continue;

        let routeSet = result.get(stopId);
        if (!routeSet) {
          routeSet = new Set<string>();
          result.set(stopId, routeSet);
        }
        routeSet.add(trip.routeId);
      }
    });
  }

  return result;
}
