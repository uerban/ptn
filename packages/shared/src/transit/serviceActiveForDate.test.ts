import { describe, it, expect } from "vitest";
import { serviceActiveForDate } from "./serviceActiveForDate.js";
import type { CalendarRow } from "../types/scheduleTile.js";

const weekdaysOnly: CalendarRow = {
  serviceId: "svc_weekdays",
  // [mon, tue, wed, thu, fri, sat, sun]
  days: [true, true, true, true, true, false, false],
  startDate: "20260101",
  endDate: "20261231",
  added: [],
  removed: [],
};

const weekendsOnly: CalendarRow = {
  serviceId: "svc_weekends",
  days: [false, false, false, false, false, true, true],
  startDate: "20260101",
  endDate: "20261231",
  added: [],
  removed: [],
};

const withExceptions: CalendarRow = {
  serviceId: "svc_with_ex",
  days: [true, true, true, true, true, false, false], // weekdays
  startDate: "20260101",
  endDate: "20261231",
  added: ["20260704"],   // Sat 2026-07-04: forced ON
  removed: ["20260106"], // Mon 2026-01-06: forced OFF
};

const expiredService: CalendarRow = {
  serviceId: "svc_expired",
  days: [true, true, true, true, true, true, true],
  startDate: "20260101",
  endDate: "20260131",
  added: [],
  removed: [],
};

describe("serviceActiveForDate", () => {
  it("returns true on a weekday inside the window for a weekdays-only service", () => {
    // 2026-05-04 is a Monday
    expect(serviceActiveForDate("20260504", weekdaysOnly)).toBe(true);
  });

  it("returns false on a Saturday for a weekdays-only service", () => {
    // 2026-05-02 is a Saturday
    expect(serviceActiveForDate("20260502", weekdaysOnly)).toBe(false);
  });

  it("returns true on a Sunday for a weekends-only service", () => {
    // 2026-05-03 is a Sunday — verifies (getDay()+6)%7 puts Sun in slot 6
    expect(serviceActiveForDate("20260503", weekendsOnly)).toBe(true);
  });

  it("returns true exactly on startDate", () => {
    // 2026-01-01 is a Thursday — inside `weekdaysOnly`
    expect(serviceActiveForDate("20260101", weekdaysOnly)).toBe(true);
  });

  it("returns true exactly on endDate", () => {
    // 2026-12-31 is a Thursday — inside `weekdaysOnly`
    expect(serviceActiveForDate("20261231", weekdaysOnly)).toBe(true);
  });

  it("returns false the day before startDate", () => {
    expect(serviceActiveForDate("20251231", weekdaysOnly)).toBe(false);
  });

  it("returns false the day after endDate", () => {
    expect(serviceActiveForDate("20270101", weekdaysOnly)).toBe(false);
  });

  it("`added` exception forces ON even when day-of-week is excluded", () => {
    // 2026-07-04 is a Saturday — withExceptions.days[5] is false, but `added` overrides.
    expect(serviceActiveForDate("20260704", withExceptions)).toBe(true);
  });

  it("`removed` exception forces OFF even when day-of-week is included", () => {
    // 2026-01-06 is a Tuesday — withExceptions.days[1] is true, but `removed` overrides.
    expect(serviceActiveForDate("20260106", withExceptions)).toBe(false);
  });

  it("`added` exception works outside the date window", () => {
    const svc: CalendarRow = {
      serviceId: "svc",
      days: [false, false, false, false, false, false, false],
      startDate: "20260201",
      endDate: "20260228",
      added: ["20260301"], // outside [20260201, 20260228]
      removed: [],
    };
    expect(serviceActiveForDate("20260301", svc)).toBe(true);
  });

  it("returns false outside the window when no exceptions match", () => {
    expect(serviceActiveForDate("20260601", expiredService)).toBe(false);
  });

  it("`added` takes precedence over `removed` when both list the same date (defensive)", () => {
    // GTFS feeds should not contain conflicting entries, but be defensive.
    const svc: CalendarRow = {
      serviceId: "svc",
      days: [false, false, false, false, false, false, false],
      startDate: "20260101",
      endDate: "20261231",
      added: ["20260504"],
      removed: ["20260504"],
    };
    expect(serviceActiveForDate("20260504", svc)).toBe(true);
  });
});
