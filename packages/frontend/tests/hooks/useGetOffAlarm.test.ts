import { describe, it, expect } from "vitest";
import { computeAlarmLevel } from "../../src/hooks/useGetOffAlarm.ts";
import type { GuidancePhase } from "@pt/shared";

describe("computeAlarmLevel", () => {
  it("returns null when disabled", () => {
    expect(computeAlarmLevel(1, "navigating", false)).toBeNull();
  });

  it("returns null when phase is idle", () => {
    expect(computeAlarmLevel(1, "idle", true)).toBeNull();
  });

  it("returns null when phase is riderMode", () => {
    expect(computeAlarmLevel(1, "riderMode", true)).toBeNull();
  });

  it("returns null when stopsRemaining is null", () => {
    expect(computeAlarmLevel(null, "navigating", true)).toBeNull();
  });

  it('returns "next" when stopsRemaining is 1', () => {
    expect(computeAlarmLevel(1, "navigating", true)).toBe("next");
  });

  it('returns "arrived" when stopsRemaining is 0', () => {
    expect(computeAlarmLevel(0, "navigating", true)).toBe("arrived");
  });

  it("returns null when stopsRemaining is > 1", () => {
    expect(computeAlarmLevel(2, "navigating", true)).toBeNull();
    expect(computeAlarmLevel(5, "navigating", true)).toBeNull();
  });

  it("returns null for large stopsRemaining values", () => {
    expect(computeAlarmLevel(10, "navigating", true)).toBeNull();
    expect(computeAlarmLevel(100, "navigating", true)).toBeNull();
  });

  it("correctly differentiates all phases", () => {
    const phases: GuidancePhase[] = ["idle", "navigating", "riderMode"];
    const results = phases.map((p) => computeAlarmLevel(1, p, true));
    expect(results).toEqual([null, "next", null]);
  });
});
