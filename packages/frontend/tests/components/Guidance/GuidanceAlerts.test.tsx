import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Itinerary, Leg } from "@pt/shared";
import { GuidanceAlerts } from "../../../src/components/Guidance/GuidanceAlerts.tsx";
import { useGuidanceStore } from "../../../src/stores/guidanceStore.ts";
import { useSettingsStore } from "../../../src/stores/settingsStore.ts";
import { useRtStore } from "../../../src/stores/rtStore.ts";
import { useGtfsDataStore } from "../../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../../src/stores/cityStore.ts";
import { lineThreeIndex } from "../../helpers/lineThreeIndex.ts";
import { notifyIfBackground } from "../../../src/services/tripNotifications.ts";

vi.mock("../../../src/services/tripNotifications.ts", () => ({
  notifyIfBackground: vi.fn(() => true),
  requestNotificationPermission: vi.fn(async () => true),
}));

const ride: Leg = {
  mode: "BUS",
  from: { name: "Alpha", stopId: "s1", location: { lat: 54.68, lon: 25.25 } },
  to: { name: "Charlie", stopId: "s3", location: { lat: 54.68, lon: 25.27 } },
  departureTime: "2026-09-25T20:03:00Z",
  arrivalTime: "2026-09-25T20:10:00Z",
  durationSeconds: 420,
  routeShortName: "3",
  tripId: "trip_s",
};
const itinerary: Itinerary = {
  legs: [ride],
  departureTime: ride.departureTime,
  arrivalTime: ride.arrivalTime,
  durationSeconds: 420,
  transfers: 0,
  walkingDistanceMeters: 0,
};

describe("GuidanceAlerts — get-off alarm", () => {
  beforeEach(() => {
    useSettingsStore.setState({ getOffAlarmEnabled: true } as never);
    useGuidanceStore.setState({
      phase: "navigating",
      itinerary,
      currentLegIndex: 0,
      legStatuses: ["current"],
      walkingProgress: null,
      transitProgress: null,
    });
  });

  afterEach(() => {
    useGuidanceStore.getState().reset();
  });

  it("names the stop to get off at, not the stop the rider is passing", () => {
    // Passing Bravo, one stop before Charlie.
    useGuidanceStore.setState({
      transitProgress: { currentStopName: "Bravo", stopsRemaining: 1, delaySeconds: 0 },
    });
    render(<GuidanceAlerts />);
    expect(screen.getByTestId("get-off-alarm")).toHaveTextContent("Your stop is next: Charlie");
  });

  it("stays quiet while the rider is not aboard", () => {
    render(<GuidanceAlerts />);
    expect(screen.queryByTestId("get-off-alarm")).toBeNull();
  });
});

describe("GuidanceAlerts — departure reminders", () => {
  // 17:30, 4-min walk to the 17:41 3G from Oro uostas: leave 17:34.
  const trip: Itinerary = {
    legs: [
      {
        mode: "WALK",
        from: { name: "Home", location: { lat: 54.68, lon: 25.24 } },
        to: { name: "Oro uostas", location: { lat: 54.68, lon: 25.25 } },
        departureTime: "2026-09-25T17:30:00Z",
        arrivalTime: "2026-09-25T17:34:00Z",
        durationSeconds: 240,
      },
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
    departureTime: "2026-09-25T17:30:00Z",
    arrivalTime: "2026-09-25T18:05:00Z",
    durationSeconds: 2100,
    transfers: 0,
    walkingDistanceMeters: 300,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T17:30:00Z"));
    vi.mocked(notifyIfBackground).mockClear();
    useRtStore.setState({ updates: new Map() });
    useSettingsStore.setState({
      tripNotificationsEnabled: true,
      mobilityProfile: "default",
      leaveBufferOverrideSeconds: null,
      runToCatch: false,
    } as never);
    useGuidanceStore.setState({
      phase: "navigating",
      itinerary: trip,
      currentLegIndex: 0,
      legStatuses: ["current", "future"],
      walkingProgress: null,
      transitProgress: null,
    });
  });

  afterEach(() => {
    useGuidanceStore.getState().reset();
    useRtStore.setState({ updates: new Map() });
    vi.useRealTimers();
  });

  it("says nothing on opening", () => {
    render(<GuidanceAlerts />);
    expect(screen.queryByTestId("departure-reminder")).toBeNull();
    expect(notifyIfBackground).not.toHaveBeenCalled();
  });

  it("reminds the rider when it is time to leave, on screen and in the background", () => {
    render(<GuidanceAlerts />);
    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    const banner = screen.getByTestId("departure-reminder");
    expect(banner).toHaveTextContent("Time to leave");
    expect(banner).toHaveTextContent("3G leaves Oro uostas at");
    expect(notifyIfBackground).toHaveBeenCalledWith("Time to leave", expect.stringContaining("3G leaves Oro uostas at"));
  });

  it("tells the rider when live data says the bus is running early", () => {
    render(<GuidanceAlerts />);
    act(() => {
      useRtStore.setState({
        updates: new Map([["r3g", [{ tripId: "t3g", delaySeconds: -120, cancelled: false }]]]),
      });
    });
    expect(screen.getByTestId("departure-reminder")).toHaveTextContent("3G now leaves 2 min earlier");
  });

  it("keeps the on-screen reminder but sends nothing with trip notifications off", () => {
    useSettingsStore.setState({ tripNotificationsEnabled: false } as never);
    render(<GuidanceAlerts />);
    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(screen.getByTestId("departure-reminder")).toHaveTextContent("Time to leave");
    expect(notifyIfBackground).not.toHaveBeenCalled();
  });
});

