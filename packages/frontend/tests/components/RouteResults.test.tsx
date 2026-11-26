import { makeMixedItinerary } from "../helpers/makeItinerary.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { RouteResults } from "../../src/components/RouteResults/RouteResults.tsx";
import type { BaseEndpoint, Itinerary } from "@pt/shared";
import { db } from "../../src/db/index.ts";
import { listSaves } from "../../src/services/saves.ts";
import {
  findLeaks,
  rawTableText,
  resetPersonalStorage,
} from "../../src/test-helpers/personalStorage.ts";
import { serverTime } from "../../src/services/serverTime.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";

function makeItinerary(overrides: Partial<Itinerary> = {}): Itinerary {
  return {
    legs: [
      {
        mode: "BUS",
        from: { name: "Stop A", location: { lat: 54.68, lon: 25.28 } },
        to: { name: "Stop B", location: { lat: 54.69, lon: 25.29 } },
        departureTime: "2026-03-03T10:00:00Z",
        arrivalTime: "2026-03-03T10:15:00Z",
        durationSeconds: 900,
        routeShortName: "42",
      },
    ],
    departureTime: "2026-03-03T10:00:00Z",
    arrivalTime: "2026-03-03T10:15:00Z",
    durationSeconds: 900,
    transfers: 0,
    walkingDistanceMeters: 200,
    ...overrides,
  };
}

