// K5(a) — Pin TZ before any imports so the no-tz (backend) leg of
// getDeparturesFromTile uses Europe/Paris local-date maths, matching
// the client leg that passes explicit tz="Europe/Paris".
process.env.TZ = "Europe/Paris";

import { describe, it, expect } from "vitest";
import {
  getDeparturesFromTile,
  type DecodedScheduleTile,
} from "@pt/shared";
import { GtfsStore } from "../gtfs/store.js";

/**
 * J6 — Client-seam fidelity test (with K5 pins).
 *
 * Asserts that the SAME fixture driven through:
 *   (a) the backend leg: getDeparturesFromTile with NO tz (process.env.TZ = "Europe/Paris")
 *   (b) the client leg: getDeparturesFromTile with explicit tz = "Europe/Paris"
 * produces a byte-identical Departure[] including scheduledTime, predictedTime,
 * delaySeconds, cancelled, subMode, and tripId.
 *
 * The client reconstructs a realtimeUpdates map from the rt-tile wire (same
 * key construction as departuresForStop/readPath.ts). The backend leg uses the
 * REAL GtfsStore.setRealtimeUpdates + rtUpdatesSnapshot so the seam is
 * differential (catches future key-construction drift), not imitative. Any
 * divergence in key construction, tripId extraction, subMode fallback, or tz
 * handling is caught here.
 *
 * K5 pins applied:
 *   (a) process.env.TZ = "Europe/Paris" (backend leg) vs explicit tz="Europe/Paris" (client leg).
 *   (b) identical limit=100, lookAheadHours=24 on both legs.
 *   (c) route.subMode is EXPLICITLY set in the tile fixture (not undefined →
 *       route.subMode ?? route.mode fallback) so both paths produce the same subMode.
 */

const HASH = "b".repeat(64);

/**
 * Fixture tile: three trips at stop S1.
 *   T1 — normal trip, 08:00, delayed 120s; subMode="EXPRESS_BUS" (K5c — explicit)
 *   T2 — normal trip, 09:30, cancelled
 *   T3 — no RT entry; scheduled only
 *
 * Calendar: active every day of 2026-06-11 (Thursday, dayIx=3).
 * now = 2026-06-11 07:00 Paris (CEST=UTC+2) → lower cutoff = 06:50.
 * All three departures (08:00, 09:30, 10:00) fall inside the 24h window.
 */
