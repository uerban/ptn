import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TripSheet, TRIP_SHEET_TICK_MS } from "../../src/components/TripSheet/TripSheet.tsx";
import { ETACards } from "../../src/components/Map/ETACards.tsx";
import { I18nContext } from "../../src/i18n/index.ts";
import en from "../../src/i18n/locales/en.json";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { CITIES } from "../../src/config/cities.ts";
import type { RaptorIndex, RaptorIndexRoute } from "../../src/services/raptorIndex.ts";
import type { Side } from "../../src/services/nearbyDirections.ts";
import { polledRoutes as polled } from "../helpers/rtPollerRoutes.ts";
import type { Departure, StopWithLines } from "@pt/shared";
import type { ComponentProps, ReactNode } from "react";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

const VILNIUS = CITIES.find((c) => c.id === "vilnius")!;

// Line 5: Alpha 08:00, Bravo 08:02, Station 08:04, Charlie 08:06, Delta 08:10
// (Vilnius wall clock; June 2026 = EEST, UTC+3). The rider boards at Station.
const LINE: RaptorIndexRoute = {
  id: "r1",
  shortName: "5",
  mode: "BUS",
  stopIds: ["A", "B", "S", "C", "D"],
  trips: [{ tripId: "t1", serviceId: "ALL", headsign: "Centre", departureSecs: [28800, 28920, 29040, 29160, 29400] }],
};
const INDEX = { patterns: [LINE] } as unknown as RaptorIndex;
const NAMES = new Map([
  ["A", "Alpha"],
  ["B", "Bravo"],
  ["S", "Station"],
  ["C", "Charlie"],
  ["D", "Delta"],
]);

const STOP: StopWithLines = { id: "S", name: "Station", location: { lat: 54.687, lon: 25.279 }, lastSeen: 0 };

function departure(overrides: Partial<Departure> = {}): Departure {
  return {
    routeId: "r1",
    routeShortName: "5",
    routeColor: "e53935",
    mode: "BUS",
    headsign: "Centre",
    scheduledTime: "2026-06-10T05:04:00.000Z",
    tripId: "t1",
    ...overrides,
  };
}

type Props = ComponentProps<typeof TripSheet>;

function renderSheet(overrides: Partial<Props> = {}) {
  const props: Props = {
    departure: departure(),
    stop: STOP,
    onClose: vi.fn(),
    onAllDepartures: vi.fn(),
    onShowOnMap: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<TripSheet {...props} />, { wrapper: Wrapper }) };
}

/** Seed live RT for trip t1 under its own route, the one the sheet retains. */
function seedLive(update: { delaySeconds: number; cancelled?: boolean; deleted?: boolean }) {
  useRtStore.setState({
    updates: new Map([["r1", [{ tripId: "t1", cancelled: false, ...update }]]]),
  });
}

const vehicleRow = () => screen.queryByTestId("trip-vehicle");

beforeEach(() => {
  vi.useFakeTimers();
  // 08:01:20 in Vilnius: past Alpha, 40 s before Bravo.
  vi.setSystemTime(new Date("2026-06-10T05:01:20Z"));
  vi.spyOn(useRtStore.getState().poller, "start").mockImplementation(() => {});
  useRtStore.getState().unsubscribeAll();
  useRtStore.setState({ updates: new Map() });
  useGtfsDataStore.setState({ raptorIndex: INDEX, stopNames: NAMES });
  useCityStore.setState({ activeCity: VILNIUS });
});

