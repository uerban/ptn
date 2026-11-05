import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RiderDashboard } from "../../../src/components/Guidance/RiderDashboard.tsx";
import type { Leg, ConnectingDeparture } from "@pt/shared";

// Component-level test that asserts the chip + empty-state contracts
// directly. Skips the full HomePage render path on purpose — that
// would require mocking ~12 stores; the chain
// `setMobilityProfile -> store -> component` is covered by D2 + D5
// integration once the PR ships.
//
// I18nProvider is intentionally not wrapped: the default I18nContext
// returns `fallback ?? key`, which is exactly what we assert against.

const baseLeg: Leg = {
  mode: "TRAM",
  from: { name: "Stop A", stopId: "S1", location: { lat: 0, lon: 0 } },
  to: { name: "Stop S2", stopId: "S2", location: { lat: 0, lon: 0 } },
  departureTime: "2026-04-25T10:00:00Z",
  arrivalTime: "2026-04-25T10:10:00Z",
  durationSeconds: 600,
  routeShortName: "1",
  headsign: "Center",
  intermediateStops: 0,
  tripId: "TRIP-A",
};

function makePropsWithDepartures(departures: ConnectingDeparture[]) {
  return {
    leg: baseLeg,
    upcomingStops: [{ id: "S2", name: "Stop S2" }],
    connectingDepartures: [
      {
        stopName: "Stop S2",
        departures,
      },
    ],
    onExit: () => {},
  };
}

describe("RiderDashboard connecting-departures", () => {
  it("renders a connection-chip per real departure", () => {
    const props = makePropsWithDepartures([
      { routeShortName: "R1", headsign: "Center", minutesUntil: 8 },
      { routeShortName: "R2", headsign: "North", minutesUntil: 12 },
    ]);
    const { container } = render(<RiderDashboard {...props} />);
    const chips = container.querySelectorAll(
      '[data-testid="connection-chip"]',
    );
    expect(chips.length).toBe(2);
  });

  it("renders the no-upcoming-connections message when departures resolve to []", () => {
    const props = makePropsWithDepartures([]);
    const { getByTestId } = render(<RiderDashboard {...props} />);
    const empty = getByTestId("dashboard-no-upcoming");
    expect(empty.textContent).toMatch(/no upcoming/i);
  });

  it("renders a `~` prefix and an approximate aria-label when isApproximate is true", () => {
    // Return-only stops on bidirectional routes carry positional minute
    // counts (per-stop departure column is unknown). The dashboard chip
    // must signal that to sighted users via a `~` prefix and to screen
    // readers via the aria-label "X minutes, approximate".
    const props = makePropsWithDepartures([
      {
        routeShortName: "R1",
        headsign: "Return",
        minutesUntil: 8,
        isApproximate: true,
      },
    ]);
    const { container } = render(<RiderDashboard {...props} />);
    const chip = container.querySelector('[data-testid="connection-chip"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("~8m");
    expect(chip!.getAttribute("aria-label")).toMatch(/8 minutes, approximate/);
  });

  it("omits the `~` prefix and the aria-label when isApproximate is unset", () => {
    const props = makePropsWithDepartures([
      { routeShortName: "R1", headsign: "Center", minutesUntil: 8 },
    ]);
    const { container } = render(<RiderDashboard {...props} />);
    const chip = container.querySelector('[data-testid="connection-chip"]');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("8m");
    expect(chip!.textContent).not.toContain("~");
    expect(chip!.getAttribute("aria-label")).toBeNull();
  });
});