function fixtureTile(): DecodedScheduleTile {
  return {
    bundleHash: HASH,
    cityId: "paris",
    tileSize: 12000,
    stringTable: ["T1", "T2", "T3", "Gare du Nord"],
    routes: [
      {
        id: "R1",
        shortName: "42",
        longName: "Express Line 42",
        color: "#FF6600",
        mode: "BUS",
        // K5(c): subMode is explicitly populated — not undefined.
        // getDeparturesFromTile emits `subMode: route.subMode ?? route.mode`.
        // With subMode present both paths emit "EXPRESS_BUS" without fallback.
        subMode: "EXPRESS_BUS",
      },
    ],
    calendar: [
      {
        serviceId: "DAILY",
        startDate: "20260601",
        endDate: "20260630",
        days: [true, true, true, true, true, true, true],
        added: [],
        removed: [],
      },
    ],
    trips: [
      { tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // T1
      { tripIdIx: 1, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // T2
      { tripIdIx: 2, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // T3
    ],
    stops: {
      S1: {
        tripIxs: new Uint32Array([0, 1, 2]),
        // 08:00 = 28800, 09:30 = 34200, 10:00 = 36000
        departureSecs: new Uint32Array([28800, 34200, 36000]),
      },
    },
  };
}

/**
 * Backend snapshot via the REAL GtfsStore.setRealtimeUpdates + rtUpdatesSnapshot
 * so the seam is differential (catches future key-construction / tripId-field drift)
 * rather than imitative (a hand-rolled map that silently mirrors the implementation).
 *
 * T1: delayed 120s; T2: cancelled; T3: no entry (scheduled only).
 */
function backendRtMap(): ReadonlyMap<string, { tripId: string; delaySeconds: number; cancelled: boolean }> {
  const store = new GtfsStore();
  store.setRealtimeUpdates(new Map([
    ["T1", { delaySeconds: 120, cancelled: false }],
    ["T2", { delaySeconds: 0,   cancelled: true  }],
  ]));
  // rtUpdatesSnapshot() returns undefined when the map is empty; here it is not.
  return store.rtUpdatesSnapshot()!;
}

/**
 * Client-side rt-tile wire: same trips, same keys. The client reconstructs
 * the key as `t.startDate ? \`${t.tripId}|${t.startDate}\` : t.tripId`, mirroring
 * departuresForStop in scheduleTileReadPath.ts.
 *
 * Deliberately omits startDate for bare-key entries (matches prod backend behaviour
 * for routes that serve a single-YYYYMMDD trip per poll cycle: store.ts uses bare
 * keys when startDate is absent from the GTFS-RT feed).
 */
const WIRE_TRIPS = [
  { tripId: "T1", delaySeconds: 120, cancelled: false },
  { tripId: "T2", delaySeconds: 0,   cancelled: true  },
];

function clientRtMap(): Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }> {
  return new Map(
    WIRE_TRIPS.map((t) => [
      // Mirror the reconstruction in scheduleTileReadPath.ts:119-124
      "startDate" in t && (t as { startDate?: string }).startDate !== undefined
        ? `${t.tripId}|${(t as { startDate?: string }).startDate}`
        : t.tripId,
      { tripId: t.tripId, delaySeconds: t.delaySeconds, cancelled: t.cancelled },
    ]),
  );
}

describe("J6 — client-seam fidelity: backend-rt-map ↔ wire-rebuilt-rt-map (K5 pins)", () => {
  it("produces byte-identical Departure[] including scheduledTime/predictedTime/delaySeconds/cancelled/subMode/tripId", () => {
    // K5(b): identical limit=100, lookAheadHours=24 on both legs.
    // now = 2026-06-11 07:00 Paris (CEST=UTC+2).
    const now = new Date("2026-06-11T05:00:00Z"); // 07:00 Paris CEST (UTC+2)
    const tile = fixtureTile();

    // Backend leg: NO tz parameter (process.env.TZ = "Europe/Paris" set above).
    const backend = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 100,
      lookAheadHours: 24,
      realtimeUpdates: backendRtMap(),
      // tz intentionally absent — matches store.getDepartures which passes no tz.
    });

    // Client leg: explicit tz = "Europe/Paris" (K5a — the client path in
    // departuresForStop/scheduleTileReadPath.ts:132 passes useCityStore.getState().activeCity.tz).
    const client = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 100,
      lookAheadHours: 24,
      realtimeUpdates: clientRtMap(),
      tz: "Europe/Paris",
    });

    // ─── Core assertion (J6) ────────────────────────────────────────────────
    // Full Departure[] equality — do NOT weaken to a subset check.
    // Any divergence in key construction, tripId extraction, subMode fallback,
    // or tz handling surfaces here.
    expect(client.departures).toEqual(backend.departures);

    // ─── Sanity guards ───────────────────────────────────────────────────────
    // Non-empty (all three trips must fall in the 24h window).
    expect(client.departures.length).toBeGreaterThanOrEqual(2);

    // T1: delayed row carries predictedTime and delaySeconds=120.
    const t1 = client.departures.find((d) => d.tripId === "T1");
    expect(t1).toBeDefined();
    expect(t1?.delaySeconds).toBe(120);
    expect(t1?.predictedTime).toBeDefined();
    expect(t1?.cancelled).toBeUndefined(); // not cancelled

    // T2: cancelled row.
    const t2 = client.departures.find((d) => d.tripId === "T2");
    expect(t2).toBeDefined();
    expect(t2?.cancelled).toBe(true);
    expect(t2?.predictedTime).toBeUndefined(); // delay=0 → no predictedTime

    // T3: scheduled only (no RT entry).
    const t3 = client.departures.find((d) => d.tripId === "T3");
    expect(t3).toBeDefined();
    expect(t3?.predictedTime).toBeUndefined();
    expect(t3?.delaySeconds).toBeUndefined();

    // K5(c): subMode is "EXPRESS_BUS" (explicit on route, not mode fallback).
    // Both paths must emit it identically.
    expect(t1?.subMode).toBe("EXPRESS_BUS");
    expect(t2?.subMode).toBe("EXPRESS_BUS");
    expect(t3?.subMode).toBe("EXPRESS_BUS");

    // scheduledTime must be ISO strings (not undefined).
    expect(typeof t1?.scheduledTime).toBe("string");
    expect(typeof t2?.scheduledTime).toBe("string");
    expect(typeof t3?.scheduledTime).toBe("string");
  });

  it("date-scoped key (tripId|YYYYMMDD) is matched identically on both sides", () => {
    // Fixture with a date-scoped RT entry: T1|20260611 → delay 300.
    // Backend snapshot: store emits `${tripId}|${YYYYMMDD}` when startDate is present.
    // Client wire: { tripId, startDate } → client reconstructs `${tripId}|${startDate}`.
    const now = new Date("2026-06-11T05:00:00Z"); // 07:00 Paris CEST
    const tile = fixtureTile();

    const backendMap: ReadonlyMap<string, { tripId: string; delaySeconds: number; cancelled: boolean }> = new Map([
      ["T1|20260611", { tripId: "T1", delaySeconds: 300, cancelled: false }],
    ]);

    const wireTrips = [{ tripId: "T1", startDate: "20260611", delaySeconds: 300, cancelled: false }];
    const clientMap = new Map(
      wireTrips.map((t) => [
        `${t.tripId}|${t.startDate}`,
        { tripId: t.tripId, delaySeconds: t.delaySeconds, cancelled: t.cancelled },
      ]),
    );

    const backend = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 100, lookAheadHours: 24,
      realtimeUpdates: backendMap,
    });
    const client = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 100, lookAheadHours: 24,
      realtimeUpdates: clientMap, tz: "Europe/Paris",
    });

    // Core: byte-identical.
    expect(client.departures).toEqual(backend.departures);

    // T1 matched by date-scoped key: delay=300.
    const t1Backend = backend.departures.find((d) => d.tripId === "T1");
    const t1Client = client.departures.find((d) => d.tripId === "T1");
    expect(t1Backend?.delaySeconds).toBe(300);
    expect(t1Client?.delaySeconds).toBe(300);
  });
});