afterEach(() => {
  useRtStore.getState().unsubscribeAll();
  useGtfsDataStore.setState({ raptorIndex: null, stopNames: null });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TripSheet — header", () => {
  it("is a dialog named after the line and headsign", () => {
    renderSheet();
    expect(screen.getByRole("dialog", { name: "Line 5 toward Centre" })).toBeInTheDocument();
  });

  it("shows the line badge, headsign, boarding stop and countdown", () => {
    renderSheet();
    const header = screen.getByTestId("trip-header");
    expect(within(header).getByTestId("route-badge")).toHaveTextContent("5");
    expect(within(header).getByText("Centre")).toBeInTheDocument();
    expect(within(header).getByTestId("trip-boarding-stop")).toHaveTextContent("Station");
    // 08:04:00 − 08:01:20 → 3 min (rounded up, like every countdown).
    expect(within(header).getByTestId("trip-countdown")).toHaveTextContent("3 min");
  });

  it("colours the badge as the pill it was opened from does: a mode colour override beats the feed colour", () => {
    const before = useSettingsStore.getState().modeColorOverrides;
    useSettingsStore.setState({ modeColorOverrides: { ...before, vilnius: { BUS: "#123456" } } });
    try {
      const side: Side = { stopId: "S", routeId: "r1", dirKey: "d0", row: "top" };
      render(
        <ETACards
          sides={[side]}
          departuresBySide={new Map([[side, [departure()]]])}
          nearestStop={STOP}
          stopInfo={new Map([["S", { stop: STOP, distanceM: 10 }]])}
          loading={false}
          layout="rows"
          onSelect={vi.fn()}
        />,
        { wrapper: Wrapper },
      );
      renderSheet();
      const pillBadge = screen.getByTestId("eta-route-badge");
      const sheetBadge = within(screen.getByTestId("trip-header")).getByTestId("route-badge");
      // The departure's feed colour is e53935; the rider's bus colour wins on both.
      expect(pillBadge.style.background).toBe("rgb(18, 52, 86)");
      expect(sheetBadge.style.background).toBe(pillBadge.style.background);
      expect(sheetBadge.style.color).toBe(pillBadge.style.color);
    } finally {
      useSettingsStore.setState({ modeColorOverrides: before });
    }
  });

  it("shows the timetable chip without a delay and the live delay with one", () => {
    const { unmount } = renderSheet();
    expect(within(screen.getByTestId("trip-header")).getByText("SCHED")).toBeInTheDocument();
    unmount();

    seedLive({ delaySeconds: 120 });
    renderSheet();
    const header = screen.getByTestId("trip-header");
    expect(within(header).getByText("+2 min")).toBeInTheDocument();
    // The countdown follows the delay: 08:06:00 − 08:01:20 → 5 min.
    expect(within(header).getByTestId("trip-countdown")).toHaveTextContent("5 min");
  });

  it("reads Due once the departure is at hand", () => {
    vi.setSystemTime(new Date("2026-06-10T05:04:00Z"));
    renderSheet();
    expect(screen.getByTestId("trip-countdown")).toHaveTextContent("Due");
  });

  it("drops the countdown once the departure is past the cutoff, like a pill", () => {
    // 08:04:00 + 119 s still rounds up to −1 min (Due); + 120 s is −2 min, gone.
    vi.setSystemTime(new Date("2026-06-10T05:05:59Z"));
    const { unmount } = renderSheet();
    expect(screen.getByTestId("trip-countdown")).toHaveTextContent("Due");
    unmount();

    vi.setSystemTime(new Date("2026-06-10T05:06:00Z"));
    renderSheet();
    expect(screen.queryByTestId("trip-countdown")).toBeNull();
    expect(screen.getByTestId("trip-boarding-stop")).toHaveTextContent("Station");
  });
});

