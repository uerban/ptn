import { describe, it, expect } from "vitest";
import { getDeparturesFromTile } from "./getDeparturesFromTile.js";
import { mkFixture } from "./__fixtures__/mkFixture.js";

const ALL_DAYS = [true, true, true, true, true, true, true] as const;
const WEEKDAYS = [true, true, true, true, true, false, false] as const;
const WEEKENDS = [false, false, false, false, false, true, true] as const;

describe("parity oracle — batch 1", () => {
  // ── F1 — Basic happy path: one trip, one stop, daily service ─────────────
  it("F1: basic single-trip daily — returns the upcoming departure with full Departure shape", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", longName: "Line One", mode: "BUS", color: "#FF6600" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });
    const now = new Date(2026, 4, 4, 7, 0, 0); // Mon 07:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    const d = departures[0]!;
    expect(d.tripId).toBe("T1");
    expect(d.routeId).toBe("R1");
    expect(d.routeShortName).toBe("1");
    expect(d.routeColor).toBe("#FF6600");
    expect(d.mode).toBe("BUS");
    expect(d.subMode).toBe("BUS"); // fallback to mode when subMode absent
    expect(d.headsign).toBe("Downtown");
    expect(new Date(d.scheduledTime).getHours()).toBe(8);
    expect(new Date(d.scheduledTime).getMinutes()).toBe(0);
    expect(d.predictedTime).toBeUndefined();
    expect(d.delaySeconds).toBeUndefined();
    expect(d.cancelled).toBeUndefined();
    // Pin the date to today (not yesterday-rollover): protects against a
    // regression that emits yesterday's same-time trip with a 24h offset.
    expect(new Date(d.scheduledTime).getDate()).toBe(4); // Mon 2026-05-04
  });

  // ── F2 — Weekday-only service, query on Saturday ─────────────────────────
  it("F2: weekday-only service queried on Saturday — no_service_today", () => {
    const tile = mkFixture({
      services: [{ id: "SVC_WEEKDAYS", days: WEEKDAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC_WEEKDAYS", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });
    const now = new Date(2026, 4, 2, 7, 0, 0); // Sat 07:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("no_service_today");
    expect(departures).toEqual([]);
  });

  // ── F3 — Weekend-only service, query on Sunday ───────────────────────────
  it("F3: weekend-only service queried on Sunday — active and visible", () => {
    const tile = mkFixture({
      services: [{ id: "SVC_WEEKENDS", days: WEEKENDS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T_SUN", routeId: "R1", serviceId: "SVC_WEEKENDS", headsign: "Beach",
        stopTimes: [{ stopId: "S1", departureSec: 10 * 3600 }],
      }],
    });
    const now = new Date(2026, 4, 3, 9, 0, 0); // Sun 09:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    expect(departures[0]!.tripId).toBe("T_SUN");
    expect(new Date(departures[0]!.scheduledTime).getHours()).toBe(10);
  });

  // ── F4 — Calendar exception: holiday-added (`added` overrides days mask) ──
  it("F4: holiday-added exception forces ON outside the days mask", () => {
    const tile = mkFixture({
      services: [{
        id: "SVC_WD_PLUS_HOLIDAY",
        days: WEEKDAYS,
        added: ["20260704"], // Sat 2026-07-04 — forced ON despite Sat=false
      }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC_WD_PLUS_HOLIDAY", headsign: "Parade",
        stopTimes: [{ stopId: "S1", departureSec: 11 * 3600 }],
      }],
    });
    const now = new Date(2026, 6, 4, 10, 0, 0); // Sat 2026-07-04 10:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    expect(departures[0]!.headsign).toBe("Parade");
  });

  // ── F5 — Overnight rollover: yesterday's late trip in today's window ─────
  it("F5: overnight trip from yesterday (departureSec >= 86400) rolls into today's wall-clock", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R_NIGHT", shortName: "N1", mode: "BUS" }],
      trips: [{
        tripId: "T_LATE", routeId: "R_NIGHT", serviceId: "SVC", headsign: "Airport",
        stopTimes: [{ stopId: "S1", departureSec: 25 * 3600 + 30 * 60 }], // 25:30
      }],
    });
    const now = new Date(2026, 4, 4, 1, 0, 0); // Mon 01:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    // Today's service IS active (SVC daily), so serviceState reflects the
    // window-presence: yesterday's overnight trip surfaces at today 01:30.
    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    const t = new Date(departures[0]!.scheduledTime);
    expect(t.getDate()).toBe(4);    // Mon 2026-05-04 wall-clock
    expect(t.getHours()).toBe(1);
    expect(t.getMinutes()).toBe(30);
  });
});