describe("GuidanceAlerts — a likely miss names the next bus", () => {
  const realCity = useCityStore.getState().activeCity;
  // 07:55, 4-min walk to line 3's 08:00 from S1 — fine now, lost by 07:57.
  const trip: Itinerary = {
    legs: [
      {
        mode: "WALK",
        from: { name: "Home", location: { lat: 0, lon: 0 } },
        to: { name: "Stop 1", stopId: "S1", location: { lat: 0, lon: 0 } },
        departureTime: "2026-09-25T07:55:00Z",
        arrivalTime: "2026-09-25T07:59:00Z",
        durationSeconds: 240,
      },
      {
        mode: "BUS",
        from: { name: "Stop 1", stopId: "S1", location: { lat: 0, lon: 0 } },
        to: { name: "Stop 2", stopId: "S2", location: { lat: 0, lon: 0 } },
        departureTime: "2026-09-25T08:00:00Z",
        arrivalTime: "2026-09-25T08:10:00Z",
        durationSeconds: 600,
        routeShortName: "3",
        routeId: "R3",
        tripId: "T800",
      },
    ],
    departureTime: "2026-09-25T07:55:00Z",
    arrivalTime: "2026-09-25T08:10:00Z",
    durationSeconds: 900,
    transfers: 0,
    walkingDistanceMeters: 300,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T07:55:00Z"));
    useCityStore.setState({ activeCity: { ...realCity, tz: "UTC" } });
    useGtfsDataStore.setState({ raptorIndex: lineThreeIndex });
    useSettingsStore.setState({ mobilityProfile: "default", leaveBufferOverrideSeconds: null, runToCatch: false } as never);
    useGuidanceStore.setState({
      phase: "navigating",
      itinerary: trip,
      currentLegIndex: 0,
      legStatuses: ["current", "future"],
      walkingProgress: null,
      transitProgress: null,
    });
  });

  afterEach(() => {
    useGuidanceStore.getState().reset();
    useCityStore.setState({ activeCity: realCity });
    useGtfsDataStore.setState({ raptorIndex: null });
    vi.useRealTimers();
  });

  it("tells the rider when the next one leaves", () => {
    render(<GuidanceAlerts />);
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    const banner = screen.getByTestId("departure-reminder");
    expect(banner).toHaveTextContent("You'll likely miss 3");
    expect(banner).toHaveTextContent("next at");
  });

  it("tells the rider their bus is cancelled, and when the next one runs", () => {
    render(<GuidanceAlerts />);
    act(() => {
      useRtStore.setState({ updates: new Map([["R3", [{ tripId: "T800", delaySeconds: 0, cancelled: true }]]]) });
    });
    const banner = screen.getByTestId("departure-reminder");
    expect(banner).toHaveTextContent("3 is cancelled");
    expect(banner).toHaveTextContent("Next from Stop 1 at");
  });

  it("says a removed bus is no longer scheduled — not cancelled — and when the next one runs", () => {
    render(<GuidanceAlerts />);
    act(() => {
      useRtStore.setState({ updates: new Map([["R3", [{ tripId: "T800", delaySeconds: 0, cancelled: false, deleted: true }]]]) });
    });
    const banner = screen.getByTestId("departure-reminder");
    expect(banner).toHaveTextContent("3 is no longer scheduled");
    expect(banner).toHaveTextContent("Next from Stop 1 at");
    expect(banner.textContent).not.toMatch(/cancel/i);
  });
});