describe("TripSheet — stops", () => {
  it("collapses the earlier stops behind a count and expands them on demand", () => {
    renderSheet();
    const toggle = screen.getByRole("button", { name: "2 earlier stops" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const names = () => screen.getAllByTestId("trip-stop").map((li) => li.getAttribute("data-stop-id"));
    expect(names()).toEqual(["S", "C", "D"]);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(names()).toEqual(["A", "B", "S", "C", "D"]);

    fireEvent.click(toggle);
    expect(names()).toEqual(["S", "C", "D"]);
  });

  it("uses the singular for one earlier stop and no toggle at the first stop", () => {
    const { unmount } = renderSheet({ stop: { ...STOP, id: "B", name: "Bravo" }, departure: departure({ scheduledTime: "2026-06-10T05:02:00.000Z" }) });
    expect(screen.getByRole("button", { name: "1 earlier stop" })).toBeInTheDocument();
    unmount();

    renderSheet({ stop: { ...STOP, id: "A", name: "Alpha" }, departure: departure({ scheduledTime: "2026-06-10T05:00:00.000Z" }) });
    expect(screen.queryByRole("button", { name: /earlier stop/ })).toBeNull();
  });

  it("highlights the boarding stop", () => {
    renderSheet();
    const boarding = screen.getAllByTestId("trip-stop").filter((li) => li.getAttribute("aria-current"));
    expect(boarding).toHaveLength(1);
    expect(boarding[0]).toHaveAttribute("aria-current", "location");
    expect(boarding[0]).toHaveAttribute("data-stop-id", "S");
  });

  it("lists each stop's time in the city zone, shifted by the delay", () => {
    seedLive({ delaySeconds: 120 });
    renderSheet();
    const station = screen.getAllByTestId("trip-stop").find((li) => li.getAttribute("data-stop-id") === "S")!;
    // 08:04 scheduled + 2 min, read in Vilnius (the device zone is irrelevant).
    expect(station).toHaveTextContent(/08:06/);
    expect(station).toHaveTextContent("Station");
  });
});

describe("TripSheet — estimated vehicle", () => {
  it("between two stops", () => {
    renderSheet();
    expect(vehicleRow()).toHaveTextContent("Probably between Alpha and Bravo");
  });

  it("at a stop", () => {
    vi.setSystemTime(new Date("2026-06-10T05:04:10Z"));
    renderSheet();
    expect(vehicleRow()).toHaveTextContent("Probably at Station");
  });

  it("not started yet", () => {
    vi.setSystemTime(new Date("2026-06-10T04:55:00Z"));
    renderSheet();
    expect(vehicleRow()).toHaveTextContent(/^Not started — leaves Alpha at 08:00/);
  });

  it("finished", () => {
    vi.setSystemTime(new Date("2026-06-10T05:11:00Z"));
    renderSheet();
    expect(vehicleRow()).toHaveTextContent("Trip probably ended");
  });

  it("moves with the live delay from the RT store, which wins over the pill's", () => {
    // +180 s: Alpha is at 08:03, still 100 s ahead.
    seedLive({ delaySeconds: 180 });
    renderSheet({ departure: departure({ delaySeconds: 0 }) });
    expect(vehicleRow()).toHaveTextContent(/^Not started — leaves Alpha at 08:03/);
  });

  it("uses the pill's delay when the RT store has none", () => {
    renderSheet({ departure: departure({ delaySeconds: 180, predictedTime: "2026-06-10T05:07:00.000Z" }) });
    expect(vehicleRow()).toHaveTextContent(/^Not started — leaves Alpha at 08:03/);
  });

  it("derives the pill's delay from its predicted time when no delay is carried", () => {
    renderSheet({ departure: departure({ predictedTime: "2026-06-10T05:07:00.000Z" }) });
    expect(vehicleRow()).toHaveTextContent(/^Not started — leaves Alpha at 08:03/);
    expect(screen.getByTestId("trip-source")).toHaveTextContent("Estimated from timetable + live delay");
  });

  it("says timetable without a delay, live delay with one from either source", () => {
    const { unmount } = renderSheet();
    expect(screen.getByTestId("trip-source")).toHaveTextContent(/^Estimated from timetable$/);
    unmount();

    const pill = renderSheet({ departure: departure({ delaySeconds: 60 }) });
    expect(screen.getByTestId("trip-source")).toHaveTextContent("Estimated from timetable + live delay");
    pill.unmount();

    seedLive({ delaySeconds: 0 });
    renderSheet();
    expect(screen.getByTestId("trip-source")).toHaveTextContent("Estimated from timetable + live delay");
  });

  describe("the vehicle's dot in the stop list", () => {
    const marker = () => screen.queryAllByTestId("trip-vehicle-marker");
    const stopRow = (id: string) =>
      screen.getAllByTestId("trip-stop").find((li) => li.getAttribute("data-stop-id") === id)!;
    const expand = () => fireEvent.click(screen.getByRole("button", { name: /earlier stop/ }));

    it("approaching the boarding stop: just above it, earlier stops folded or not", () => {
      // 08:03:00: left Bravo (08:02), not yet at Station (08:04).
      vi.setSystemTime(new Date("2026-06-10T05:03:00Z"));
      renderSheet();
      expect(vehicleRow()).toHaveTextContent("Probably between Bravo and Station");
      expect(marker()).toHaveLength(1);
      expect(stopRow("S").previousElementSibling).toBe(screen.getByTestId("trip-vehicle-between"));

      expand();
      expect(marker()).toHaveLength(1);
      expect(stopRow("S").previousElementSibling).toBe(screen.getByTestId("trip-vehicle-between"));
      expect(stopRow("B").nextElementSibling).toBe(screen.getByTestId("trip-vehicle-between"));
    });

    it("between two later stops: after the stop it left", () => {
      // 08:05:00: left Station (08:04), not yet at Charlie (08:06).
      vi.setSystemTime(new Date("2026-06-10T05:05:00Z"));
      renderSheet();
      expect(marker()).toHaveLength(1);
      expect(stopRow("S").nextElementSibling).toBe(screen.getByTestId("trip-vehicle-between"));
    });

    it("further back among the folded stops: none until they are shown", () => {
      // 08:01:20: between Alpha and Bravo, both folded away.
      renderSheet();
      expect(marker()).toHaveLength(0);
      expand();
      expect(marker()).toHaveLength(1);
      expect(stopRow("A").nextElementSibling).toBe(screen.getByTestId("trip-vehicle-between"));
    });

    it("at a stop: in that stop's row, once it is shown", () => {
      vi.setSystemTime(new Date("2026-06-10T05:04:10Z"));
      const { unmount } = renderSheet();
      expect(marker()).toHaveLength(1);
      expect(within(stopRow("S")).getByTestId("trip-vehicle-marker")).toBeInTheDocument();
      unmount();

      // At Bravo, folded: no dot; unfolded: in Bravo's row.
      vi.setSystemTime(new Date("2026-06-10T05:02:10Z"));
      renderSheet();
      expect(marker()).toHaveLength(0);
      expand();
      expect(within(stopRow("B")).getByTestId("trip-vehicle-marker")).toBeInTheDocument();
      expect(screen.queryByTestId("trip-vehicle-between")).toBeNull();
    });
  });

  it("never claims a live position, in any state", () => {
    const instants = ["2026-06-10T04:55:00Z", "2026-06-10T05:01:20Z", "2026-06-10T05:04:10Z", "2026-06-10T05:11:00Z"];
    for (const instant of instants) {
      for (const live of [undefined, { delaySeconds: 60 }]) {
        vi.setSystemTime(new Date(instant));
        useRtStore.setState({ updates: new Map() });
        if (live) seedLive(live);
        const { container, unmount } = renderSheet();
        fireEvent.click(screen.getByRole("button", { name: /earlier stop/ }));
        expect(container.innerHTML).not.toMatch(/live position/i);
        unmount();
      }
    }
  });

  it("never claims a live position in the shipped English copy either", () => {
    // The fallbacks above are the component's; this renders en.json itself.
    const english = en as Record<string, string>;
    const t = (key: string, fallback?: string) => english[key] ?? fallback ?? key;
    const instants = ["2026-06-10T04:55:00Z", "2026-06-10T05:01:20Z", "2026-06-10T05:04:10Z", "2026-06-10T05:11:00Z"];
    for (const instant of instants) {
      for (const live of [undefined, { delaySeconds: 60 }, { delaySeconds: 0, cancelled: true }, { delaySeconds: 0, deleted: true }]) {
        vi.setSystemTime(new Date(instant));
        useRtStore.setState({ updates: new Map() });
        if (live) seedLive(live);
        const { container, unmount } = render(
          <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t }}>
            <TripSheet departure={departure()} stop={STOP} onClose={vi.fn()} onAllDepartures={vi.fn()} onShowOnMap={vi.fn()} />
          </I18nContext.Provider>,
        );
        const earlier = screen.queryByRole("button", { name: /earlier stop/ });
        if (earlier) fireEvent.click(earlier);
        expect(container.innerHTML).not.toMatch(/live position/i);
        unmount();
      }
    }
    for (const [key, value] of Object.entries(english)) {
      if (key.startsWith("trip.")) expect(value, key).not.toMatch(/live position/i);
    }
  });

  it("recomputes on a 15 s tick", () => {
    expect(TRIP_SHEET_TICK_MS).toBe(15_000);
    renderSheet();
    expect(vehicleRow()).toHaveTextContent("Probably between Alpha and Bravo");
    // 08:01:34: inside Bravo's 30 s window, but no tick yet.
    act(() => {
      vi.advanceTimersByTime(14_000);
    });
    expect(vehicleRow()).toHaveTextContent("Probably between Alpha and Bravo");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(vehicleRow()).toHaveTextContent("Probably at Bravo");
  });
});

