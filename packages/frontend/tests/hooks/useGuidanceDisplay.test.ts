import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Itinerary } from "@pt/shared";
import { useGuidanceDisplay } from "../../src/hooks/useGuidanceDisplay.ts";
import { useGuidanceStore } from "../../src/stores/guidanceStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { place, ride, walk, itinerary as build, ms } from "../components/shared-fixtures.ts";

// 4-min walk to a 17:41 bus; the itinerary already carries a 60 s RT delay.
const bus = { ...ride({ from: place("Stop"), to: place("Airport"), depart: "2026-09-25T17:41:00Z", arrive: "2026-09-25T18:21:00Z", routeShortName: "3G" }), tripId: "t3g", appliedDelaySeconds: 60 };
const trip: Itinerary = build([
  walk({ from: place("Home"), to: place("Stop"), depart: "2026-09-25T17:30:00Z", arrive: "2026-09-25T17:34:00Z" }),
  bus,
]);

function navigate(legIndex = 0) {
  useGuidanceStore.setState({
    phase: "navigating",
    itinerary: trip,
    currentLegIndex: legIndex,
    legStatuses: trip.legs.map((_, i) => (i === legIndex ? "current" : i < legIndex ? "completed" : "future")),
    walkingProgress: null,
    transitProgress: null,
  });
}

describe("useGuidanceDisplay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T17:30:00Z"));
    useSettingsStore.setState({ mobilityProfile: "default", leaveBufferOverrideSeconds: null, runToCatch: false } as never);
    useRtStore.setState({ updates: new Map() });
    navigate();
  });

  afterEach(() => {
    useGuidanceStore.getState().reset();
    useRtStore.setState({ updates: new Map() });
    vi.useRealTimers();
  });

  it("derives the plan at the current time", () => {
    const { result } = renderHook(() => useGuidanceDisplay());
    expect(result.current.display?.recommendedDepartureMs).toBe(ms("2026-09-25T17:34:00Z"));
    expect(result.current.display?.catchStatus).toBe("on-time");
  });

  it("follows the clock: at 17:38, still at home, the walk no longer fits", () => {
    const { result } = renderHook(() => useGuidanceDisplay());
    act(() => {
      vi.advanceTimersByTime(8 * 60_000);
    });
    expect(result.current.referenceNowMs).toBe(ms("2026-09-25T17:38:00Z"));
    expect(result.current.display?.catchStatus).toBe("likely-miss");
  });

  it("counts only the walk still ahead once the rider is on the way", () => {
    const { result } = renderHook(() => useGuidanceDisplay());
    act(() => {
      useGuidanceStore.setState({
        walkingProgress: { distanceRemainingMeters: 150, estimatedSecondsRemaining: 120, bearingDegrees: 0, remainingFraction: 0.5 },
      });
      vi.advanceTimersByTime(8 * 60_000);
    });
    // 17:38 with 2 min left to walk to a 17:41 bus.
    expect(result.current.display?.catchStatus).toBe("on-time");
  });

  it("moves the first departure by the live delay beyond what the plan already had", () => {
    const { result } = renderHook(() => useGuidanceDisplay());
    act(() => {
      // Live: 2 min early. The plan had +1 min folded in: the bus moves 3 min.
      useRtStore.setState({
        updates: new Map([["r3g", [{ tripId: "t3g", delaySeconds: -120, cancelled: false }]]]),
      });
    });
    expect(result.current.display?.firstTransitDepartureMs).toBe(ms("2026-09-25T17:38:00Z"));
    expect(result.current.display?.recommendedDepartureMs).toBe(ms("2026-09-25T17:31:00Z"));
  });

  it("reports a live cancellation of the first ride", () => {
    const { result } = renderHook(() => useGuidanceDisplay());
    act(() => {
      useRtStore.setState({
        updates: new Map([["r3g", [{ tripId: "t3g", delaySeconds: 0, cancelled: true }]]]),
      });
    });
    expect(result.current.display?.catchStatus).toBe("cancelled");
  });

  it("reports a live deletion of the first ride as removed", () => {
    const { result } = renderHook(() => useGuidanceDisplay());
    act(() => {
      useRtStore.setState({
        updates: new Map([["r3g", [{ tripId: "t3g", delaySeconds: 0, cancelled: false, deleted: true }]]]),
      });
    });
    expect(result.current.display?.catchStatus).toBe("removed");
  });
});
