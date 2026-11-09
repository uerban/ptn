import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Departure, StopWithLines } from "@pt/shared";
import type { Side } from "../../services/nearbyDirections.ts";

const NOW = Date.parse("2026-11-08T10:00:00Z");
const S: StopWithLines = { id: "S", name: "Central", location: { lat: 54.0, lon: 25.0 }, lastSeen: 0 };
const R: StopWithLines = { id: "R", name: "Central opposite", location: { lat: 54.0005, lon: 25.0 }, lastSeen: 0 };
const TOP: Side = { stopId: "S", routeId: "r1", dirKey: "d0", row: "top" };
const BOTTOM: Side = { stopId: "R", routeId: "r1", dirKey: "d1", row: "bottom" };

function dep(headsign: string, minutes: number, live: boolean): Departure {
  const time = new Date(NOW + minutes * 60_000).toISOString();
  return {
    routeId: "r1",
    routeShortName: "4",
    mode: "BUS",
    headsign,
    scheduledTime: time,
    ...(live ? { predictedTime: time } : {}),
    tripId: `${headsign}-${minutes}`,
  };
}

const hook = vi.hoisted(() => ({
  args: [] as unknown[],
  value: {
    nearestStop: null as StopWithLines | null,
    sides: [] as Side[],
    departuresBySide: new Map<Side, Departure[]>(),
    loading: false,
  },
}));
vi.mock("../../hooks/useNearbyDirections.ts", () => ({
  useNearbyDirections: (args: unknown) => {
    hook.args.push(args);
    return hook.value;
  },
}));
vi.mock("../../hooks/useDownloadedStops.ts", () => ({ useDownloadedStops: () => [S, R] }));
vi.mock("../../hooks/useServerNow.ts", () => ({ useServerNow: () => NOW }));

import { NearbyDeparturesList } from "./NearbyDeparturesList.tsx";

beforeEach(() => {
  hook.args = [];
  hook.value = { nearestStop: null, sides: [], departuresBySide: new Map(), loading: false };
});

describe("NearbyDeparturesList", () => {
  it("renders nothing and fetches nothing without a centre", () => {
    const { container } = render(<NearbyDeparturesList center={null} chosenStopName={null} onSelectStop={vi.fn()} />);
    expect(container.textContent).toBe("");
    expect(hook.args.at(-1)).toMatchObject({ enabled: false, position: null });
  });

  it("reads nearby departures from the downloaded stops, not a map viewport", () => {
    render(<NearbyDeparturesList center={S.location} chosenStopName={null} onSelectStop={vi.fn()} />);
    expect(hook.args.at(-1)).toEqual({ enabled: true, position: S.location, visibleStops: [S, R], cityStops: [S, R] });
  });

  it("groups by stop and side of the street, with line, direction, stop and status in each label", () => {
    hook.value = {
      nearestStop: S,
      sides: [TOP, BOTTOM],
      departuresBySide: new Map([
        [TOP, [dep("Airport", 3, true)]],
        [BOTTOM, [dep("Old Town", 0, false)]],
      ]),
      loading: false,
    };
    const onSelectStop = vi.fn();
    render(<NearbyDeparturesList center={S.location} chosenStopName={null} onSelectStop={onSelectStop} />);

    expect(screen.getByRole("heading", { name: "Departures near you" })).toBeTruthy();
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(groups[0].getAttribute("data-row")).toBe("top");
    expect(within(groups[0]).getByRole("heading").textContent).toBe("Central, 0 m");
    expect(within(groups[1]).getByRole("heading").textContent).toMatch(/^Opposite direction, Central opposite, \d+ m$/);

    const [live, scheduled] = screen.getAllByTestId("nearby-departure");
    expect(live.getAttribute("aria-label")).toBe("Line 4 toward Airport, from Central, in 3 min, Live");
    expect(scheduled.getAttribute("aria-label")).toBe("Line 4 toward Old Town, from Central opposite, due now, Scheduled");
    expect(scheduled.getAttribute("data-status")).toBe("scheduled");

    // Countdowns change every minute: nothing that holds them is a live region.
    expect(document.querySelector("[aria-live]")).toBeNull();

    fireEvent.click(scheduled);
    expect(onSelectStop).toHaveBeenCalledWith({ id: "R", name: "Central opposite", location: R.location });
  });

  it("names the chosen stop instead of claiming the user's surroundings", () => {
    hook.value = { nearestStop: S, sides: [TOP], departuresBySide: new Map([[TOP, [dep("Airport", 5, false)]]]), loading: false };
    render(<NearbyDeparturesList center={S.location} chosenStopName="Central" onSelectStop={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Departures near Central" })).toBeTruthy();
    expect(screen.queryByText("Departures near you")).toBeNull();
  });

  it("shows a loading status and an empty state", () => {
    hook.value = { nearestStop: S, sides: [TOP], departuresBySide: new Map(), loading: true };
    const view = render(<NearbyDeparturesList center={S.location} chosenStopName={null} onSelectStop={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading departures/);
    hook.value = { ...hook.value, loading: false };
    view.rerender(<NearbyDeparturesList center={S.location} chosenStopName={null} onSelectStop={vi.fn()} />);
    expect(screen.getByTestId("nearby-departures-empty").textContent).toMatch(/No departures/);
  });
});
