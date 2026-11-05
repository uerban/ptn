import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StepList } from "../../../src/components/Guidance/StepList.tsx";
import { useGuidanceStore } from "../../../src/stores/guidanceStore.ts";
import { useRtStore } from "../../../src/stores/rtStore.ts";
import { I18nContext } from "../../../src/i18n/index.ts";
import type { Itinerary, Leg } from "@pt/shared";
import type { ReactNode } from "react";
import { parkRtPolling } from "../../helpers/parkRtPolling.ts";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

// 3-leg itinerary: walk → transit → transit. The connection between leg 1
// (transit, "T1") and leg 2 (transit, "T2") is the one StepList computes
// because both have tripIds and leg 2 is non-walk.
//
// We advance currentLegIndex to 1 so leg 2 has status "upcoming" — that's
// the only status that surfaces the connection banner inside LegRow.
const itinerary: Itinerary = {
  legs: [
    {
      mode: "WALK",
      from: { name: "Origin", location: { lat: 0, lon: 0 } },
      to: { name: "Stop A", location: { lat: 0, lon: 0 } },
      departureTime: "2026-04-25T09:55:00Z",
      arrivalTime: "2026-04-25T10:00:00Z",
      durationSeconds: 300,
      distanceMeters: 400,
    } as Leg,
    {
      mode: "TRAM",
      from: { name: "Stop A", location: { lat: 0, lon: 0 } },
      to: { name: "Stop B", location: { lat: 0, lon: 0 } },
      departureTime: "2026-04-25T10:00:00Z",
      arrivalTime: "2026-04-25T10:10:00Z",
      durationSeconds: 600,
      routeShortName: "2",
      headsign: "Central",
      tripId: "T1",
    } as Leg,
    {
      mode: "BUS",
      from: { name: "Stop B", location: { lat: 0, lon: 0 } },
      to: { name: "Stop C", location: { lat: 0, lon: 0 } },
      // 4 min scheduled buffer at Stop B (10:10 → 10:14): safe baseline
      departureTime: "2026-04-25T10:14:00Z",
      arrivalTime: "2026-04-25T10:25:00Z",
      durationSeconds: 660,
      routeShortName: "5",
      headsign: "Downtown",
      tripId: "T2",
    } as Leg,
  ],
  departureTime: "2026-04-25T09:55:00Z",
  arrivalTime: "2026-04-25T10:25:00Z",
  durationSeconds: 1800,
  transfers: 1,
  walkingDistanceMeters: 400,
};

describe("StepList — connection-status RT reactivity (D-009)", () => {
  beforeEach(() => {
    useGuidanceStore.getState().reset();
    useRtStore.setState({ updates: new Map() });
    parkRtPolling();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T09:50:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    useRtStore.setState({ updates: new Map() });
  });

  function setup() {
    useGuidanceStore.getState().startNavigation(itinerary);
    // Advance so leg 1 is current and leg 2 ("upcoming") shows its
    // connection banner.
    useGuidanceStore.getState().advanceLeg();

    return render(<StepList onLegTap={() => {}} onClose={() => {}} />, {
      wrapper: Wrapper,
    });
  }

  it("baseline: shows safe connection when no RT updates", () => {
    setup();
    expect(screen.getByText(/Connection safe/i)).toBeInTheDocument();
  });

  it("re-renders extraTime banner when next transit leg becomes 5 min late", () => {
    setup();
    expect(screen.getByText(/Connection safe/i)).toBeInTheDocument();

    act(() => {
      useRtStore.setState({
        updates: new Map([
          ["R5", [{ tripId: "T2", delaySeconds: 300, cancelled: false }]],
        ]),
      });
    });

    expect(screen.getByText(/extra time/i)).toBeInTheDocument();
    expect(screen.queryByText(/Connection safe/i)).toBeNull();
  });

  it("re-renders atRisk banner when first transit leg becomes 5 min late", () => {
    setup();
    expect(screen.getByText(/Connection safe/i)).toBeInTheDocument();

    // First transit leg arriving 5 min late eats the 4 min scheduled buffer
    // and pushes it into the < 0 (atRisk) branch.
    act(() => {
      useRtStore.setState({
        updates: new Map([
          ["R2", [{ tripId: "T1", delaySeconds: 300, cancelled: false }]],
        ]),
      });
    });

    expect(screen.getByText(/at risk/i)).toBeInTheDocument();
    expect(screen.queryByText(/Connection safe/i)).toBeNull();
  });
});
