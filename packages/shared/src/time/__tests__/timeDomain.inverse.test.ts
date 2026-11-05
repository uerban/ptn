/**
 * Unit tests for the wall-clock inverse `unixToServiceDay`. The chrono-tz
 * differential cases live in the gated fixture (see timeDomain.test.ts); these
 * are local property + worked-example checks. The inverse reads the FEED-TZ
 * wall-clock H/M/S of an instant — it is NOT `unix - serviceDayToUnix(ymd,0,tz)`
 * (that is elapsed seconds and is off by the DST amount).
 */
import { describe, expect, it } from "vitest";
import { serviceDayToUnix, unixToServiceDay } from "../timeDomain.js";

describe("unixToServiceDay (wall-clock inverse)", () => {
  it("decomposes a winter-noon Vilnius instant into civil date + seconds", () => {
    // 2026-01-15 12:00 local Vilnius (+02:00) = 10:00:00 UTC.
    const unix = Date.UTC(2026, 0, 15, 10, 0, 0) / 1000;
    expect(unixToServiceDay(unix, "Europe/Vilnius")).toEqual({
      serviceDateYmd: 20260115,
      secsOfServiceDay: 12 * 3600,
    });
  });

  it("returns the civil date in the feed tz, not the device tz", () => {
    // 2026-01-15 23:30 local Vilnius (+02:00) = 21:30 UTC. A New-York device
    // would read 16:30 on the 15th, but the feed-tz decomposition is 23:30.
    const unix = Date.UTC(2026, 0, 15, 21, 30, 0) / 1000;
    expect(unixToServiceDay(unix, "Europe/Vilnius")).toEqual({
      serviceDateYmd: 20260115,
      secsOfServiceDay: 23 * 3600 + 30 * 60,
    });
  });

  it("round-trips with serviceDayToUnix outside a fall-back overlap", () => {
    // Property: for instants not inside a fall-back overlap, projecting the
    // decomposition reproduces the original instant.
    const instants = [
      Date.UTC(2026, 0, 15, 10, 0, 0) / 1000, // winter
      Date.UTC(2026, 6, 15, 9, 0, 0) / 1000, // summer
      Date.UTC(2026, 2, 29, 5, 0, 0) / 1000, // after spring-forward
    ];
    for (const t of instants) {
      const { serviceDateYmd, secsOfServiceDay } = unixToServiceDay(t, "Europe/Vilnius");
      expect(serviceDayToUnix(serviceDateYmd, secsOfServiceDay, "Europe/Vilnius")).toBe(t);
    }
  });

  it("secsOfServiceDay is always in [0, 86400) — it is a wall-clock decomposition", () => {
    // An instant that is a GTFS overnight (filed under the previous service day
    // as e.g. 25:30) decomposes to the CIVIL date it actually falls on at 01:30,
    // not to the previous day at 25:30. (The previous-day assignment needs trip
    // context; the inverse is the pure civil decomposition.)
    const unix = Date.UTC(2026, 0, 16, 0, 30, 0) / 1000; // 01:30 local Paris (+01:00)
    const r = unixToServiceDay(unix, "Europe/Paris");
    expect(r.serviceDateYmd).toBe(20260116);
    expect(r.secsOfServiceDay).toBe(1 * 3600 + 30 * 60);
    expect(r.secsOfServiceDay).toBeGreaterThanOrEqual(0);
    expect(r.secsOfServiceDay).toBeLessThan(86400);
  });

  it("fall-back overlap: the LATER occurrence does NOT round-trip (frozen policy) [R-fold BLOCKING #8]", () => {
    // Vilnius fall-back 2026-10-25: local 03:30 occurs twice — earlier (1792888200, +03:00) and
    // later (1792891800, +02:00). Both decompose to the same wall clock {20261025, 03:30};
    // projecting that back collapses to the EARLIER instant per the frozen policy. Codify the
    // non-round-trip so a future "fix" of the overlap policy fails loudly.
    const earlier = 1792888200;
    const later = 1792891800;
    expect(unixToServiceDay(later, "Europe/Vilnius")).toEqual(
      unixToServiceDay(earlier, "Europe/Vilnius"),
    );
    const decomp = unixToServiceDay(later, "Europe/Vilnius");
    expect(serviceDayToUnix(decomp.serviceDateYmd, decomp.secsOfServiceDay, "Europe/Vilnius")).toBe(earlier);
    // Display never round-trips a shown time back through the inverse, so this
    // collapse cannot corrupt display — it only documents the property.
  });
});

describe("gtfs-via-postgres worked examples (forward)", () => {
  // Cross-checks against gtfs-via-postgres's published `arrival_time_seconds`
  // → UTC conversion behaviour (the de-facto reference for GTFS time-domain
  // arithmetic over a DST transition). The expected unix values are computed
  // independently via `Date.UTC`, so this gates `serviceDayToUnix` against an
  // external oracle's worked examples, not just our own derivation.
  it("2021-03-28 + 03:01 Europe/Berlin → 01:01 UTC (spring-forward day)", () => {
    expect(serviceDayToUnix(20210328, 3 * 3600 + 1 * 60, "Europe/Berlin")).toBe(
      Date.UTC(2021, 2, 28, 1, 1, 0) / 1000,
    );
  });
  it("2021-03-01 + 26:59 Europe/Berlin → next-day 02:59 local = 01:59 UTC", () => {
    expect(serviceDayToUnix(20210301, 26 * 3600 + 59 * 60, "Europe/Berlin")).toBe(
      Date.UTC(2021, 2, 2, 1, 59, 0) / 1000,
    );
  });
});
