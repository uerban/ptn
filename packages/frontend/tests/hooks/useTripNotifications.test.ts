import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { Itinerary } from "@pt/shared";
import { useTripNotifications } from "../../src/hooks/useTripNotifications.ts";
import { useGuidanceStore } from "../../src/stores/guidanceStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { notifyIfBackground } from "../../src/services/tripNotifications.ts";

vi.mock("../../src/services/tripNotifications.ts", () => ({
  notifyIfBackground: vi.fn(() => true),
  requestNotificationPermission: vi.fn(async () => true),
}));

const trip: Itinerary = {
  legs: [
    {
      mode: "BUS",
      from: { name: "Oro uostas", stopId: "s1", location: { lat: 54.68, lon: 25.25 } },
      to: { name: "Stotis", stopId: "s9", location: { lat: 54.67, lon: 25.28 } },
      departureTime: "2026-09-25T17:41:00Z",
      arrivalTime: "2026-09-25T18:05:00Z",
      durationSeconds: 1440,
      routeShortName: "3G",
      tripId: "t3g",
    },
  ],
  departureTime: "2026-09-25T17:41:00Z",
  arrivalTime: "2026-09-25T18:05:00Z",
  durationSeconds: 1440,
  transfers: 0,
  walkingDistanceMeters: 0,
};

/** Guidance on `trip`, without startNavigation's RT subscription (which polls the network). */
function navigate() {
  useGuidanceStore.setState({
    phase: "navigating",
    itinerary: trip,
    currentLegIndex: 0,
    legStatuses: ["current"],
    walkingProgress: null,
    transitProgress: null,
  });
}

const arrivedCalls = () =>
  vi.mocked(notifyIfBackground).mock.calls.filter(([title]) => title === "You've arrived");

describe("useTripNotifications — arrival", () => {
  beforeEach(() => {
    vi.mocked(notifyIfBackground).mockClear();
    useSettingsStore.setState({ tripNotificationsEnabled: true } as never);
    navigate();
  });

  afterEach(() => {
    cleanup();
    useGuidanceStore.getState().reset();
  });

  it("tells the rider they have arrived when the last leg completes", () => {
    renderHook(() => useTripNotifications());
    act(() => {
      useGuidanceStore.getState().advanceLeg();
    });
    expect(arrivedCalls()).toEqual([["You've arrived", "You've arrived at Stotis"]]);
  });

  it("does not announce an old arrival when notifications are enabled during a new trip", () => {
    useSettingsStore.setState({ tripNotificationsEnabled: false });
    renderHook(() => useTripNotifications());
    act(() => useGuidanceStore.getState().advanceLeg());
    expect(useGuidanceStore.getState().completedItinerary).toBe(trip);
    act(() => useGuidanceStore.getState().startNavigation(trip));
    act(() => useSettingsStore.setState({ tripNotificationsEnabled: true }));
    expect(arrivedCalls()).toEqual([]);
    act(() => useGuidanceStore.getState().advanceLeg());
    expect(arrivedCalls()).toEqual([["You've arrived", "You've arrived at Stotis"]]);
  });

  it("announces completion each time the same itinerary is navigated", () => {
    renderHook(() => useTripNotifications());
    act(() => useGuidanceStore.getState().advanceLeg());
    expect(arrivedCalls()).toHaveLength(1);
    act(() => useGuidanceStore.getState().startNavigation(trip));
    act(() => useGuidanceStore.getState().advanceLeg());
    expect(arrivedCalls()).toEqual([
      ["You've arrived", "You've arrived at Stotis"],
      ["You've arrived", "You've arrived at Stotis"],
    ]);
  });

  it("does not repeat an arrival when notification settings toggle after completion", () => {
    renderHook(() => useTripNotifications());
    act(() => useGuidanceStore.getState().advanceLeg());
    act(() => useSettingsStore.setState({ tripNotificationsEnabled: false }));
    act(() => useSettingsStore.setState({ tripNotificationsEnabled: true }));
    expect(arrivedCalls()).toEqual([["You've arrived", "You've arrived at Stotis"]]);
  });

  it("says nothing of arriving when the rider stops navigation", () => {
    renderHook(() => useTripNotifications());
    act(() => {
      useGuidanceStore.getState().stopNavigation();
    });
    expect(arrivedCalls()).toEqual([]);
  });
});