describe("TripSheet — cancelled and removed", () => {
  /** The header's live-status chip, in any of its states. */
  const liveChip = () =>
    within(screen.getByTestId("trip-header")).queryByText(/^(SCHED|ON TIME|\+\d+ min|\d+ min early)$/);

  it("a cancelled trip shows a neutral banner and no vehicle estimate", () => {
    seedLive({ delaySeconds: 0, cancelled: true });
    renderSheet();
    const banner = screen.getByTestId("trip-banner");
    expect(banner).toHaveTextContent("This trip is cancelled");
    expect(banner.className).not.toMatch(/danger/);
    expect(vehicleRow()).toBeNull();
    expect(screen.queryByTestId("trip-source")).toBeNull();
    expect(screen.queryByTestId("trip-vehicle-marker")).toBeNull();
    expect(liveChip()).toBeNull();
  });

  it("a deleted trip reads as removed, not cancelled", () => {
    seedLive({ delaySeconds: 0, cancelled: true, deleted: true });
    renderSheet();
    const banner = screen.getByTestId("trip-banner");
    expect(banner).toHaveTextContent("This trip is no longer scheduled");
    expect(screen.queryByText(/cancelled/i)).toBeNull();
    expect(banner.className).not.toMatch(/danger/);
    expect(vehicleRow()).toBeNull();
    expect(liveChip()).toBeNull();
  });

  it("the pill's own cancelled flag is enough, without live data", () => {
    renderSheet({ departure: departure({ cancelled: true }) });
    expect(screen.getByTestId("trip-banner")).toHaveTextContent("This trip is cancelled");
    expect(vehicleRow()).toBeNull();
    expect(screen.queryByTestId("trip-source")).toBeNull();
    expect(liveChip()).toBeNull();
  });

  it("the live chip itself shows for a trip that runs (control)", () => {
    seedLive({ delaySeconds: 0 });
    renderSheet();
    expect(liveChip()).toHaveTextContent("ON TIME");
  });

  it("follows an RT update that arrives while open", () => {
    renderSheet();
    expect(screen.queryByTestId("trip-banner")).toBeNull();
    act(() => seedLive({ delaySeconds: 0, cancelled: true }));
    expect(screen.getByTestId("trip-banner")).toHaveTextContent("This trip is cancelled");
  });
});

