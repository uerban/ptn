import { describe, it, expect } from "vitest";
import { getDeparturesFromTile } from "./getDeparturesFromTile.js";
import { mkSingleTripTile } from "./__fixtures__/mkSingleTripTile.js";
import type {
  DecodedScheduleTile,
  CalendarRow,
  RouteRow,
  TileTripRow,
} from "../types/scheduleTile.js";

describe("getDeparturesFromTile", () => {
  it("returns the single in-window departure with the legacy Departure shape", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    // Query at 2026-05-04 07:00 local time (Mon). 08:00 trip is +1h ahead.
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const result = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 20,
      lookAheadHours: 2,
    });

    expect(result.serviceState).toBe("active");
    expect(result.departures).toHaveLength(1);
    const dep = result.departures[0]!;
    expect(dep.tripId).toBe("T1");
    expect(dep.routeId).toBe("R1");
    expect(dep.routeShortName).toBe("1");
    expect(dep.routeColor).toBe("#FF6600");
    expect(dep.mode).toBe("BUS");
    // subMode falls back to route.mode when RouteRow.subMode is absent.
    expect(dep.subMode).toBe("BUS");
    expect(dep.headsign).toBe("Downtown");
    // ISO of 2026-05-04T08:00:00 in local time. Test-host TZ-dependent;
    // assert via parsed time-of-day rather than literal string.
    expect(new Date(dep.scheduledTime).getHours()).toBe(8);
    expect(new Date(dep.scheduledTime).getMinutes()).toBe(0);
    // RT-derived fields are absent when `realtimeUpdates` is not provided.
    expect(dep.predictedTime).toBeUndefined();
    expect(dep.delaySeconds).toBeUndefined();
    expect(dep.cancelled).toBeUndefined();
  });

  it("returns serviceState='ended_today' when service is active but window has no departures", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    // Query at 2026-05-04 23:00 local. The 08:00 departure is 15h ago,
    // outside even the 10-minute backward cutoff. With lookAheadHours=1
    // the upper bound is 24:00 — no future departures today.
    const now = new Date(2026, 4, 4, 23, 0, 0);

    const result = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 20,
      lookAheadHours: 1,
    });

    expect(result.serviceState).toBe("ended_today");
    expect(result.departures).toEqual([]);
  });

  it("returns serviceState='no_service_today' when no calendar row is active for today's date", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    // Mutate calendar to be inactive for the query date.
    const inactiveTile: DecodedScheduleTile = {
      ...tile,
      calendar: [{ ...tile.calendar[0]!, days: [false, false, false, false, false, false, false] }],
    };
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const result = getDeparturesFromTile({
      tile: inactiveTile,
      stopId: "S1",
      now,
      limit: 20,
      lookAheadHours: 2,
    });

    expect(result.serviceState).toBe("no_service_today");
    expect(result.departures).toEqual([]);
  });

  it("returns empty + 'no_service_today' when stopId is absent from the tile", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const result = getDeparturesFromTile({
      tile,
      stopId: "MISSING",
      now,
      limit: 20,
      lookAheadHours: 2,
    });

    expect(result.serviceState).toBe("no_service_today");
    expect(result.departures).toEqual([]);
  });

  it("respects `limit` by slicing after the time-sorted list is built", () => {
    // Construct a tile with two trips both at the same stop within the window.
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const twoTripTile: DecodedScheduleTile = {
      ...tile,
      stringTable: ["T1", "Downtown", "T2", "Uptown"],
      trips: [
        { tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 },
        { tripIdIx: 2, routeIx: 0, serviceIx: 0, headsignIx: 3 },
      ],
      stops: {
        S1: {
          tripIxs: new Uint32Array([0, 1]),
          departureSecs: new Uint32Array([8 * 3600, 9 * 3600]),
        },
      },
    };
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const result = getDeparturesFromTile({
      tile: twoTripTile,
      stopId: "S1",
      now,
      limit: 1,
      lookAheadHours: 5,
    });

    expect(result.serviceState).toBe("active");
    expect(result.departures).toHaveLength(1);
    expect(result.departures[0]!.tripId).toBe("T1"); // earlier of the two
  });

  it("excludes departures more than 10 minutes in the past", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    // 08:00 trip; query at 08:11 — 11 minutes past, beyond the 10-minute
    // backward cutoff.
    const now = new Date(2026, 4, 4, 8, 11, 0);

    const result = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 20,
      lookAheadHours: 1,
    });

    expect(result.serviceState).toBe("ended_today");
    expect(result.departures).toEqual([]);
  });

  it("includes a departure within the 10-minute backward cutoff", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    // 08:00 trip; query at 08:09 — 9 minutes past, still inside the cutoff.
    const now = new Date(2026, 4, 4, 8, 9, 0);

    const result = getDeparturesFromTile({
      tile,
      stopId: "S1",
      now,
      limit: 20,
      lookAheadHours: 1,
    });

    expect(result.serviceState).toBe("active");
    expect(result.departures).toHaveLength(1);
  });

  it("serviceState is stop-scoped: 'no_service_today' when only unrelated services in the tile are active", () => {
    // Tile has TWO services: SVC_DAILY (active all year) and SVC_INACTIVE
    // (no days enabled). The trip at S1 uses SVC_INACTIVE; a separate trip
    // at S2 uses SVC_DAILY. A tile-global scan would falsely return
    // "ended_today" for S1; the correct answer is "no_service_today".
    const stringTable = ["T1", "Downtown", "T2", "Uptown"];
    const calendar: CalendarRow[] = [
      {
        serviceId: "SVC_DAILY",
        days: [true, true, true, true, true, true, true],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      },
      {
        serviceId: "SVC_INACTIVE",
        days: [false, false, false, false, false, false, false],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      },
    ];
    const routes: RouteRow[] = [
      { id: "R1", shortName: "1", longName: "Route One", mode: "BUS" },
    ];
    const trips: TileTripRow[] = [
      { tripIdIx: 0, routeIx: 0, serviceIx: 1, headsignIx: 1 }, // S1's trip — SVC_INACTIVE
      { tripIdIx: 2, routeIx: 0, serviceIx: 0, headsignIx: 3 }, // S2's trip — SVC_DAILY
    ];
    const tile: DecodedScheduleTile = {
      bundleHash: "deadbeef",
      cityId: "vilnius",
      tileSize: 12000,
      stringTable,
      routes,
      calendar,
      stops: {
        S1: {
          tripIxs: new Uint32Array([0]),
          departureSecs: new Uint32Array([8 * 3600]),
        },
        S2: {
          tripIxs: new Uint32Array([1]),
          departureSecs: new Uint32Array([9 * 3600]),
        },
      },
      trips,
    };
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const s1 = getDeparturesFromTile({ tile, stopId: "S1", now, limit: 20, lookAheadHours: 4 });
    expect(s1.serviceState).toBe("no_service_today");
    expect(s1.departures).toEqual([]);

    // Sanity: S2 with the same tile sees the active service.
    const s2 = getDeparturesFromTile({ tile, stopId: "S2", now, limit: 20, lookAheadHours: 4 });
    expect(s2.serviceState).toBe("active");
    expect(s2.departures).toHaveLength(1);
  });

  // ── Multi-day base-date expansion ─────────────────────────────────────────

  it("includes yesterday's late-night trip rolling into today's window (departureSecs >= 86400)", () => {
    // Trip "T_OVERNIGHT" runs on yesterday's service (Sun 2026-05-03), departing
    // at 25:30 (= 91800 sec, i.e. 01:30 today). Stop S1 only entry.
    const tile: DecodedScheduleTile = {
      bundleHash: "deadbeef",
      cityId: "vilnius",
      tileSize: 12000,
      stringTable: ["T_OVERNIGHT", "Airport"],
      routes: [{ id: "R1", shortName: "1", longName: "Route One", mode: "BUS" }],
      // Service runs Sun (slot 6) only; Mon 2026-05-04 must NOT be active for this service today.
      calendar: [{
        serviceId: "SVC_SUN_ONLY",
        days: [false, false, false, false, false, false, true],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      }],
      stops: {
        S1: {
          tripIxs: new Uint32Array([0]),
          departureSecs: new Uint32Array([25 * 3600 + 30 * 60]), // 91800
        },
      },
      trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
    };
    // Query at 2026-05-04 01:00 (Mon). Yesterday is Sun 2026-05-03 — service active.
    const now = new Date(2026, 4, 4, 1, 0, 0);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    // Expected: 1 departure at today 01:30 wall-clock, sourced from yesterday's base date.
    expect(result.departures).toHaveLength(1);
    expect(result.departures[0]!.tripId).toBe("T_OVERNIGHT");
    expect(new Date(result.departures[0]!.scheduledTime).getHours()).toBe(1);
    expect(new Date(result.departures[0]!.scheduledTime).getMinutes()).toBe(30);
    // serviceState reflects TODAY's stop-scoped check: SVC_SUN_ONLY is not active
    // on Mon 2026-05-04, so today's set is empty → "no_service_today".
    // (This intentionally diverges from "trip exists in window" — the pill
    // describes today's service, not what's about to roll past midnight.)
    expect(result.serviceState).toBe("no_service_today");
  });

  it("includes tomorrow's early trip when window extends past midnight (lookAheadHours crosses)", () => {
    // Trip "T_EARLY" runs daily at 01:00 (= 3600 sec). Query at 23:30 today
    // with lookAheadHours=2 → upperCutoff at tomorrow 01:30.
    const tile: DecodedScheduleTile = {
      bundleHash: "deadbeef",
      cityId: "vilnius",
      tileSize: 12000,
      stringTable: ["T_EARLY", "Downtown"],
      routes: [{ id: "R1", shortName: "1", longName: "Route One", mode: "BUS" }],
      calendar: [{
        serviceId: "SVC_DAILY",
        days: [true, true, true, true, true, true, true],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      }],
      stops: {
        S1: {
          tripIxs: new Uint32Array([0]),
          departureSecs: new Uint32Array([3600]), // 01:00:00
        },
      },
      trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
    };
    const now = new Date(2026, 4, 4, 23, 30, 0); // Mon 23:30

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(result.serviceState).toBe("active");
    expect(result.departures).toHaveLength(1);
    // Wall-clock: tomorrow (Tue 2026-05-05) 01:00 — assert via parsed components.
    const t = new Date(result.departures[0]!.scheduledTime);
    expect(t.getDate()).toBe(5);
    expect(t.getHours()).toBe(1);
    expect(t.getMinutes()).toBe(0);
  });

  it("does NOT include a service active only tomorrow when window stays inside today", () => {
    const tile: DecodedScheduleTile = {
      bundleHash: "deadbeef",
      cityId: "vilnius",
      tileSize: 12000,
      stringTable: ["T_TUE", "Downtown"],
      routes: [{ id: "R1", shortName: "1", longName: "Route One", mode: "BUS" }],
      // Tue (slot 1) only.
      calendar: [{
        serviceId: "SVC_TUE",
        days: [false, true, false, false, false, false, false],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      }],
      stops: {
        S1: {
          tripIxs: new Uint32Array([0]),
          departureSecs: new Uint32Array([8 * 3600]),
        },
      },
      trips: [{ tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 1 }],
    };
    // Mon 2026-05-04 07:00, lookAheadHours=1 → upperCutoff Mon 08:00, no tomorrow expansion.
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 1,
    });

    expect(result.serviceState).toBe("no_service_today");
    expect(result.departures).toEqual([]);
  });

  // ── Real-time merge ───────────────────────────────────────────────────────

  it("applies a date-scoped RT update (`tripId|YYYYMMDD` key) to predictedTime/delaySeconds", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);
    const rt = new Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }>([
      ["T1|20260504", { tripId: "T1", delaySeconds: 120, cancelled: false }],
    ]);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
      realtimeUpdates: rt,
    });

    expect(result.departures).toHaveLength(1);
    const dep = result.departures[0]!;
    expect(dep.delaySeconds).toBe(120);
    // 08:00 + 2 min = 08:02
    const predicted = new Date(dep.predictedTime!);
    expect(predicted.getHours()).toBe(8);
    expect(predicted.getMinutes()).toBe(2);
    expect(dep.cancelled).toBeUndefined(); // false collapses to undefined per legacy
  });

  it("drops a DELETED trip from the board — it must not be shown, not even as cancelled", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);
    const rt = new Map([["T1", { tripId: "T1", delaySeconds: 0, cancelled: false, deleted: true }]]);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
      realtimeUpdates: rt,
    });

    expect(result.departures).toHaveLength(0);
  });

  it("falls back to the bare-tripId RT key when the date-scoped key is absent", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);
    const rt = new Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }>([
      ["T1", { tripId: "T1", delaySeconds: -60, cancelled: false }],
    ]);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
      realtimeUpdates: rt,
    });

    expect(result.departures[0]!.delaySeconds).toBe(-60);
    // 08:00 - 1 min = 07:59
    const predicted = new Date(result.departures[0]!.predictedTime!);
    expect(predicted.getHours()).toBe(7);
    expect(predicted.getMinutes()).toBe(59);
  });

  it("omits predictedTime when delaySeconds is 0 (parity with legacy)", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);
    const rt = new Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }>([
      ["T1|20260504", { tripId: "T1", delaySeconds: 0, cancelled: false }],
    ]);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
      realtimeUpdates: rt,
    });

    expect(result.departures[0]!.delaySeconds).toBe(0);
    expect(result.departures[0]!.predictedTime).toBeUndefined();
  });

  it("cancelled=true with delaySeconds=0: emits both fields; predictedTime undefined", () => {
    // "Response carries both fields; client renders 'Cancelled' + no delay." This combined state
    // must survive on the wire — without an explicit assertion, future refactors can drop one of
    // the two fields and the user sees "0 minutes late" on a cancelled bus.
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);
    const rt = new Map([["T1|20260504", { tripId: "T1", delaySeconds: 0, cancelled: true }]]);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2, realtimeUpdates: rt,
    });

    expect(result.departures).toHaveLength(1);
    const dep = result.departures[0]!;
    expect(dep.cancelled).toBe(true);
    expect(dep.delaySeconds).toBe(0);
    expect(dep.predictedTime).toBeUndefined();
  });

  it("propagates cancelled=true; omits cancelled when false", () => {
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0);
    const rtTrue = new Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }>([
      ["T1|20260504", { tripId: "T1", delaySeconds: 0, cancelled: true }],
    ]);

    const r1 = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
      realtimeUpdates: rtTrue,
    });
    expect(r1.departures[0]!.cancelled).toBe(true);

    const rtFalse = new Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }>([
      ["T1|20260504", { tripId: "T1", delaySeconds: 0, cancelled: false }],
    ]);
    const r2 = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
      realtimeUpdates: rtFalse,
    });
    expect(r2.departures[0]!.cancelled).toBeUndefined();
  });

  it("date-scoped RT key wins over bare-tripId key when both are present", () => {
    // Both keys carry different `delaySeconds`. The date-scoped key is the
    // canonical update for this baseDate; the bare key is the legacy fallback.
    // Locks the precedence in place so a future "bare-key cache hit" refactor
    // can't silently invert it for operators broadcasting both.
    const tile = mkSingleTripTile({
      tripId: "T1",
      routeId: "R1",
      routeShortName: "1",
      mode: "BUS",
      headsign: "Downtown",
      serviceId: "SVC_DAILY",
      stopId: "S1",
      departureSec: 8 * 3600,
      activeDays: [true, true, true, true, true, true, true],
      routeColor: "#FF6600",
      longName: "Route One",
    });
    const now = new Date(2026, 4, 4, 7, 0, 0); // Mon 07:00
    const rt = new Map<string, { tripId: string; delaySeconds: number; cancelled: boolean }>([
      ["T1|20260504", { tripId: "T1", delaySeconds: 120, cancelled: false }],
      ["T1",          { tripId: "T1", delaySeconds: 999, cancelled: false }],
    ]);

    const result = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
      realtimeUpdates: rt,
    });

    expect(result.departures).toHaveLength(1);
    expect(result.departures[0]!.delaySeconds).toBe(120);
    // 08:00 + 2 min via the date-scoped delta, not 08:00 + 16:39 via the bare one.
    const predicted = new Date(result.departures[0]!.predictedTime!);
    expect(predicted.getHours()).toBe(8);
    expect(predicted.getMinutes()).toBe(2);
  });

  it("expands to four base dates when lookAheadHours=48 near end-of-day (yesterday + today + tomorrow + day-after)", () => {
    // Spec maximum lookAhead is 48h. From 23:00 Mon, +48h reaches 23:00 Wed,
    // so the expansion should produce: yesterday (Sun) + today (Mon) +
    // tomorrow (Tue) + day-after (Wed). One trip per day proves each base
    // date is scanned.
    const stringTable = ["T_SUN", "T_MON", "T_TUE", "T_WED", "Downtown"];
    const calendar: CalendarRow[] = [
      {
        serviceId: "SVC_DAILY",
        days: [true, true, true, true, true, true, true],
        startDate: "20260101",
        endDate: "20261231",
        added: [],
        removed: [],
      },
    ];
    const routes: RouteRow[] = [
      { id: "R1", shortName: "1", longName: "1", mode: "BUS" },
    ];
    // Each trip departs at 12:00 local on its own service date. With overnight
    // semantics (departureSec >= 86400) we'd need separate service-date
    // assignments — so use the four-trips-on-the-same-stop strategy where
    // each trip's wall-clock falls into a different base-date scan because
    // the consumer reframes lowerSecs/upperSecs per base date. All four
    // trips share `SVC_DAILY` and depart at 12:00 (43200s); the per-base-date
    // window check is what selects them.
    const trips: TileTripRow[] = [
      { tripIdIx: 0, routeIx: 0, serviceIx: 0, headsignIx: 4 },
      { tripIdIx: 1, routeIx: 0, serviceIx: 0, headsignIx: 4 },
      { tripIdIx: 2, routeIx: 0, serviceIx: 0, headsignIx: 4 },
      { tripIdIx: 3, routeIx: 0, serviceIx: 0, headsignIx: 4 },
    ];
    const tile: DecodedScheduleTile = {
      bundleHash: "deadbeef",
      cityId: "test",
      tileSize: 12000,
      stringTable,
      routes,
      calendar,
      // All four trips at S1 at 12:00 (single column entry per trip);
      // stop column is sorted so all four indices appear in order.
      stops: {
        S1: {
          tripIxs: new Uint32Array([0, 1, 2, 3]),
          departureSecs: new Uint32Array([
            12 * 3600,
            12 * 3600 + 1,
            12 * 3600 + 2,
            12 * 3600 + 3,
          ]),
        },
      },
      trips,
    };
    const now = new Date(2026, 4, 4, 23, 0, 0); // Mon 23:00, +48h → Wed 23:00

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 50, lookAheadHours: 48,
    });

    // Each base date scans the same column; today's 12:00 is 11h ago (excluded),
    // yesterday's 12:00 is 35h ago (excluded), but tomorrow's (Tue) 12:00 and
    // day-after's (Wed) 12:00 are inside the 48h window. With four entries
    // per base date and two valid base dates, expect 8 departures.
    expect(serviceState).toBe("active");
    expect(departures).toHaveLength(8);
    const dates = departures.map((d) => new Date(d.scheduledTime).getDate());
    // Sorted ascending by scheduledTime — Tue (5) entries come before Wed (6).
    expect(dates).toEqual([5, 5, 5, 5, 6, 6, 6, 6]);
  });

  it("returns no_service_today when stop entry exists but its departureSecs column is empty", () => {
    // Defensive: PR 2 generation should not emit empty columns, but if it
    // does, the consumer must not crash and must collapse to no_service_today
    // (the stop has no schedule at all, so no service is meaningfully active).
    const tile: DecodedScheduleTile = {
      bundleHash: "deadbeef",
      cityId: "test",
      tileSize: 12000,
      stringTable: [],
      routes: [],
      calendar: [],
      stops: {
        S1: {
          tripIxs: new Uint32Array([]),
          departureSecs: new Uint32Array([]),
        },
      },
      trips: [],
    };
    const now = new Date(2026, 4, 4, 7, 0, 0);

    const { departures, serviceState } = getDeparturesFromTile({
      tile, stopId: "S1", now, limit: 20, lookAheadHours: 2,
    });

    expect(serviceState).toBe("no_service_today");
    expect(departures).toEqual([]);
  });
});
