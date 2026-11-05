import { describe, expect, it } from "vitest";
import { serviceDayFrame } from "./serviceDayFrame.ts";
import { resolveActivityWindow } from "./hasUpcomingDeparture.ts";

const VILNIUS = "Europe/Vilnius";
const utc = (iso: string) => Date.parse(iso) / 1000;

describe("serviceDayFrame", () => {
  it("reads now in the GTFS frame of an ordinary date (= seconds since local midnight)", () => {
    // 2026-01-15 12:00 EET = 10:00Z.
    const f = serviceDayFrame(utc("2026-01-15T10:00:00Z"), VILNIUS);
    expect(f.todayYmd).toBe("20260115");
    expect(f.nowSecs).toBe(12 * 3600);
    expect(f.yesterdayYmd).toBe("20260114");
    expect(f.yesterdayShiftSecs).toBe(86400);
  });

  it("reads 00:30 on the spring-forward date as GTFS 01:30, not the wall clock 00:30", () => {
    // 2026-03-29 00:30 EET = 2026-03-28T22:30Z. The wall clock says 1800 s; the
    // GTFS frame of the 29th is 5400 s because its origin is an hour earlier.
    const f = serviceDayFrame(utc("2026-03-28T22:30:00Z"), VILNIUS);
    expect(f.todayYmd).toBe("20260329");
    expect(f.nowSecs).toBe(5400);
    expect(f.yesterdayYmd).toBe("20260328");
    // Yesterday's origin is 23 h before today's, so yesterday's frame is 82800 s behind.
    expect(f.yesterdayShiftSecs).toBe(82800);
  });

  it("uses the device zone when no feed zone is given", () => {
    const f = serviceDayFrame(utc("2026-01-15T10:00:00Z"));
    expect(f.todayYmd).toMatch(/^\d{8}$/);
    expect(f.nowSecs).toBeGreaterThanOrEqual(0);
    expect(f.yesterdayShiftSecs).toBeGreaterThanOrEqual(82800);
  });
});

describe("resolveActivityWindow on a DST date", () => {
  it("opens the departure window on the GTFS frame, not the wall clock", () => {
    // 00:30 EET on the spring-forward date: GTFS 01:30 (5400 s), so a 2 h lookahead
    // ends at 12600 s. The wall-clock reading would have closed it an hour early.
    const w = resolveActivityWindow(
      new Date(utc("2026-03-28T22:30:00Z") * 1000),
      2,
      { services: new Map() } as never,
      VILNIUS,
    );
    expect(w.nowSecs).toBe(5400);
    expect(w.windowEndSecs).toBe(5400 + 2 * 3600);
    expect(w.yesterdayShiftSecs).toBe(82800);
  });
});