describe("RouteResults", () => {
  it("compares direct arrival against the earliest journey independent of the order", () => {
    vi.stubEnv("VITE_PTN_DIRECT_TRADEOFF", "1");
    const direct = makeItinerary({ arrivalTime: "2026-03-03T10:19:00Z" });
    const transfer = makeItinerary({ transfers: 2 });
    direct.legs[0] = { ...direct.legs[0], tripId: "direct", arrivalTime: direct.arrivalTime };
    transfer.legs[0] = { ...transfer.legs[0], tripId: "transfer" };
    const now = vi.spyOn(serverTime, "now").mockReturnValue(Date.parse(direct.departureTime) - 60_000);
    try {
      render(<BrowserRouter><RouteResults itineraries={[direct, transfer]} onSelect={() => {}} feedTz="UTC" /></BrowserRouter>);
      const [directCard, transferCard] = screen.getAllByTestId("itinerary-card");
      expect(directCard).toHaveTextContent("Direct · arrives 4 min later");
      expect(transferCard).not.toHaveTextContent("arrives 4 min later");
      expect(directCard).toHaveAccessibleName(/Direct.*arrives 4 min later/i);
    } finally {
      now.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("announces transfer waiting alongside arrival when the comparison is enabled", () => {
    vi.stubEnv("VITE_PTN_TRANSFER_WAIT_COMPARISON", "1");
    const itinerary = makeMixedItinerary();
    const now = vi.spyOn(serverTime, "now").mockReturnValue(Date.parse(itinerary.departureTime) - 60_000);
    try {
      render(<BrowserRouter><RouteResults itineraries={[itinerary]} onSelect={() => {}} feedTz="UTC" /></BrowserRouter>);
      expect(screen.getByText("2 min waiting between vehicles")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /arrives .*2 min waiting between vehicles/i })).toBeInTheDocument();
    } finally {
      now.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("opens guidance for the whole itinerary when a verified replacement is selected", () => {
    vi.stubEnv("VITE_PTN_INTERCHANGEABLE_DEPARTURES", "1");
    const primary = makeMixedItinerary();
    const now = vi.spyOn(serverTime, "now").mockReturnValue(Date.parse(primary.departureTime) - 60_000);
    for (const leg of primary.legs.filter((item) => item.mode !== "WALK")) {
      Object.assign(leg, { boardStopIdx: 0, alightStopIdx: 1, patternStopIds: [leg.from.stopId, leg.to.stopId] });
    }
    const candidate = { ...primary, legs: [
      { ...primary.legs[0], routeId: "alternate", routeShortName: "4", tripId: "replacement", headsign: "Centre" },
      ...primary.legs.slice(1),
    ] };
    const onSelect = vi.fn();
    try {
      const alternate = { ...candidate, legs: [
        { ...candidate.legs[0], routeId: "bus22", routeShortName: "22", tripId: "replacement-22", headsign: "Lazdynai" },
        ...candidate.legs.slice(1),
      ] };
      const duplicate = { ...candidate, legs: [{ ...candidate.legs[0], tripId: "duplicate" }, ...candidate.legs.slice(1)] };
      render(<BrowserRouter><RouteResults itineraries={[primary, candidate, duplicate, alternate]}
        onSelect={onSelect} feedTz="UTC" /></BrowserRouter>);
      expect(screen.getByRole("button", { name: /Take 22 toward Lazdynai.*Arrives/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Take 4 toward Centre at .* instead.*Arrives/ }));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(candidate);
    } finally {
      now.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each(["balanced", "battery-saver"] as const)("bounds requested alternatives in %s mode", async (searchPowerMode) => {
    const previousMode = useSettingsStore.getState().searchPowerMode;
    useSettingsStore.setState({ searchPowerMode });
    vi.stubEnv("VITE_PTN_SEARCH_POWER_MODES", "1");
    vi.stubEnv("VITE_PTN_VERIFIED_LATER_JOURNEY", "1");
    const batterySaver = searchPowerMode === "battery-saver";
    vi.stubEnv("VITE_PTN_SHOW_JOURNEY_ALTERNATIVES", "1");
    const primary = makeItinerary();
    const now = vi.spyOn(serverTime, "now").mockReturnValue(Date.parse(primary.departureTime) + (batterySaver ? 60_000 : -60_000));
    Object.assign(primary.legs[0], {
      tripId: "original", routeId: "42", boardStopIdx: 0, alightStopIdx: 1,
      patternStopIds: ["A", "B"],
      from: { ...primary.legs[0].from, stopId: "A" }, to: { ...primary.legs[0].to, stopId: "B" },
    });
    const departureTime = "2026-03-03T10:08:00Z";
    const arrivalTime = "2026-03-03T10:23:00Z";
    const later = { ...primary, departureTime, arrivalTime, legs: [
      { ...primary.legs[0], tripId: "later", departureTime, arrivalTime },
    ] };
    const findLaterPlans = vi.fn(async () => [later]);
    const different = { ...later, legs: [{
      ...later.legs[0], routeId: "43", routeShortName: "43", tripId: "different",
    }] };
    const findDifferentPlans = vi.fn(async () => [different]);
    const onSelect = vi.fn();
    try {
      render(<BrowserRouter><RouteResults itineraries={[primary]} onSelect={onSelect}
        findLaterPlans={findLaterPlans} findDifferentPlans={findDifferentPlans} feedTz="UTC" /></BrowserRouter>);
      expect(findLaterPlans).not.toHaveBeenCalled();
      expect(findDifferentPlans).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Show alternatives" }));
      fireEvent.click(await screen.findByRole("button", { name: /also leaves at .* arrives at/i }));
      expect(findLaterPlans).toHaveBeenCalledExactlyOnceWith(new Date(batterySaver ? "2026-03-03T10:01:00Z" : "2026-03-03T10:00:01Z"), expect.any(AbortSignal),
        { routeId: "42", boardStopId: "A", alightStopId: "B", direct: true });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(later);
      if (batterySaver) {
        expect(findDifferentPlans).not.toHaveBeenCalled();
        return;
      }
      fireEvent.click(screen.getByRole("button", { name: /Take 43.*Transfers: 0/i }));
      expect(onSelect).toHaveBeenLastCalledWith(different);
      expect(findDifferentPlans).toHaveBeenCalledExactlyOnceWith(new Date(primary.departureTime), expect.any(AbortSignal), "42");
    } finally {
      useSettingsStore.setState({ searchPowerMode: previousMode });
      now.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("uses the retained later trip while still checking for a distinct Arrive By option", async () => {
    vi.stubEnv("VITE_PTN_SHOW_JOURNEY_ALTERNATIVES", "1");
    const makeRide = (routeId: string, tripId: string, departureTime: string, arrivalTime: string) => {
      const plan = makeItinerary({ departureTime, arrivalTime });
      const leg = plan.legs[0];
      Object.assign(leg, { routeId, routeShortName: routeId, tripId, departureTime, arrivalTime,
        boardStopIdx: 0, alightStopIdx: 1, patternStopIds: ["A", "B"],
        from: { ...leg.from, stopId: "A" }, to: { ...leg.to, stopId: "B" } });
      return plan;
    };
    const primary = makeRide("42", "primary", "2026-03-03T10:00:00Z", "2026-03-03T10:15:00Z");
    const later = makeRide("42", "later", "2026-03-03T10:08:00Z", "2026-03-03T10:23:00Z");
    const different = makeRide("43", "different", "2026-03-03T10:02:00Z", "2026-03-03T10:17:00Z");
    const nowMs = Date.parse(primary.departureTime) - 60_000;
    const deadline = Date.parse(later.arrivalTime);
    const clock = vi.spyOn(serverTime, "now").mockReturnValue(nowMs);
    const findLaterPlans = vi.fn(async () => []);
    const findDifferentPlans = vi.fn(async () => [different]);
    try {
      render(<BrowserRouter><RouteResults itineraries={[primary, later]} onSelect={() => {}}
        arriveByMs={deadline} findLaterPlans={findLaterPlans} findDifferentPlans={findDifferentPlans} feedTz="UTC" /></BrowserRouter>);
      fireEvent.click(screen.getByRole("button", { name: "Show alternatives" }));
      expect(await screen.findByRole("button", { name: /Take 43.*Transfers: 0/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /also leaves at .* arrives at/i })).toBeInTheDocument();
      expect(findLaterPlans).not.toHaveBeenCalled();
      expect(findDifferentPlans).toHaveBeenCalledExactlyOnceWith(new Date(nowMs), expect.any(AbortSignal), "42", deadline, ["42"]);
    } finally {
      clock.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("keeps a verified alternative while its access walk still fits", async () => {
    vi.stubEnv("VITE_PTN_SHOW_JOURNEY_ALTERNATIVES", "1");
    vi.useFakeTimers();
    const start = Date.parse("2026-03-03T09:59:00Z");
    const clock = vi.spyOn(serverTime, "now").mockReturnValue(start);
    const primary = makeItinerary();
    const ride = primary.legs[0];
    Object.assign(ride, {
      tripId: "primary", routeId: "42", boardStopIdx: 0, alightStopIdx: 1,
      patternStopIds: ["A", "B"], from: { ...ride.from, stopId: "A" }, to: { ...ride.to, stopId: "B" },
    });
    const departureTime = "2026-03-03T10:00:01Z";
    const arrivalTime = "2026-03-03T10:23:00Z";
    const later: Itinerary = { ...primary, departureTime, arrivalTime, legs: [
      { mode: "WALK", from: { ...ride.from, stopId: undefined }, to: ride.from,
        departureTime, arrivalTime: "2026-03-03T10:02:01Z", durationSeconds: 120 },
      { ...ride, tripId: "later", departureTime: "2026-03-03T10:08:00Z", arrivalTime },
    ] };
    const findLaterPlans = vi.fn(async () => [later]);
    try {
      render(<BrowserRouter><RouteResults itineraries={[primary]} onSelect={() => {}}
        findLaterPlans={findLaterPlans} feedTz="UTC" /></BrowserRouter>);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show alternatives" })));
      const option = { name: /also leaves at .* arrives at/i };
      expect(screen.getByRole("button", option)).toBeInTheDocument();
      clock.mockReturnValue(Date.parse("2026-03-03T10:03:00Z"));
      act(() => vi.advanceTimersByTime(10_000));
      expect(screen.getByRole("button", option)).toBeInTheDocument();
      clock.mockReturnValue(Date.parse("2026-03-03T10:07:00Z"));
      act(() => vi.advanceTimersByTime(10_000));
      expect(screen.queryByRole("button", option)).not.toBeInTheDocument();
      expect(findLaterPlans).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("opens the exact later plan after a missed departure, within the arrival deadline", async () => {
    vi.stubEnv("VITE_PTN_VERIFIED_LATER_JOURNEY", "1");
    const now = vi.spyOn(serverTime, "now").mockReturnValue(Date.parse("2026-03-03T10:01:00Z"));
    const primary = makeItinerary();
    Object.assign(primary.legs[0], {
      tripId: "missed", routeId: "42", boardStopIdx: 0, alightStopIdx: 1,
      patternStopIds: ["A", "B"],
      from: { ...primary.legs[0].from, stopId: "A" },
      to: { ...primary.legs[0].to, stopId: "B" },
    });
    const later = makeItinerary({
      departureTime: "2026-03-03T10:08:00Z",
      arrivalTime: "2026-03-03T10:23:00Z",
      legs: [{
        ...primary.legs[0], tripId: "later",
        departureTime: "2026-03-03T10:08:00Z", arrivalTime: "2026-03-03T10:23:00Z",
      }],
    });
    const onSelect = vi.fn();
    const findLaterPlans = vi.fn(async () => [later]);
    const renderResults = (deadline: string, retainLater = true) => (
      <BrowserRouter>
        <RouteResults itineraries={retainLater ? [primary, later] : [primary]} onSelect={onSelect}
          feedTz="UTC" arriveByMs={Date.parse(deadline)}
          findLaterPlans={retainLater ? undefined : findLaterPlans} />
      </BrowserRouter>
    );
    try {
      const { rerender } = render(renderResults("2026-03-03T10:22:00Z"));
      expect(screen.queryByRole("button", { name: /also leaves at/i })).toBeNull();
      rerender(renderResults("2026-03-03T10:23:00Z"));
      fireEvent.click(screen.getByRole("button", { name: /also leaves at .* arrives at/i }));
      expect(onSelect).toHaveBeenCalledWith(later);
      rerender(renderResults("2026-03-03T10:23:00Z", false));
      fireEvent.click(await screen.findByRole("button", { name: /also leaves at .* arrives at/i }));
      expect(findLaterPlans).toHaveBeenCalledExactlyOnceWith(new Date("2026-03-03T10:01:00Z"), expect.any(AbortSignal), { routeId: "42", boardStopId: "A", alightStopId: "B", direct: true });
      expect(onSelect).toHaveBeenCalledTimes(2);
      expect(onSelect).toHaveBeenLastCalledWith(later);
    } finally {
      now.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("shows loading skeleton when loading", () => {
    const { container } = render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={() => {}} loading={true} />
      </BrowserRouter>
    );
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBe(3);
  });

  it("shows empty message when no itineraries", () => {
    render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={() => {}} loading={false} />
      </BrowserRouter>
    );
    expect(screen.getByText(/no routes found/i)).toBeInTheDocument();
  });

  it("renders itinerary cards with duration", () => {
    const itinerary = makeItinerary({ durationSeconds: 1800 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("30 min")).toBeInTheDocument();
  });

  it("renders transfer count", () => {
    const itinerary = makeItinerary({ transfers: 2 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("2 transfers")).toBeInTheDocument();
  });

  it("uses singular 'transfer' for exactly 1", () => {
    const itinerary = makeItinerary({ transfers: 1 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("1 transfer")).toBeInTheDocument();
  });

  it("shows walking distance when present", () => {
    const itinerary = makeItinerary({ walkingDistanceMeters: 350 });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("350 m walk")).toBeInTheDocument();
  });

  it("shows route short name", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("shows transport mode icon", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByLabelText("Bus")).toBeInTheDocument();
  });

  it("calls onSelect when clicking an itinerary", () => {
    const onSelect = vi.fn();
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={onSelect} />
      </BrowserRouter>
    );
    // Cards are plain buttons inside a <ul role="list"> (US-037); they are
    // NOT listbox options — see the RouteResults keydown comment.
    fireEvent.click(screen.getByTestId("itinerary-card"));
    expect(onSelect).toHaveBeenCalledWith(itinerary);
  });

  it("renders multiple itineraries", () => {
    const itineraries = [
      makeItinerary({ transfers: 0 }),
      makeItinerary({ transfers: 1 }),
      makeItinerary({ transfers: 2 }),
    ];
    render(
      <BrowserRouter>
        <RouteResults itineraries={itineraries} onSelect={() => {}} />
      </BrowserRouter>
    );
    // Each card is a <li>-wrapped button inside the results list.
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getAllByTestId("itinerary-card")).toHaveLength(3);
  });

  it("shows the route number, headsign and local departure time together", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "142",
          headsign: "Central Station",
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} feedTz="Europe/Vilnius" />
      </BrowserRouter>
    );
    const departure = screen.getByText(/toward Central Station/);
    expect(departure.parentElement).toContainElement(screen.getByText("142"));
    expect(departure.querySelector("time")).toHaveAttribute("datetime", "2026-03-03T10:00:00Z");
    expect(departure.querySelector("time")).toHaveTextContent("12:00");
    expect(screen.getByTestId("itinerary-card")).toHaveAccessibleName(/Bus 142.*toward Central Station, departs 12:00/);
  });

  it("does not show headsign for WALK legs", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:05:00Z",
          durationSeconds: 300,
          headsign: "Should Not Appear",
        },
      ],
      transfers: 0,
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.queryByText(/Should Not Appear/)).not.toBeInTheDocument();
  });

  it("shows a departure time without a headsign", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const card = screen.getByTestId("itinerary-card");
    expect(card.querySelector("time")).toHaveAttribute("datetime", itinerary.legs[0].departureTime);
    expect(screen.queryByText(/toward/)).not.toBeInTheDocument();
  });

  it("keeps long destination signs readable", () => {
    const longHeadsign = "Very Long Destination Name That Identifies the Branch";
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "TRAM",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "3",
          headsign: longHeadsign,
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByText(new RegExp(longHeadsign))).toHaveClass("break-words");
  });

  it("renders multi-leg itinerary with mode arrows", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:05:00Z",
          durationSeconds: 300,
        },
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:05:00Z",
          arrivalTime: "2026-03-03T10:20:00Z",
          durationSeconds: 900,
          routeShortName: "7",
        },
      ],
      transfers: 0,
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.getByLabelText("Walk")).toBeInTheDocument();
    expect(screen.getByLabelText("Bus")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("renders transit leg with colored route badge using routeColor", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "99",
          routeColor: "#e63946",
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const badge = screen.getByTestId("route-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveStyle({ backgroundColor: "#e63946" });
    expect(screen.getByText("99")).toBeInTheDocument();
  });

  it("renders walk leg badge with duration in minutes", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:07:00Z",
          durationSeconds: 420,
        },
      ],
      transfers: 0,
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const badge = screen.getByTestId("route-badge");
    expect(badge).toBeInTheDocument();
    expect(screen.getByText("7 min")).toBeInTheDocument();
  });

  it("uses chevron arrows between multi-leg badges", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "WALK",
          from: { name: "Origin", location: { lat: 0, lon: 0 } },
          to: { name: "Stop A", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:05:00Z",
          durationSeconds: 300,
        },
        {
          mode: "BUS",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:05:00Z",
          arrivalTime: "2026-03-03T10:20:00Z",
          durationSeconds: 900,
          routeShortName: "7",
        },
      ],
      transfers: 0,
    });
    const { container } = render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    // chevron › (U+203A) or › should appear between legs
    const chevrons = container.querySelectorAll("[data-testid='leg-chevron']");
    expect(chevrons.length).toBe(1);
  });

  it("shows eco-score when legs have distance data with savings", () => {
    const itinerary = makeItinerary({
      legs: [
        {
          mode: "TRAM",
          from: { name: "Stop A", location: { lat: 0, lon: 0 } },
          to: { name: "Stop B", location: { lat: 0, lon: 0 } },
          departureTime: "2026-03-03T10:00:00Z",
          arrivalTime: "2026-03-03T10:15:00Z",
          durationSeconds: 900,
          routeShortName: "3",
          distanceMeters: 5000,
        },
      ],
    });
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    const ecoEl = screen.getByTestId("eco-score");
    expect(ecoEl).toBeInTheDocument();
    // Tram: 5km * 20 = 100g, Car: 5km * 120 = 600g, savings = 83%
    expect(ecoEl.textContent).toContain("83%");
  });

  it("does not show eco-score when legs have no distance data", () => {
    const itinerary = makeItinerary();
    render(
      <BrowserRouter>
        <RouteResults itineraries={[itinerary]} onSelect={() => {}} />
      </BrowserRouter>
    );
    expect(screen.queryByTestId("eco-score")).not.toBeInTheDocument();
  });
});

