/**
 * Cross-TZ correctness for `buildTripTimeline`'s lasso occurrence choice.
 *
 * A lasso trip passes the boarding stop twice
 * (https://gtfs.org/documentation/schedule/schedule-best-practices/#lasso-routes);
 * the occurrence is the one whose `departureSecs % 86400` equals the
 * departure's time of day READ IN THE CITY ZONE (`unixToServiceDay`). A
 * device-local reading (`getHours()`) would match nothing under
 * TZ=America/New_York and silently fall back to the first occurrence. `test:tz`
 * runs this twice — TZ=America/New_York (cross-tz) and TZ=Europe/Vilnius (the
 * local-user gate) — and BOTH runs assert the same hard-coded indices and ISO
 * instants.
 *
 * NOTE: `*.spec.ts` under `src/__tz_tests__/` so the base `vitest.config.ts`
 * `exclude` keeps it OUT of the default UTC `pnpm test`; only
 * `vitest.tz.config.ts` collects it.
 */
import { describe, expect, it } from "vitest";
import { buildTripTimeline, type TripTimeline } from "../services/tripTimeline.ts";
import type { RaptorIndex, RaptorIndexRoute } from "../services/raptorIndex.ts";

const VILNIUS = "Europe/Vilnius"; // June 2026 = EEST, UTC+3
const DEVICE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isLocal = DEVICE === VILNIUS;

function lasso(id: string, stopIds: string[], tripId: string, departureSecs: number[]): Pick<RaptorIndex, "patterns"> {
  const p: RaptorIndexRoute = {
    id,
    shortName: id,
    mode: "BUS",
    stopIds,
    trips: [{ tripId, serviceId: "ALL", headsign: "Loop", departureSecs }],
  };
  return { patterns: [p] };
}

// T 08:00 → X 08:05 → S 08:10 → L1 08:15 → L2 08:20 → S 08:25 → X 08:30 → T 08:35.
const DAY = lasso(
  "9",
  ["T", "X", "S", "L1", "L2", "S", "X", "T"],
  "day",
  [28800, 29100, 29400, 29700, 30000, 30300, 30600, 30900],
);

// Night lasso on service day 2026-06-15: T 24:30 → S 24:40 → L1 24:55 → S 25:10 → T 25:20.
const NIGHT = lasso("N9", ["T", "S", "L1", "S", "T"], "night", [88200, 88800, 89700, 90600, 91200]);

function times(timeline: TripTimeline | null): string[] {
  return (timeline?.stops ?? []).map((s) => s.scheduled.toISOString());
}

it("harness runs under a non-UTC zone", () => {
  expect(DEVICE).not.toBe("UTC");
  expect(new Date().getTimezoneOffset()).not.toBe(0);
});

describe("buildTripTimeline — city-TZ lasso occurrence (device-independent)", () => {
  it("picks the second pass of S by the Vilnius time of day", () => {
    const timeline = buildTripTimeline(DAY, {
      tripId: "day",
      stopId: "S",
      scheduledTime: "2026-06-15T05:25:00.000Z", // 08:25 Vilnius
      tz: VILNIUS,
      stopNames: new Map(),
    });
    expect(timeline?.boardingIndex).toBe(5);
    expect(times(timeline)).toEqual([
      "2026-06-15T05:00:00.000Z",
      "2026-06-15T05:05:00.000Z",
      "2026-06-15T05:10:00.000Z",
      "2026-06-15T05:15:00.000Z",
      "2026-06-15T05:20:00.000Z",
      "2026-06-15T05:25:00.000Z",
      "2026-06-15T05:30:00.000Z",
      "2026-06-15T05:35:00.000Z",
    ]);
  });

  it("picks the 25:10 pass of a night lasso and projects it across midnight", () => {
    const timeline = buildTripTimeline(NIGHT, {
      tripId: "night",
      stopId: "S",
      scheduledTime: "2026-06-15T22:10:00.000Z", // 2026-06-16 01:10 Vilnius = 25:10
      tz: VILNIUS,
      stopNames: new Map(),
    });
    expect(timeline?.boardingIndex).toBe(3);
    expect(times(timeline)).toEqual([
      "2026-06-15T21:30:00.000Z",
      "2026-06-15T21:40:00.000Z",
      "2026-06-15T21:55:00.000Z",
      "2026-06-15T22:10:00.000Z",
      "2026-06-15T22:20:00.000Z",
    ]);
  });
});

// Meaningful ONLY when device tz != feed tz: the device-local time of day of
// the same instants matches neither pass, so a getHours() reading would fall
// back to the first occurrence.
describe.skipIf(isLocal)("cross-tz fail-red (device != feed)", () => {
  function deviceSecsOfDay(iso: string): number {
    const d = new Date(iso);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  }

  it("the device-local time of day matches no pass of S", () => {
    expect([29400, 30300]).not.toContain(deviceSecsOfDay("2026-06-15T05:25:00.000Z"));
    expect([88800 % 86400, 90600 % 86400]).not.toContain(deviceSecsOfDay("2026-06-15T22:10:00.000Z"));
  });
});
