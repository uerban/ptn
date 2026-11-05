/**
 * resolveActiveServices must resolve the FEED-TZ civil date + weekday when a
 * feedTz is supplied — a query near local midnight from a foreign device else
 * resolves the device's weekday and returns the wrong day's services.
 */
import { describe, expect, it } from "vitest";
import { resolveActiveServices } from "./serviceDay.ts";
import type { RaptorIndexService } from "./raptorIndex.ts";

function svc(days: boolean[]): RaptorIndexService {
  return { startDate: "20260101", endDate: "20261231", days, exceptions: {} } as RaptorIndexService;
}

describe("resolveActiveServices feed-tz resolution", () => {
  // 2026-01-16 is a Friday; 2026-01-15 is a Thursday (Mon-first idx: Fri=4, Thu=3).
  const friOnly = new Map([["fri", svc([false, false, false, false, true, false, false])]]);

  // The SAME instant resolves to a DIFFERENT feed-tz weekday depending on the tz argument — a
  // deterministic, runner-TZ-INDEPENDENT proof that `feedTz` actually drives the resolution (both
  // calls pass an explicit tz; neither reads the runner clock). If `feedTz` were ignored, both
  // would return the device-local answer and this contrast would collapse — that is the real
  // fail-red. (The process-TZ-sensitive cross-tz path is additionally gated in the __tz_tests__
  // suite under TZ=America/New_York;.)
  it("the feed tz argument drives the resolved service day (not the device clock)", () => {
    // 2026-01-15 22:30 UTC. In Vilnius (+02:00) that is 2026-01-16 00:30 → FRIDAY,
    // so Friday-only service IS active. In New York (−05:00) it is 2026-01-15
    // 17:30 → THURSDAY, so Friday-only service is NOT active.
    const instant = new Date(Date.UTC(2026, 0, 15, 22, 30, 0));
    expect(resolveActiveServices(friOnly, instant, "Europe/Vilnius").has("fri")).toBe(true);
    expect(resolveActiveServices(friOnly, instant, "America/New_York").has("fri")).toBe(false);
  });

  it("without feedTz, falls back to device-local (unchanged legacy behavior)", () => {
    // Device-local interpretation depends on the runner TZ; assert only that the
    // legacy 2-arg call shape still works and returns a Set. (The device-vs-feed
    // contrast is exercised deterministically above and in the __tz_tests__ suite.)
    const instant = new Date(Date.UTC(2026, 0, 16, 12, 0, 0));
    const active = resolveActiveServices(friOnly, instant);
    expect(active instanceof Set).toBe(true);
  });
});