describe("RouteResults — Save this pair", () => {
  const origin: BaseEndpoint = {
    kind: "stop",
    stopId: "O",
    name: "Origin Stop",
    lat: 0,
    lon: 0,
  };
  const destination: BaseEndpoint = {
    kind: "stop",
    stopId: "D",
    name: "Dest Stop",
    lat: 1,
    lon: 1,
  };

  beforeEach(async () => {
    await resetPersonalStorage();
    usePrivacyStore.getState().reset();
    vi.spyOn(window, "prompt").mockReturnValue("");
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("hides the save-pair button when origin is missing", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          destination={destination}
        />
      </BrowserRouter>,
    );
    expect(
      screen.queryByRole("button", { name: /save this pair/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the save-pair button when destination is missing", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
        />
      </BrowserRouter>,
    );
    expect(
      screen.queryByRole("button", { name: /save this pair/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the save-pair button when there are no itineraries", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    expect(
      screen.queryByRole("button", { name: /save this pair/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the save-pair button when both endpoints are defined", () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    expect(
      screen.getByRole("button", { name: /save this pair/i }),
    ).toBeInTheDocument();
  });

  it("writes a savedLocations row when the button is clicked", async () => {
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    const saveBtn = screen.getByRole("button", { name: /save this pair/i });
    fireEvent.click(saveBtn);
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(1);
    });
    const [save] = await listSaves();
    expect(save!.destination).toEqual(destination);
    await waitFor(() => {
      expect(saveBtn).toBeDisabled();
    });
    expect(saveBtn.textContent).toMatch(/saved/i);
  });

  it("uses the prompt value as the alias", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Home → Work");
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /save this pair/i }));
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(1);
    });
    const [save] = await listSaves();
    expect(save!.alias).toBe("Home → Work");
  });

  it("offers no per-save encryption switch at any level", async () => {
    for (const level of ["baseline", "standard", "hardened"] as const) {
      await usePrivacyStore.getState().setLevel(level, { confirm: () => true });
      const view = render(
        <BrowserRouter>
          <RouteResults
            itineraries={[makeItinerary()]}
            onSelect={() => {}}
            origin={origin}
            destination={destination}
          />
        </BrowserRouter>,
      );
      expect(screen.queryByTestId("save-pair-sensitive")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("stores the pair sealed at Baseline and says so after saving", async () => {
    await usePrivacyStore.getState().setLevel("baseline", { confirm: () => true });
    vi.spyOn(window, "prompt").mockReturnValue("Clinic");
    render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          origin={origin}
          destination={destination}
        />
      </BrowserRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /save this pair/i }));
    await waitFor(async () => {
      expect(await db.savedLocations.count()).toBe(1);
    });
    const raw = await rawTableText("savedLocations");
    expect(findLeaks(raw, ["Origin Stop", "Dest Stop", "Clinic"])).toEqual([]);
    expect(await screen.findByTestId("saved-storage-note")).toHaveTextContent(
      "Saved places and history are encrypted on this device.",
    );
  });
});

