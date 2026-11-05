import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LegRow } from "../../src/components/Guidance/LegRow.tsx";
import { computeConnectionStatus } from "../../src/components/Guidance/connectionStatus.ts";
import { I18nContext } from "../../src/i18n/index.ts";
import type { Leg, LegStatus, WalkingProgress, TransitProgress } from "@pt/shared";
import type { ReactNode } from "react";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const walkLeg: Leg = {
  mode: "WALK",
  from: { name: "Origin", location: { lat: 0, lon: 0 } },
  to: { name: "Stop A", location: { lat: 0, lon: 0 } },
  departureTime: "2026-03-28T10:00:00Z",
  arrivalTime: "2026-03-28T10:05:00Z",
  durationSeconds: 300,
  distanceMeters: 400,
};

const transitLeg: Leg = {
  mode: "TRAM",
  from: { name: "Stop A", location: { lat: 0, lon: 0 } },
  to: { name: "Stop B", location: { lat: 0, lon: 0 } },
  departureTime: "2026-03-28T10:08:00Z",
  arrivalTime: "2026-03-28T10:20:00Z",
  durationSeconds: 720,
  routeShortName: "2",
  headsign: "Central Station",
  intermediateStops: 4,
};

describe("LegRow", () => {
  it("renders completed leg with strikethrough styling", () => {
    const { container } = render(
      <LegRow leg={walkLeg} status="completed" />,
      { wrapper: Wrapper }
    );
    const row = container.firstChild as HTMLElement;
    expect(row.className).toContain("opacity-50");
  });

  it("renders current walking leg with progress", () => {
    const progress: WalkingProgress = {
      distanceRemainingMeters: 200,
      estimatedSecondsRemaining: 150,
      bearingDegrees: 45,
    };
    render(
      <LegRow leg={walkLeg} status="current" walkingProgress={progress} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/200\s*m/)).toBeInTheDocument();
  });

  it("renders current transit leg with stops remaining", () => {
    const progress: TransitProgress = {
      currentStopName: "Stop C",
      stopsRemaining: 2,
      delaySeconds: 0,
    };
    render(
      <LegRow leg={transitLeg} status="current" transitProgress={progress} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/2 stops/)).toBeInTheDocument();
    expect(screen.getByText("Stop C")).toBeInTheDocument();
  });

  it("says '1 stop', not '1 stops', on the last stretch", () => {
    const progress: TransitProgress = { currentStopName: null, stopsRemaining: 1, delaySeconds: 0 };
    render(<LegRow leg={transitLeg} status="current" transitProgress={progress} />, { wrapper: Wrapper });
    expect(screen.getByText("1 stop")).toBeInTheDocument();
  });

  it("names where a current ride goes while it has not left yet", () => {
    // No progress until the vehicle leaves — the row must still say which bus.
    render(<LegRow leg={transitLeg} status="current" transitProgress={null} />, { wrapper: Wrapper });
    expect(screen.getByText("Central Station")).toBeInTheDocument();
  });

  it("renders future leg dimmed", () => {
    const { container } = render(
      <LegRow leg={transitLeg} status="future" />,
      { wrapper: Wrapper }
    );
    const row = container.firstChild as HTMLElement;
    expect(row.className).toContain("opacity-40");
  });

  it("renders upcoming leg with scheduled time", () => {
    render(
      <LegRow leg={transitLeg} status="upcoming" />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/Central Station/)).toBeInTheDocument();
  });

  it("renders transit delay badge when delay > 60s", () => {
    const progress: TransitProgress = {
      currentStopName: null,
      stopsRemaining: 3,
      delaySeconds: 120,
    };
    render(
      <LegRow leg={transitLeg} status="current" transitProgress={progress} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/\+2/)).toBeInTheDocument();
  });

  it("shows route badge with routeShortName", () => {
    render(
      <LegRow leg={transitLeg} status="upcoming" />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("marks approximate frequency-based transit departures", () => {
    render(
      <LegRow leg={{ ...transitLeg, approximate: true }} status="upcoming" />,
      { wrapper: Wrapper }
    );

    expect(screen.getByText(/approx\./i)).toBeInTheDocument();
  });
});

describe("computeConnectionStatus", () => {
  const currentLeg: Leg = {
    mode: "TRAM",
    from: { name: "Stop A", location: { lat: 0, lon: 0 } },
    to: { name: "Stop B", location: { lat: 0, lon: 0 } },
    departureTime: "2026-03-28T10:00:00Z",
    arrivalTime: "2026-03-28T10:10:00Z",
    durationSeconds: 600,
    tripId: "trip_1",
    routeShortName: "2",
  };

  const nextLeg: Leg = {
    mode: "BUS",
    from: { name: "Stop B", location: { lat: 0, lon: 0 } },
    to: { name: "Stop C", location: { lat: 0, lon: 0 } },
    departureTime: "2026-03-28T10:15:00Z",
    arrivalTime: "2026-03-28T10:25:00Z",
    durationSeconds: 600,
    tripId: "trip_2",
    routeShortName: "5",
  };

  const mockRtStore = (delays: Record<string, number>) => ({
    getTripDelay: (tripId: string) => {
      const d = delays[tripId];
      return d !== undefined ? { delaySeconds: d, cancelled: false } : null;
    },
  });

  it("returns safe when buffer is sufficient", () => {
    const result = computeConnectionStatus(currentLeg, nextLeg, mockRtStore({}));
    expect(result?.safety).toBe("safe");
  });

  it("returns atRisk when current leg is very delayed", () => {
    // Current leg delayed 6 min -> arrives at 10:16, next departs 10:15
    const result = computeConnectionStatus(
      currentLeg,
      nextLeg,
      mockRtStore({ trip_1: 360 })
    );
    expect(result?.safety).toBe("atRisk");
  });

  it("returns extraTime when next leg is late", () => {
    // Next leg delayed 3 min -> departs at 10:18 instead of 10:15
    // Positive delay = vehicle running late = extra time for user
    const result = computeConnectionStatus(
      currentLeg,
      nextLeg,
      mockRtStore({ trip_2: 180 })
    );
    expect(result?.safety).toBe("extraTime");
    expect(result?.message).toContain("extra time");
  });

  it("returns null when legs have no trip IDs", () => {
    const noTrip = { ...currentLeg, tripId: undefined };
    const result = computeConnectionStatus(noTrip, nextLeg, mockRtStore({}));
    expect(result).toBeNull();
  });
});