describe("TripSheet — without a timeline", () => {
  it.each([
    ["no index", null],
    ["no patterns", { patterns: undefined } as unknown as RaptorIndex],
  ])("%s → header and actions only", (_, raptorIndex) => {
    useGtfsDataStore.setState({ raptorIndex });
    renderSheet();
    expect(screen.getByTestId("trip-header")).toHaveTextContent("Centre");
    expect(screen.getByTestId("trip-countdown")).toHaveTextContent("3 min");
    expect(screen.getByRole("button", { name: "All departures here" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show on map" })).toBeInTheDocument();
    expect(vehicleRow()).toBeNull();
    expect(screen.queryByTestId("trip-source")).toBeNull();
    expect(screen.queryByTestId("trip-stops")).toBeNull();
  });

  it("a trip missing from the index → header and actions only", () => {
    renderSheet({ departure: departure({ tripId: "unknown" }) });
    expect(screen.getByTestId("trip-header")).toBeInTheDocument();
    expect(vehicleRow()).toBeNull();
    expect(screen.queryByTestId("trip-stops")).toBeNull();
  });
});

describe("TripSheet — actions, closing and live data", () => {
  it("hands the actions and closing back to the caller", () => {
    const { props } = renderSheet();
    fireEvent.click(screen.getByRole("button", { name: "All departures here" }));
    expect(props.onAllDepartures).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    expect(props.onShowOnMap).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus to the close button on open", () => {
    renderSheet();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("holds the trip's route for live data while open and lets go on close", () => {
    const { unmount } = renderSheet();
    expect(polled()).toEqual(["r1"]);
    unmount();
    expect(polled()).toEqual([]);
  });

  it("does not cut off another holder of the same route", () => {
    const release = useRtStore.getState().retainRoutes(["r1"]);
    const { unmount } = renderSheet();
    unmount();
    expect(polled()).toEqual(["r1"]);
    release();
    expect(polled()).toEqual([]);
  });
});
