import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StepList } from "../../src/components/Guidance/StepList.tsx";
import { useGuidanceStore } from "../../src/stores/guidanceStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { lineThreeIndex } from "../helpers/lineThreeIndex.ts";
import { I18nContext } from "../../src/i18n/index.ts";
import type { Itinerary } from "@pt/shared";
import type { ReactNode } from "react";
import { place, ride, walk, itinerary as makeItinerary } from "./shared-fixtures.ts";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const mockItinerary: Itinerary = {
  legs: [
    {
      mode: "WALK",
      from: { name: "Origin", location: { lat: 0, lon: 0 } },
      to: { name: "Stop A", location: { lat: 0, lon: 0 } },
      departureTime: "2026-03-28T10:00:00Z",
      arrivalTime: "2026-03-28T10:05:00Z",
      durationSeconds: 300,
      distanceMeters: 400,
    },
    {
      mode: "TRAM",
      from: { name: "Stop A", location: { lat: 0, lon: 0 } },
      to: { name: "Stop B", location: { lat: 0, lon: 0 } },
      departureTime: "2026-03-28T10:08:00Z",
      arrivalTime: "2026-03-28T10:20:00Z",
      durationSeconds: 720,
      routeShortName: "2",
      headsign: "Central Station",
      intermediateStops: 4,
    },
    {
      mode: "WALK",
      from: { name: "Stop B", location: { lat: 0, lon: 0 } },
      to: { name: "Destination", location: { lat: 0, lon: 0 } },
      departureTime: "2026-03-28T10:20:00Z",
      arrivalTime: "2026-03-28T10:25:00Z",
      durationSeconds: 300,
      distanceMeters: 350,
    },
  ],
  departureTime: "2026-03-28T10:00:00Z",
  arrivalTime: "2026-03-28T10:25:00Z",
  durationSeconds: 1500,
  transfers: 1,
  walkingDistanceMeters: 750,
};

describe("StepList", () => {
  beforeEach(() => {
    useGuidanceStore.getState().reset();
  });

  it("renders nothing when not navigating", () => {
    const { container } = render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders all legs when navigating", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    // Should have the step list container
    expect(screen.getByTestId("guidance-step-list")).toBeInTheDocument();
    // Should show the tram route badge
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/Central Station/)).toBeInTheDocument();
  });

  it("calls onLegTap when tapping a leg", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    const onLegTap = vi.fn();
    render(
      <StepList onLegTap={onLegTap} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    const buttons = screen.getAllByRole("button");
    // Find the button containing "Central Station"
    const legButton = buttons.find((b) => b.textContent?.includes("Central Station"));
    if (legButton) fireEvent.click(legButton);
    expect(onLegTap).toHaveBeenCalled();
  });

  it("calls onClose when tapping close", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    const onClose = vi.fn();
    render(
      <StepList onLegTap={() => {}} onClose={onClose} />,
      { wrapper: Wrapper }
    );
    const closeBtn = screen.getByLabelText("Stop navigation");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the step list container when navigating", () => {
    useGuidanceStore.getState().startNavigation(mockItinerary);
    render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId("guidance-step-list")).toBeInTheDocument();
  });
});