describe("parity oracle — batch 2", () => {
  // ── F6 — Removed-date exception forces OFF a service day ─────────────────
  it("F6: removed-date exception forces OFF a service day even when days mask says active", () => {
    const tile = mkFixture({
      services: [{
        id: "SVC",
        days: ALL_DAYS,
        removed: ["20260504"], // Mon — forced OFF despite all-days
      }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });
    const now = new Date(2026, 4, 4, 7, 0, 0); // Mon 07:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("no_service_today");
    expect(departures).toEqual([]);
  });

  // ── F7 — Calendar window boundary: exact startDate ───────────────────────
  it("F7: service active exactly on startDate; inactive the day before", () => {
    const tile = mkFixture({
      services: [{
        id: "SVC",
        days: ALL_DAYS,
        startDate: "20260101",
        endDate: "20261231",
      }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });

    // On startDate (2026-01-01, Thu) — active.
    const onStart = getDeparturesFromTile({
      tile, stopId: "S1", now: new Date(2026, 0, 1, 7, 0, 0),
      limit: 20, lookAheadHours: 2,
    });
    expect(onStart.serviceState).toBe("active");
    expect(onStart.departures).toHaveLength(1);

    // Day before startDate (2025-12-31, Wed) — inactive (today).
    const dayBefore = getDeparturesFromTile({
      tile, stopId: "S1", now: new Date(2025, 11, 31, 7, 0, 0),
      limit: 20, lookAheadHours: 2,
    });
    expect(dayBefore.serviceState).toBe("no_service_today");
    expect(dayBefore.departures).toEqual([]);
  });

  // ── F7b — Calendar boundary crossed by multi-day expansion ───────────────
  it("F7b: query day-before-startDate with lookAhead=24 — tomorrow's first trip surfaces in window but pill is no_service_today", () => {
    const tile = mkFixture({
      services: [{
        id: "SVC", days: ALL_DAYS,
        startDate: "20260101", endDate: "20261231",
      }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });
    // Wed 2025-12-31 09:00 + 24h crosses into Thu 2026-01-01 09:00.
    // Today (Wed) inactive (before startDate); tomorrow (Thu) active. The
    // 08:00 trip on Thu falls inside the window.
    const now = new Date(2025, 11, 31, 9, 0, 0);

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 24,
    });

    // Tomorrow's trip surfaces — 1 departure in window.
    expect(departures).toHaveLength(1);
    expect(new Date(departures[0]!.scheduledTime).getDate()).toBe(1); // Jan 1
    // Pill describes today; today is inactive (pre-startDate).
    expect(serviceState).toBe("no_service_today");
  });

  // ── F8 — Multi-trip sort + limit truncation ──────────────────────────────
  it("F8: 5 trips, limit=3 — returns the 3 earliest scheduled times", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [
        { tripId: "T_0830", routeId: "R1", serviceId: "SVC", headsign: "A",
          stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 + 30 * 60 }] },
        { tripId: "T_0900", routeId: "R1", serviceId: "SVC", headsign: "A",
          stopTimes: [{ stopId: "S1", departureSec: 9 * 3600 }] },
        { tripId: "T_0800", routeId: "R1", serviceId: "SVC", headsign: "A",
          stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }] },
        { tripId: "T_1000", routeId: "R1", serviceId: "SVC", headsign: "A",
          stopTimes: [{ stopId: "S1", departureSec: 10 * 3600 }] },
        { tripId: "T_0930", routeId: "R1", serviceId: "SVC", headsign: "A",
          stopTimes: [{ stopId: "S1", departureSec: 9 * 3600 + 30 * 60 }] },
      ],
    });
    const now = new Date(2026, 4, 4, 7, 0, 0); // Mon 07:00, lookAhead=4h → upper 11:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 3, lookAheadHours: 4,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(3);
    expect(departures.map((d) => d.tripId)).toEqual(["T_0800", "T_0830", "T_0900"]);
  });

  // ── F9 — ended_today: today active, no upcoming trip in window ───────────
  it("F9: today active but the last trip already departed — ended_today", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });
    // Mon 23:00 with lookAhead=1 → window ends Mon 24:00. 08:00 trip is 15h
    // ago, well past the 10-min cutoff. No today departures upcoming.
    const now = new Date(2026, 4, 4, 23, 0, 0);

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 1,
    });

    expect(serviceState).toBe("ended_today");
    expect(departures).toEqual([]);
  });

  // ── F10 — Cross-midnight forward: tomorrow's early trip in window ────────
  it("F10: lookAhead crosses midnight — tomorrow's early trip surfaces", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T_EARLY", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 1 * 3600 }], // 01:00
      }],
    });
    const now = new Date(2026, 4, 4, 23, 30, 0); // Mon 23:30, lookAhead=2h → Tue 01:30

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    const t = new Date(departures[0]!.scheduledTime);
    expect(t.getDate()).toBe(5);   // Tue 2026-05-05
    expect(t.getHours()).toBe(1);
    expect(t.getMinutes()).toBe(0);
  });
});

