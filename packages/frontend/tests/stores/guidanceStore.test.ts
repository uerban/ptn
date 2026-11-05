import { describe, it, expect, beforeEach, vi } from "vitest";
import { useGuidanceStore } from "../../src/stores/guidanceStore.ts";
import { useRtStore } from "../../src/stores/rtStore.ts";
import type { Itinerary } from "@pt/shared";
import { parkRtPolling } from "../helpers/parkRtPolling.ts";

const mockItinerary: Itinerary = {
  legs: [
    {
      mode: "WALK",
      from: { name: "Origin", location: { lat: 54.35, lon: 18.64 } },
      to: { name: "Stop A", location: { lat: 54.36, lon: 18.65 } },
      departureTime: "2026-03-28T10:00:00Z",
      arrivalTime: "2026-03-28T10:05:00Z",
      durationSeconds: 300,
      distanceMeters: 400,
      polyline: "_p~iF~ps|U",
    },
    {
      mode: "TRAM",
      from: { name: "Stop A", stopId: "s1", location: { lat: 54.36, lon: 18.65 } },
      to: { name: "Stop B", stopId: "s2", location: { lat: 54.37, lon: 18.66 } },
      departureTime: "2026-03-28T10:08:00Z",
      arrivalTime: "2026-03-28T10:20:00Z",
      durationSeconds: 720,
      routeShortName: "2",
      tripId: "trip_1",
      headsign: "Central Station",
      intermediateStops: 3,
      polyline: "_p~iF~ps|U_ulLnnqC",
    },
    {
      mode: "WALK",
      from: { name: "Stop B", location: { lat: 54.37, lon: 18.66 } },
      to: { name: "Destination", location: { lat: 54.38, lon: 18.67 } },
      departureTime: "2026-03-28T10:20:00Z",
      arrivalTime: "2026-03-28T10:25:00Z",
      durationSeconds: 300,
      distanceMeters: 350,
      polyline: "_p~iF~ps|U",
    },
  ],
  departureTime: "2026-03-28T10:00:00Z",
  arrivalTime: "2026-03-28T10:25:00Z",
  durationSeconds: 1500,
  transfers: 1,
  walkingDistanceMeters: 750,
};