describe("StepList — keyboard", () => {
  beforeEach(() => {
    useGuidanceStore.getState().reset();
  });

  function legButtons(): HTMLElement[] {
    return screen.getAllByRole("button").filter((b) => b.closest("[data-testid='guidance-step-list'] .overflow-y-auto"));
  }

  it("moves between leg rows with the arrow keys", () => {
    useGuidanceStore.setState({
      phase: "navigating",
      itinerary: mockItinerary,
      currentLegIndex: 0,
      legStatuses: ["current", "upcoming", "future"],
    });
    render(<StepList onLegTap={() => {}} onClose={() => {}} />, { wrapper: Wrapper });
    const rows = legButtons();
    expect(rows).toHaveLength(3);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("follows the rider: focus moves to the new current leg", () => {
    useGuidanceStore.setState({
      phase: "navigating",
      itinerary: mockItinerary,
      currentLegIndex: 0,
      legStatuses: ["current", "upcoming", "future"],
    });
    render(<StepList onLegTap={() => {}} onClose={() => {}} />, { wrapper: Wrapper });
    act(() => {
      useGuidanceStore.setState({ currentLegIndex: 1, legStatuses: ["completed", "current", "upcoming"] });
    });
    expect(document.activeElement).toBe(legButtons()[1]);
  });
});

describe("StepList — pre-stop buffer hint and banner", () => {
  beforeEach(() => {
    useGuidanceStore.getState().reset();
    // Reset settings to defaults: profile "default" → 180s buffer.
    useSettingsStore.setState({
      mobilityProfile: "default",
      leaveBufferOverrideSeconds: null,
    } as never);
    // Pin the wall-clock so serverTime.now() (which falls back to Date.now()
    // pre-sync) is deterministic. StepList reads serverTime.now() once per
    // itinerary identity inside a useMemo, so seeding Date.now is enough.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders LeaveHint when there is a pre-stop buffer", () => {
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = makeItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:25:00Z", arrive: "2026-04-25T10:30:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:30:00Z", arrive: "2026-04-25T10:54:00Z", routeShortName: "42" }),
    ]);
    useGuidanceStore.getState().startNavigation(it);
    render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/min wait at stop/i)).toBeInTheDocument();
  });

  it("renders LeadingWaitBanner when leadingWait exceeds threshold", () => {
    // referenceNow at 10:00, bus at 10:54 → ~51 min leading wait > max(5, 3+2)=5 min
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = makeItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:49:00Z", arrive: "2026-04-25T10:54:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:54:00Z", arrive: "2026-04-25T11:20:00Z", routeShortName: "42" }),
    ]);
    useGuidanceStore.getState().startNavigation(it);
    render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/Next departure in/i)).toBeInTheDocument();
  });

  it("times the walk row from the leave time, not from the search time", () => {
    // Search at 10:00; the planner starts the 4-min walk then and leaves the
    // bus at 10:09. Leave 10:02 (10:09 − 3 min buffer − 4 min walk) → walk
    // 10:02–10:06, matching the LeaveHint above it.
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = makeItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:09:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    useGuidanceStore.getState().startNavigation(it);
    render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    const tz = useCityStore.getState().activeCity.tz;
    const fmt = (iso: string) =>
      new Date(iso).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) });
    expect(screen.getByText(fmt("2026-04-25T10:02:00Z"))).toBeInTheDocument();
    expect(screen.getByText(fmt("2026-04-25T10:06:00Z"))).toBeInTheDocument();
    expect(screen.queryByText(fmt("2026-04-25T10:04:00Z"))).toBeNull();
  });

  it("tells the rider to hurry when run-to-catch is on and only a run makes it", () => {
    // 10:00: 8-min walk lands 10:08, after the 10:06 bus; a 4-min run lands 10:04.
    useSettingsStore.setState({ runToCatch: true, walkSpeedMps: 1.25 } as never);
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = makeItinerary([
      { ...walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }), runToCatch: true },
      ride({ from: B, to: C, depart: "2026-04-25T10:06:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    useGuidanceStore.getState().startNavigation(it);
    render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText(/walk fast or run to make it/i)).toBeInTheDocument();
    useSettingsStore.setState({ runToCatch: false } as never);
  });

  it("keeps time while it is open: the leave hint turns into a miss", () => {
    // 10:00, 4-min walk to a 10:09 bus: leave 10:02. At 10:07 no walk makes it.
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = makeItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:09:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    useGuidanceStore.getState().startNavigation(it);
    render(<StepList onLegTap={() => {}} onClose={() => {}} />, { wrapper: Wrapper });
    expect(screen.getByText(/3 min wait at stop/i)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(7 * 60_000);
    });
    expect(screen.getByText(/likely miss this departure/i)).toBeInTheDocument();
  });

  it("gives the trip's length from the leave time in the header", () => {
    // 10:00, 4-min walk to a 10:09 bus arriving 10:30: leave 10:02 → 28 min.
    const A = place("Home"), B = place("Stop A"), C = place("Office");
    const it = makeItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:04:00Z" }),
      ride({ from: B, to: C, depart: "2026-04-25T10:09:00Z", arrive: "2026-04-25T10:30:00Z", routeShortName: "42" }),
    ]);
    useGuidanceStore.getState().startNavigation(it);
    render(<StepList onLegTap={() => {}} onClose={() => {}} />, { wrapper: Wrapper });
    expect(screen.getByText("28 min")).toBeInTheDocument();
  });

  it("offers the next departure of the line once this one is lost", () => {
    const realCity = useCityStore.getState().activeCity;
    useCityStore.setState({ activeCity: { ...realCity, tz: "UTC" } });
    useGtfsDataStore.setState({ raptorIndex: lineThreeIndex });
    vi.setSystemTime(new Date("2026-09-25T07:58:00Z"));
    try {
      const it = makeItinerary([
        walk({ from: place("Home"), to: place("Stop 1", 0, 0, "S1"), depart: "2026-09-25T07:55:00Z", arrive: "2026-09-25T07:59:00Z" }),
        { ...ride({ from: place("Stop 1", 0, 0, "S1"), to: place("Stop 2", 0, 0, "S2"), depart: "2026-09-25T08:00:00Z", arrive: "2026-09-25T08:10:00Z", routeShortName: "3" }), tripId: "T800", routeId: "R3" },
      ]);
      // Seeded directly: startNavigation would poll line 3's live data.
      useGuidanceStore.setState({ phase: "navigating", itinerary: it, currentLegIndex: 0, legStatuses: ["current", "future"] });
      render(<StepList onLegTap={() => {}} onClose={() => {}} />, { wrapper: Wrapper });
      expect(screen.getByText("You'll likely miss this departure · next in ~12 min")).toBeInTheDocument();
    } finally {
      useCityStore.setState({ activeCity: realCity });
      useGtfsDataStore.setState({ raptorIndex: null });
    }
  });

  it("hides buffer chrome when itinerary has no transit (walk-only)", () => {
    const A = place("Home"), B = place("Cafe");
    const it = makeItinerary([
      walk({ from: A, to: B, depart: "2026-04-25T10:00:00Z", arrive: "2026-04-25T10:05:00Z" }),
    ]);
    useGuidanceStore.getState().startNavigation(it);
    render(
      <StepList onLegTap={() => {}} onClose={() => {}} />,
      { wrapper: Wrapper }
    );
    expect(screen.queryByText(/min wait at stop/i)).toBeNull();
    expect(screen.queryByText(/Next departure in/i)).toBeNull();
  });
});