describe("RouteResults — appearance shortcut placement", () => {
  it("puts the Appearance link below the results, not above the first card", () => {
    const { container } = render(
      <BrowserRouter>
        <RouteResults
          itineraries={[makeItinerary()]}
          onSelect={() => {}}
          onEarlier={() => {}}
          onLater={() => {}}
        />
      </BrowserRouter>,
    );
    const link = screen.getByRole("link", { name: /appearance/i });
    const firstCard = screen.getAllByTestId("itinerary-card")[0];
    // It used to own a full-width row at the top of the list, costing a row of
    // result space on every search for a control almost nobody taps.
    expect(
      firstCard.compareDocumentPosition(link) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // …and it sits after the pagination controls, which are the footer's
    // primary action.
    const later = screen.getByRole("button", { name: /later/i });
    expect(
      later.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it("renders no appearance row at all when there are no results", () => {
    render(
      <BrowserRouter>
        <RouteResults itineraries={[]} onSelect={() => {}} />
      </BrowserRouter>,
    );
    expect(screen.queryByRole("link", { name: /appearance/i })).toBeNull();
  });
});

it("renders and selects a walk-only candidate", () => {
 const itinerary=makeItinerary({legs:[{
  mode:"WALK",from:{name:"Origin",location:{lat:54.68,lon:25.28}},
  to:{name:"Destination",location:{lat:54.68,lon:25.2801}},
  departureTime:"2026-03-03T10:00:00Z",arrivalTime:"2026-03-03T10:00:10Z",durationSeconds:10,distanceMeters:15,
 }],durationSeconds:10,walkingDistanceMeters:15});
 const onSelect=vi.fn();
 render(<BrowserRouter><RouteResults itineraries={[itinerary]} onSelect={onSelect}/></BrowserRouter>);
 fireEvent.click(screen.getByTestId("itinerary-card"));
 expect(onSelect).toHaveBeenCalledWith(itinerary);
});