describe("guidanceStore", () => {
  beforeEach(() => {
    useGuidanceStore.getState().reset();
    parkRtPolling();
  });

  it("starts in idle phase", () => {
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.itinerary).toBeNull();
  });

  it("subscribes live data by route — the RT endpoint is per route, not per trip", () => {
    const subscribeRoutes = vi.fn();
    const real = useRtStore.getState().subscribeRoutes;
    useRtStore.setState({ subscribeRoutes });
    try {
      useGuidanceStore.getState().startNavigation({
        ...mockItinerary,
        legs: mockItinerary.legs.map((l) => (l.tripId ? { ...l, routeId: "route_1" } : l)),
      });
    } finally {
      useRtStore.setState({ subscribeRoutes: real });
    }
    expect(subscribeRoutes).toHaveBeenCalledWith(["route_1"]);
  });

  it("startNavigation transitions to navigating phase", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("navigating");
    expect(state.itinerary).toBe(mockItinerary);
    expect(state.currentLegIndex).toBe(0);
    expect(state.legStatuses).toEqual(["current", "upcoming", "future"]);
  });

  it("advanceLeg moves to next leg", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    const state = useGuidanceStore.getState();
    expect(state.currentLegIndex).toBe(1);
    expect(state.legStatuses).toEqual(["completed", "current", "upcoming"]);
  });

  it("advanceLeg marks upcoming legs correctly", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    const state = useGuidanceStore.getState();
    // Leg 0 = completed, Leg 1 = current (transit), Leg 2 = upcoming (next after current)
    expect(state.legStatuses[0]).toBe("completed");
    expect(state.legStatuses[1]).toBe("current");
    expect(state.legStatuses[2]).toBe("upcoming");
  });

  it("advanceLeg past last leg ends navigation", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    useGuidanceStore.getState().advanceLeg();
    useGuidanceStore.getState().advanceLeg();
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.itinerary).toBeNull();
  });

  it("enterRiderMode transitions to riderMode phase", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg(); // move to transit leg
    useGuidanceStore.getState().enterRiderMode("navigation", "trip_1");
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("riderMode");
    expect(state.riderModeActivation).toBe("navigation");
    expect(state.riderTripId).toBe("trip_1");
  });

  it("exitRiderMode returns to navigating if itinerary active", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    useGuidanceStore.getState().enterRiderMode("navigation", "trip_1");
    useGuidanceStore.getState().exitRiderMode();
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("navigating");
    expect(state.riderTripId).toBeNull();
  });

  it("enterRiderMode works from idle (manual activation)", () => {
    useGuidanceStore.getState().enterRiderMode("manual", "trip_manual");
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("riderMode");
    expect(state.riderModeActivation).toBe("manual");
    expect(state.riderTripId).toBe("trip_manual");
  });

  it("exitRiderMode returns to idle when no itinerary", () => {
    useGuidanceStore.getState().enterRiderMode("manual", "trip_manual");
    useGuidanceStore.getState().exitRiderMode();
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("idle");
  });

  it("setWalkingProgress updates walking progress", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().setWalkingProgress({
      distanceRemainingMeters: 200,
      estimatedSecondsRemaining: 150,
      bearingDegrees: 45,
    });
    expect(useGuidanceStore.getState().walkingProgress).toEqual({
      distanceRemainingMeters: 200,
      estimatedSecondsRemaining: 150,
      bearingDegrees: 45,
    });
  });

  it("setTransitProgress updates transit progress", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    useGuidanceStore.getState().setTransitProgress({
      currentStopName: "Stop C",
      stopsRemaining: 2,
      delaySeconds: 120,
    });
    expect(useGuidanceStore.getState().transitProgress).toEqual({
      currentStopName: "Stop C",
      stopsRemaining: 2,
      delaySeconds: 120,
    });
  });

  it("reset clears all state", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().advanceLeg();
    useGuidanceStore.getState().reset();
    const state = useGuidanceStore.getState();
    expect(state.phase).toBe("idle");
    expect(state.itinerary).toBeNull();
    expect(state.currentLegIndex).toBe(0);
    expect(state.legStatuses).toEqual([]);
    expect(state.walkingProgress).toBeNull();
    expect(state.transitProgress).toBeNull();
    expect(state.riderTripId).toBeNull();
  });

  it("stopNavigation returns to idle from navigating", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().stopNavigation();
    expect(useGuidanceStore.getState().phase).toBe("idle");
    expect(useGuidanceStore.getState().itinerary).toBeNull();
  });
});

describe("RT integration", () => {
  beforeEach(() => {
    useGuidanceStore.getState().reset();
    vi.restoreAllMocks();
    parkRtPolling();
  });

  it("subscribes to RT routes on startNavigation", () => {
    const subscribeSpy = vi.spyOn(useRtStore.getState(), "subscribeRoutes");
    const setModeSpy = vi.spyOn(useRtStore.getState(), "setMode");

    useGuidanceStore.getState().startNavigation(mockItinerary);

    expect(setModeSpy).toHaveBeenCalledWith("navigating");
  });

  it("sets RT mode to idle on stopNavigation", () => {
    const setModeSpy = vi.spyOn(useRtStore.getState(), "setMode");
    const unsubSpy = vi.spyOn(useRtStore.getState(), "unsubscribeAll");

    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().stopNavigation();

    expect(setModeSpy).toHaveBeenCalledWith("idle");
    expect(unsubSpy).toHaveBeenCalled();
  });

  it("sets RT mode to transfer on transfer proximity", () => {
    const setModeSpy = vi.spyOn(useRtStore.getState(), "setMode");

    useGuidanceStore.getState().startNavigation(mockItinerary);
    useGuidanceStore.getState().setTransferProximity(true);

    expect(setModeSpy).toHaveBeenCalledWith("transfer");
  });
});
