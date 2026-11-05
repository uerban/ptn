import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
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
    useGuidanceStore.getState().reset();
  });

  it("tells the rider they have arrived when the last leg completes", () => {
    renderHook(() => useTripNotifications());
    act(() => {
      useGuidanceStore.getState().advanceLeg();
    });
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
