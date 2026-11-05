import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RiderDashboard } from "../../src/components/Guidance/RiderDashboard.tsx";
import type { Leg } from "@pt/shared";

const transitLeg: Leg = {
  mode: "TRAM",
  from: { name: "Stop A", stopId: "s1", location: { lat: 54.36, lon: 18.65 } },
  to: { name: "Stop D", stopId: "s4", location: { lat: 54.39, lon: 18.68 } },
  departureTime: "2026-03-28T10:08:00Z",
  arrivalTime: "2026-03-28T10:20:00Z",
  durationSeconds: 720,
  routeShortName: "2",
  headsign: "Central Station",
  intermediateStops: 3,
  tripId: "trip_1",
};

const upcomingStops = [
  { name: "Stop B", id: "s2" },
  { name: "Stop C", id: "s3" },
  { name: "Stop D", id: "s4" },
];

describe("RiderDashboard", () => {
  it("renders route badge and headsign", () => {
    render(
      <RiderDashboard
        leg={transitLeg}
        upcomingStops={upcomingStops}
        connectingDepartures={[]}
        onExit={() => {}}
      />
    );
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Central Station")).toBeInTheDocument();
  });

  it("renders upcoming stops list", () => {
    render(
      <RiderDashboard
        leg={transitLeg}
        upcomingStops={upcomingStops}
        connectingDepartures={[]}
        onExit={() => {}}
      />
    );
    expect(screen.getByText("Stop B")).toBeInTheDocument();
    expect(screen.getByText("Stop C")).toBeInTheDocument();
    expect(screen.getByText("Stop D")).toBeInTheDocument();
  });

  it("highlights destination stop", () => {
    render(
      <RiderDashboard
        leg={transitLeg}
        upcomingStops={upcomingStops}
        connectingDepartures={[]}
        onExit={() => {}}
      />
    );
    const destStop = screen.getByText("Stop D");
    expect(destStop.closest("[data-destination]")).toBeTruthy();
  });

  it("calls onExit when tapping exit", () => {
    const onExit = vi.fn();
    render(
      <RiderDashboard
        leg={transitLeg}
        upcomingStops={upcomingStops}
        connectingDepartures={[]}
        onExit={onExit}
      />
    );
    fireEvent.click(screen.getByLabelText("Exit rider mode"));
    expect(onExit).toHaveBeenCalled();
  });

  it("renders connecting departures when provided", () => {
    const connections = [
      {
        stopName: "Stop D",
        departures: [
          { routeShortName: "5", headsign: "Airport", minutesUntil: 3 },
        ],
      },
    ];
    render(
      <RiderDashboard
        leg={transitLeg}
        upcomingStops={upcomingStops}
        connectingDepartures={connections}
        onExit={() => {}}
      />
    );
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Airport")).toBeInTheDocument();
  });
});