describe("parity oracle — batch 3", () => {
  // ── F11 — DST spring-forward (Europe/Vilnius: 2026-03-29 03:00 → 04:00) ──
  // The 03:30 wall-clock time does not exist on this date in Vilnius (EET → EEST).
  // A trip scheduled at departureSec=03:30 should still produce a valid Date
  // (JS Date normalises the gap forward to 04:30 in the host TZ when DST applies).
  // The fixture asserts the trip is INCLUDED in the window and the consumer
  // does not crash; exact wall-clock value is host-TZ-dependent so we only
  // assert presence + serviceState.
  it("F11: DST spring-forward — trip in the missing hour does not crash; service is active", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T_DST", routeId: "R1", serviceId: "SVC", headsign: "City",
        // Europe/Vilnius spring-forward: clocks jump 03:00 → 04:00 on 2026-03-29.
        // So 03:30 local falls in the non-existent gap; JS Date normalises it to 04:30.
        stopTimes: [{ stopId: "S1", departureSec: 3 * 3600 + 30 * 60 }], // 03:30
      }],
    });
    // Sun 2026-03-29 01:00 local. lookAhead=4h window ends 05:00 local,
    // which covers the normalised 04:30 departure in both DST and no-DST hosts.
    const now = new Date(2026, 2, 29, 1, 0, 0);

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 4,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    expect(departures[0]!.tripId).toBe("T_DST");
    // ISO is well-formed (no NaN, no "Invalid Date").
    expect(Number.isNaN(new Date(departures[0]!.scheduledTime).getTime())).toBe(false);
    // With TZ pinned to Europe/Vilnius, the 03:30 wall-clock falls in the spring-forward gap
    // (03:00–04:00). JS Date normalises forward by one hour, so getHours() returns 4 (not 3). This
    // is parity with legacy `secsToDate`. If JS engine semantics ever change, this assertion
    // catches the drift before it ships.
    expect(new Date(departures[0]!.scheduledTime).getHours()).toBe(4);
    // TZ-host-independent rigor: with an RT delay of 600s, predictedTime
    // MUST equal scheduledTime + 600s exactly. The legacy `predictedTime =
    // scheduledDate + delaySeconds*1000` is a pure delta, immune to host TZ.
    // Re-run with RT to assert the delta survives DST normalisation.
    const rt = new Map([["T_DST|20260329", { tripId: "T_DST", delaySeconds: 600, cancelled: false }]]);
    const withRt = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 4,
      realtimeUpdates: rt,
    });
    expect(withRt.departures).toHaveLength(1);
    const dep = withRt.departures[0]!;
    const scheduledMs = new Date(dep.scheduledTime).getTime();
    const predictedMs = new Date(dep.predictedTime!).getTime();
    expect(predictedMs - scheduledMs).toBe(600_000);
    expect(dep.delaySeconds).toBe(600);
  });

  // ── F12 — DST fall-back (2026-10-25 03:00 → 02:00) ───────────────────────
  // The 02:30 wall-clock time occurs twice on this date in EU. JS Date.setSeconds
  // resolves to one of the two (host-TZ-dependent). Same parity contract: do
  // not crash; produce a well-formed ISO; service is active.
  it("F12: DST fall-back — repeated hour does not crash; service is active", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T_DST_FALL", routeId: "R1", serviceId: "SVC", headsign: "City",
        stopTimes: [{ stopId: "S1", departureSec: 2 * 3600 + 30 * 60 }],
      }],
    });
    const now = new Date(2026, 9, 25, 1, 0, 0); // Sun 2026-10-25 01:00 local

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 4,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    expect(Number.isNaN(new Date(departures[0]!.scheduledTime).getTime())).toBe(false);
  });

  // ── F13 — Sub-mode color resolution (consumer takes RouteRow.color verbatim) ──
  it("F13: sub-mode color override — RouteRow.color carries the resolved brand color", () => {
    // PR 2 generation is responsible for resolving subModeById.color over
    // the GTFS route_color column. From the consumer's perspective,
    // RouteRow.color is the final answer.
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{
        id: "R_EXP",
        shortName: "X1",
        longName: "Express",
        mode: "BUS",
        subMode: "EXPRESS_BUS",
        color: "#FFCC00", // resolved sub-mode brand color, not the GTFS route_color
      }],
      trips: [{
        tripId: "T1", routeId: "R_EXP", serviceId: "SVC", headsign: "Express",
        stopTimes: [{ stopId: "S1", departureSec: 9 * 3600 }],
      }],
    });
    const now = new Date(2026, 4, 4, 8, 0, 0); // Mon 08:00

    const { departures } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(departures).toHaveLength(1);
    expect(departures[0]!.routeColor).toBe("#FFCC00");
    expect(departures[0]!.subMode).toBe("EXPRESS_BUS");
    expect(departures[0]!.mode).toBe("BUS");
  });

  // ── F14 — 10-minute backward cutoff: exact-boundary inclusion ────────────
  it("F14: trip exactly at the 10-min cutoff boundary is INCLUDED", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T_BOUNDARY", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }], // 08:00
      }],
    });
    // Query at 08:10:00 — cutoff is 08:00:00 — trip's scheduled wall-clock equals cutoff.
    // Belt-and-suspenders check is `scheduledMs < cutoffMs` (strict); equality survives.
    const now = new Date(2026, 4, 4, 8, 10, 0);

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 1,
    });

    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(1);
    expect(departures[0]!.tripId).toBe("T_BOUNDARY");
  });

  it("F14b: trip 1 second past the 10-min cutoff is EXCLUDED", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T_PAST", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }], // 08:00:00
      }],
    });
    // Query at 08:10:01 — cutoff is 08:00:01 — trip at 08:00:00 is 1s before cutoff.
    // Excluded (ended_today).
    const now = new Date(2026, 4, 4, 8, 10, 1);

    const { serviceState, departures } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 1,
    });

    expect(serviceState).toBe("ended_today");
    expect(departures).toEqual([]);
  });

  // ── F15 — Missing stop ───────────────────────────────────────────────────
  it("F15: stop not present in tile.stops returns no_service_today + empty", () => {
    const tile = mkFixture({
      services: [{ id: "SVC", days: ALL_DAYS }],
      routes: [{ id: "R1", shortName: "1", mode: "BUS" }],
      trips: [{
        tripId: "T1", routeId: "R1", serviceId: "SVC", headsign: "Downtown",
        stopTimes: [{ stopId: "S1", departureSec: 8 * 3600 }],
      }],
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "DOES_NOT_EXIST", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("no_service_today");
    expect(departures).toEqual([]);
  });
});
