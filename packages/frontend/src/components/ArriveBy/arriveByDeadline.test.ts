import { describe, expect, it } from "vitest";
import type { Itinerary } from "@pt/shared";
import { defaultDeadlineMs, fromCityWallClock, toCityWallClock } from "./arriveByDeadline.ts";

const TZ = "Europe/Vilnius";
const page = (...arrivals: string[]): Itinerary[] => arrivals.map((arrivalTime) => ({
  legs: [], departureTime: arrivalTime, arrivalTime, durationSeconds: 0, transfers: 0, walkingDistanceMeters: 0,
}));

describe("defaultDeadlineMs", () => {
  it("takes the earliest arrival of the page, rounded up to a minute", () => {
    expect(defaultDeadlineMs(page("2026-10-12T07:20:10Z", "2026-10-12T07:12:01Z"), 0, TZ))
      .toBe(Date.parse("2026-10-12T07:13:00Z"));
    expect(defaultDeadlineMs(page("2026-10-12T07:12:00Z"), 0, TZ)).toBe(Date.parse("2026-10-12T07:12:00Z"));
  });
  it("without a result uses now plus one hour, rounded up to five minutes", () => {
    const now = Date.parse("2026-10-12T09:07:30+03:00");
    expect(defaultDeadlineMs([], now, TZ)).toBe(Date.parse("2026-10-12T10:10:00+03:00"));
    expect(defaultDeadlineMs([], Date.parse("2026-10-12T09:05:00+03:00"), TZ)).toBe(Date.parse("2026-10-12T10:05:00+03:00"));
  });
  it("rounds in city time across midnight", () => {
    expect(defaultDeadlineMs([], Date.parse("2026-10-12T22:57:00+03:00"), TZ)).toBe(Date.parse("2026-10-13T00:00:00+03:00"));
  });
});

describe("city wall clock", () => {
  it("reads and writes the city's zone, not the device's", () => {
    const ms = Date.parse("2026-10-12T10:00:00+03:00");
    expect(toCityWallClock(ms, TZ)).toEqual({ date: "2026-10-12", time: "10:00" });
    expect(fromCityWallClock("2026-10-12", "10:00", TZ)).toBe(ms);
    expect(toCityWallClock(ms, "UTC")).toEqual({ date: "2026-10-12", time: "07:00" });
  });
  it("follows the offset on each side of a DST change", () => {
    expect(fromCityWallClock("2026-10-25", "02:30", TZ)).toBe(Date.parse("2026-10-25T02:30:00+03:00"));
    expect(fromCityWallClock("2026-10-25", "05:00", TZ)).toBe(Date.parse("2026-10-25T05:00:00+02:00"));
  });
  it("is null while an input is incomplete", () => {
    expect(fromCityWallClock("", "10:00", TZ)).toBeNull();
    expect(fromCityWallClock("2026-10-12", "", TZ)).toBeNull();
    expect(fromCityWallClock("2026-10-12", "24:00", TZ)).toBeNull();
  });
});
