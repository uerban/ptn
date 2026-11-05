import { describe, it, expect } from "vitest";
import { isDayActive } from "@pt/shared";
import { buildServiceBitmasks } from "./ServiceBitmaskBuilder.js";
import type { GtfsService, GtfsCalendarDate } from "../parser.js";

function day(iso: string): GtfsCalendarDate {
  const parsed = /^([^:]+):(\d{8}):(added|removed)$/.exec(iso);
  if (!parsed) throw new Error(`bad day() input: ${iso}`);
  const [, svc, date, type] = parsed;
  return { serviceId: svc!, date: date!, exceptionType: type === "added" ? 1 : 2 };
}

const svc = (
  id: string,
  mon: number,
  tue: number,
  wed: number,
  thu: number,
  fri: number,
  sat: number,
  sun: number,
  startIso: string,
  endIso: string,
): GtfsService => ({
  serviceId: id,
  monday: mon === 1,
  tuesday: tue === 1,
  wednesday: wed === 1,
  thursday: thu === 1,
  friday: fri === 1,
  saturday: sat === 1,
  sunday: sun === 1,
  startDate: startIso,
  endDate: endIso,
});

describe("buildServiceBitmasks — calendar-only", () => {
  it("covers every day inside the calendar window", () => {
    const result = buildServiceBitmasks({
      services: [svc("weekday", 1, 1, 1, 1, 1, 0, 0, "20260420", "20260424")],
      exceptions: [],
      startDateIso: "2026-04-20",
      horizonDays: 14,
    });
    const m = result.get("weekday")!;
    for (const d of [0, 1, 2, 3, 4]) expect(isDayActive(m, d)).toBe(true);
    expect(isDayActive(m, 5)).toBe(false);
    expect(isDayActive(m, 6)).toBe(false);
    expect(isDayActive(m, 7)).toBe(false);
  });

  it("service with zero day-of-week flags is never active", () => {
    const result = buildServiceBitmasks({
      services: [svc("dead", 0, 0, 0, 0, 0, 0, 0, "20260420", "20261231")],
      exceptions: [],
      startDateIso: "2026-04-20",
      horizonDays: 14,
    });
    const m = result.get("dead")!;
    for (let d = 0; d < 14; d++) expect(isDayActive(m, d)).toBe(false);
  });
});

describe("buildServiceBitmasks — calendar_dates-only", () => {
  it("service with no calendar row is active only on added dates", () => {
    const result = buildServiceBitmasks({
      services: [],
      exceptions: [
        day("holiday:20260421:added"),
        day("holiday:20260424:added"),
      ],
      startDateIso: "2026-04-20",
      horizonDays: 10,
    });
    const m = result.get("holiday")!;
    expect(isDayActive(m, 0)).toBe(false);
    expect(isDayActive(m, 1)).toBe(true);
    expect(isDayActive(m, 4)).toBe(true);
    expect(isDayActive(m, 5)).toBe(false);
  });
});

describe("buildServiceBitmasks — calendar + calendar_dates combined", () => {
  it("applies removals on top of calendar window (Vilnius pattern)", () => {
    const result = buildServiceBitmasks({
      services: [svc("weekday", 1, 1, 1, 1, 1, 0, 0, "20260420", "20260430")],
      exceptions: [day("weekday:20260421:removed")],
      startDateIso: "2026-04-20",
      horizonDays: 14,
    });
    const m = result.get("weekday")!;
    expect(isDayActive(m, 0)).toBe(true);
    expect(isDayActive(m, 1)).toBe(false);
    expect(isDayActive(m, 2)).toBe(true);
  });

  it("applies additions on top of calendar window", () => {
    const result = buildServiceBitmasks({
      services: [svc("weekday", 1, 1, 1, 1, 1, 0, 0, "20260420", "20260430")],
      exceptions: [day("weekday:20260425:added")],
      startDateIso: "2026-04-20",
      horizonDays: 14,
    });
    const m = result.get("weekday")!;
    expect(isDayActive(m, 5)).toBe(true);
    expect(isDayActive(m, 6)).toBe(false);
  });
});

describe("buildServiceBitmasks — horizon edges", () => {
  it("day 0 and day horizon-1 are both representable", () => {
    const result = buildServiceBitmasks({
      services: [svc("always", 1, 1, 1, 1, 1, 1, 1, "20260420", "20270101")],
      exceptions: [],
      startDateIso: "2026-04-20",
      horizonDays: 90,
    });
    const m = result.get("always")!;
    expect(isDayActive(m, 0)).toBe(true);
    expect(isDayActive(m, 89)).toBe(true);
  });

  it("horizonDays determines output length", () => {
    const result = buildServiceBitmasks({
      services: [svc("s", 1, 1, 1, 1, 1, 1, 1, "20260420", "20261231")],
      exceptions: [],
      startDateIso: "2026-04-20",
      horizonDays: 30,
    });
    const m = result.get("s")!;
    expect(m.horizonDays).toBe(30);
    expect(m.bits.byteLength).toBe(Math.ceil(30 / 8));
  });
});

describe("buildServiceBitmasks — bitmask math", () => {
  it("calendar + added - removed round-trips for fixed inputs", () => {
    const svcRow = svc("r", 1, 0, 1, 0, 1, 0, 0, "20260420", "20260510");
    const exceptions: GtfsCalendarDate[] = [
      day("r:20260420:removed"),
      day("r:20260421:added"),
    ];
    const result = buildServiceBitmasks({
      services: [svcRow],
      exceptions,
      startDateIso: "2026-04-20",
      horizonDays: 10,
    });
    const m = result.get("r")!;
    expect(isDayActive(m, 0)).toBe(false);
    expect(isDayActive(m, 1)).toBe(true);
    expect(isDayActive(m, 2)).toBe(true);
    expect(isDayActive(m, 3)).toBe(false);
    expect(isDayActive(m, 4)).toBe(true);
  });
});
