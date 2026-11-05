/**
 * GTFS service-day origin (local noon minus 12 elapsed hours). Expected values
 * are written as UTC instants worked out by hand, not read back from the
 * implementation, so the DST cases pin the GTFS definition itself.
 */
import { describe, expect, it } from "vitest";
import { serviceDayOriginUnix, unixToGtfsSecs, unixToServiceDate } from "../timeDomain.js";

const VILNIUS = "Europe/Vilnius";
const utc = (iso: string) => Date.parse(iso) / 1000;

describe("serviceDayOriginUnix", () => {
  it("is local noon minus 12 h on an ordinary winter date (= local midnight)", () => {
    // 2026-01-15 noon EET (UTC+2) is 10:00Z; minus 12 h = 22:00Z on the 14th.
    expect(serviceDayOriginUnix(20260115, VILNIUS)).toBe(utc("2026-01-14T22:00:00Z"));
  });

  it("is not local midnight on the spring-forward date", () => {
    // 2026-03-29 noon is already EEST (UTC+3) = 09:00Z; minus 12 h = 21:00Z on the 28th,
    // 23:00 EET, one hour before local midnight. Local midnight would be 22:00Z.
    expect(serviceDayOriginUnix(20260329, VILNIUS)).toBe(utc("2026-03-28T21:00:00Z"));
  });

  it("is local noon minus 12 h on the fall-back date", () => {
    // 2026-10-25 noon is EET (UTC+2) = 10:00Z; minus 12 h = 22:00Z on the 24th.
    expect(serviceDayOriginUnix(20261025, VILNIUS)).toBe(utc("2026-10-24T22:00:00Z"));
  });

  it("makes consecutive origins 23 h, 24 h and 25 h apart around the DST changes", () => {
    const d = (ymd: number) => serviceDayOriginUnix(ymd, VILNIUS);
    expect(d(20260329) - d(20260328)).toBe(23 * 3600);
    expect(d(20260330) - d(20260329)).toBe(24 * 3600);
    expect(d(20261025) - d(20261024)).toBe(25 * 3600);
  });
});

describe("unixToGtfsSecs", () => {
  it("reads a 07:00 GTFS Time on the spring-forward date as 07:00 wall clock", () => {
    // 07:00 EEST on 2026-03-29 is 04:00Z.
    const at = utc("2026-03-29T04:00:00Z");
    expect(unixToGtfsSecs(at, 20260329, VILNIUS)).toBe(7 * 3600);
  });

  it("reads an after-midnight instant in the previous date's frame as past 24:00", () => {
    // 00:30 EET on 2026-03-29 is 22:30Z on the 28th. In the 28th's frame it is
    // 24:30 (88200 s), which is what the previous service day's trips store.
    const at = utc("2026-03-28T22:30:00Z");
    expect(unixToGtfsSecs(at, 20260328, VILNIUS)).toBe(24 * 3600 + 1800);
  });
});

describe("unixToServiceDate", () => {
  it("is the civil date on an ordinary instant", () => {
    // 2026-01-15 12:00 EET.
    expect(unixToServiceDate(utc("2026-01-15T10:00:00Z"), VILNIUS)).toBe(20260115);
  });

  it("gives 23:00-24:00 on the spring-forward eve to the next service date", () => {
    // 2026-03-28 23:30 EET = 21:30Z. Civil date is the 28th, but the 29th's origin
    // is 23:00 EET on the 28th, so the engine files this instant under the 29th.
    expect(unixToServiceDate(utc("2026-03-28T21:30:00Z"), VILNIUS)).toBe(20260329);
    // Just before the 29th's origin (22:59 EET on the 28th) the 28th still holds.
    expect(unixToServiceDate(utc("2026-03-28T20:59:00Z"), VILNIUS)).toBe(20260328);
    // Same wall time one day earlier (the 27th) is an ordinary 27th instant.
    expect(unixToServiceDate(utc("2026-03-27T21:30:00Z"), VILNIUS)).toBe(20260327);
  });

  it("is the civil date of a just-after-midnight instant on the DST date itself", () => {
    expect(unixToServiceDate(utc("2026-03-28T22:30:00Z"), VILNIUS)).toBe(20260329);
  });
});
