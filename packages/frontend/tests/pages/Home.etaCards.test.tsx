import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Departure, FavoritePlace, LatLon, StopWithLines } from "@pt/shared";
import { directedPattern, patternIndex } from "../../src/test-helpers/patternIndex.ts";
import { at, LAT0, LON0 } from "../helpers/metreGrid.ts";
import type { Side } from "../../src/services/nearbyDirections.ts";
import type { NearbyDirections, UseNearbyDirectionsArgs } from "../../src/hooks/useNearbyDirections.ts";

/**
 * The ETA strip on the real Home page: it renders what `useNearbyDirections`
 * returns, and Home switches the hook off (no fetch of any kind) while a
 * surface that replaces the strip is up. A pill tap opens the trip sheet,
 * which shares the bottom slot with the other sheets.
 */

// ─── Mutable mock state ──────────────────────────────────────────────────────

const settingsState = vi.hoisted(() => ({
  scheduleMode: false,
  etaCardsEnabled: true,
  etaCardsLayout: "rows",
  startupLocate: false,
  routeSearchVariant: "consumer",
  modeColorOverrides: {},
  accessibilityScheme: "none",
  resolvedTheme: "light",
  highContrastEnabled: false,
}));
const locationState = vi.hoisted(() => ({
  snapshot: { position: null as LatLon | null, speed: null, heading: null, accuracy: null },
  listeners: new Set<() => void>(),
}));
const guidanceState = vi.hoisted(() => ({ phase: "idle" }));
const storeState = vi.hoisted(() => ({
  stops: [] as unknown[],
  visible: [] as unknown[],
  raptorIndex: null as unknown,
}));
const departuresState = vi.hoisted(() => ({
  byStop: new Map<string, { departures: unknown[]; loading: boolean; error: null }>(),
  empty: { departures: [] as unknown[], loading: false, error: null },
}));
// `real` → the actual hook runs over the mocked stores; otherwise `canned`.
const hookState = vi.hoisted(() => ({
  real: false,
  canned: null as unknown,
  off: { nearestStop: null, sides: [], departuresBySide: new Map(), loading: false },
}));
// The latest props of the mocked map, favourites, popup and sheet, to drive
// Home's handlers.
const surfaces = vi.hoisted(() => ({
  map: null as null | Record<string, (...args: unknown[]) => void>,
  favorites: null as null | Record<string, (...args: unknown[]) => void>,
  popup: null as null | Record<string, (...args: unknown[]) => void>,
  sheet: null as null | Record<string, unknown>,
}));
const lineClickState = vi.hoisted(() => ({ openLine: vi.fn(), cancel: vi.fn() }));
const lineViewState = vi.hoisted(() => ({ isVisible: false, activeRouteId: null as string | null }));
const VILNIUS_CITY = vi.hoisted(() => ({ id: "vilnius", name: "Vilnius", tz: "Europe/Vilnius" }));
const cityState = vi.hoisted(() => ({ activeCity: VILNIUS_CITY }));

// ─── Module mocks (same thin set as Home.scheduleMode.test.tsx) ─────────────

vi.mock("../../src/hooks/useNearbyDirections.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/hooks/useNearbyDirections.ts")>();
  return {
    ...actual,
    useNearbyDirections: vi.fn((args: UseNearbyDirectionsArgs) => {
      if (hookState.real) return actual.useNearbyDirections(args);
      // The hook's contract: off, or no position yet → no nearest stop.
      return args.enabled && args.position ? hookState.canned : hookState.off;
    }),
  };
});

vi.mock("../../src/services/scheduleTileReadPath.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/scheduleTileReadPath.ts")>();
  return { ...actual, departuresForStop: vi.fn(), departuresForStops: vi.fn() };
});

// Every read is settled at once: `settledStopId` names the stop asked for.
vi.mock("../../src/hooks/useDepartures.ts", () => ({
  useDepartures: vi.fn((stopId: string | null) => ({
    ...((stopId && departuresState.byStop.get(stopId)) || departuresState.empty),
    settledStopId: stopId,
  })),
}));

vi.mock("../../src/hooks/useVisibleStops.ts", () => ({
  useVisibleStops: () => storeState.visible,
}));

vi.mock("../../src/hooks/useViewportBadgeActivity.ts", () => ({
  useViewportBadgeActivity: () => undefined,
}));

vi.mock("../../src/pages/ScheduleHome.tsx", () => ({
  ScheduleHome: () => <div data-testid="schedule-home-sentinel">ScheduleHome</div>,
}));

vi.mock("../../src/components/Map/TransitMap.tsx", () => ({
  TransitMap: (props: Record<string, (...args: unknown[]) => void>) => {
    surfaces.map = props;
    return <div data-testid="transit-map" />;
  },
}));

vi.mock("maplibre-gl", () => ({ default: {} }));

vi.mock("../../src/components/Map/LineRouteOverlay.tsx", () => ({ LineRouteOverlay: () => null }));
vi.mock("../../src/components/Map/ModeToggle.tsx", () => ({ ModeToggle: () => null }));

vi.mock("../../src/components/Map/StopPopup.tsx", () => ({
  StopPopup: (props: Record<string, (...args: unknown[]) => void>) => {
    surfaces.popup = props;
    return <div data-testid="stop-popup" />;
  },
}));

vi.mock("../../src/components/DepartureSheet/DepartureSheet.tsx", () => ({
  DepartureSheet: (props: Record<string, (...args: unknown[]) => void>) => {
    surfaces.sheet = props;
    return <div data-testid="departure-sheet" />;
  },
}));

vi.mock("../../src/components/Map/RouteOverlay.tsx", () => ({ RouteOverlay: () => null }));
vi.mock("../../src/components/Map/UserPositionMarker.tsx", () => ({ UserPositionMarker: () => null }));
vi.mock("../../src/components/Map/TransferBadge.tsx", () => ({ TransferBadge: () => null }));
vi.mock("../../src/components/Map/MapTapActionSheet.tsx", () => ({ MapTapActionSheet: () => null }));
vi.mock("../../src/components/Favorites/FavoritesBar.tsx", () => ({
  FavoritesBar: (props: Record<string, (...args: unknown[]) => void>) => {
    surfaces.favorites = props;
    return null;
  },
}));
vi.mock("../../src/components/Guidance/StepList.tsx", () => ({ StepList: () => null }));
vi.mock("../../src/components/Guidance/GuidanceAlerts.tsx", () => ({ GuidanceAlerts: () => null }));
vi.mock("../../src/components/Guidance/RiderDashboard.tsx", () => ({ RiderDashboard: () => null }));
vi.mock("../../src/components/Guidance/RiderModePrompt.tsx", () => ({ RiderModePrompt: () => null }));

vi.mock("../../src/stores/stopStore.ts", () => ({
  useStopStore: Object.assign((sel: any) => sel({ stops: storeState.stops }), {
    getState: () => ({ recordTap: vi.fn(), reset: vi.fn() }),
  }),
}));

vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: Object.assign((sel: any) => sel({ activeCity: cityState.activeCity }), {
    getState: () => ({
      setActiveCity: vi.fn(),
      activeCity: cityState.activeCity,
      // The live-data client builds `/api/<city>/rt/<routeId>` from this.
      getApiUrl: () => `/api/${cityState.activeCity.id}`,
    }),
  }),
}));

vi.mock("../../src/stores/gtfsDataStore.ts", () => ({
  useGtfsDataStore: Object.assign((sel: any) => sel({ raptorIndex: storeState.raptorIndex }), {
    getState: () => ({ init: vi.fn(), reset: vi.fn().mockResolvedValue(undefined) }),
  }),
}));

// rtStore, its poller and the privacy store are REAL: the trip sheet's live
// data goes through the same policy check as every other surface.

vi.mock("../../src/stores/favoritesStore.ts", () => ({
  useFavoritesStore: Object.assign(() => undefined, {
    getState: () => ({ migrateLegacyFavorites: vi.fn() }),
  }),
}));

vi.mock("../../src/stores/colorConfigStore.ts", () => ({
  useColorConfigStore: Object.assign(() => undefined, {
    getState: () => ({ fetchForCity: vi.fn() }),
  }),
}));

vi.mock("../../src/stores/guidanceStore.ts", () => ({
  useGuidanceStore: Object.assign((sel: any) => sel({
    phase: guidanceState.phase,
    itinerary: null,
    legStatuses: [],
    currentLegIndex: 0,
    riderTripId: null,
    transitProgress: null,
  }), {
    getState: () => ({
      stopNavigation: vi.fn(),
      exitRiderMode: vi.fn(),
      enterRiderMode: vi.fn(),
    }),
  }),
}));

vi.mock("../../src/stores/lineViewStore.ts", () => ({
  useLineViewStore: Object.assign((sel: any) => sel(lineViewState), {
    getState: () => ({ hideLine: vi.fn(), isVisible: lineViewState.isVisible }),
  }),
}));

vi.mock("../../src/stores/settingsStore.ts", () => ({
  useSettingsStore: (sel: any) => sel(settingsState),
  autoDetectScheduleMode: vi.fn(),
}));

vi.mock("../../src/hooks/useStopPreloader.ts", () => ({ useStopPreloader: () => undefined }));
vi.mock("../../src/hooks/useLineClick.ts", () => ({ useLineClick: () => lineClickState }));
vi.mock("../../src/services/liveLocation.ts", () => ({ liveLocation: { request: vi.fn() } }));
vi.mock("../../src/hooks/useWatchPosition.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useWatchPosition: () => useSyncExternalStore(
    (listener) => { locationState.listeners.add(listener); return () => { locationState.listeners.delete(listener); }; },
    () => locationState.snapshot,
  ) };
});
vi.mock("../../src/hooks/useDeviceHeading.ts", () => ({ useDeviceHeading: () => ({ heading: null }) }));
vi.mock("../../src/hooks/useGuidanceLegProgress.ts", () => ({ useGuidanceLegProgress: () => undefined }));
vi.mock("../../src/hooks/useRiderModeDetection.ts", () => ({
  useRiderModeDetection: () => undefined,
  findStopContextCandidates: () => [],
}));
vi.mock("../../src/hooks/useMapGuidance.ts", () => ({ useMapGuidance: () => ({ zoomToLeg: vi.fn() }) }));
vi.mock("../../src/hooks/useRiderDashboardData.ts", () => ({
  useRiderDashboardData: () => ({ upcomingStops: [], connectingDepartures: [] }),
}));
vi.mock("../../src/config/cities.ts", () => ({
  findNearestCity: () => ({ id: "vilnius", name: "Vilnius" }),
}));
vi.mock("../../src/i18n/index.ts", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    locale: "en",
    formattingLocale: "en",
  }),
}));

import { useNearbyDirections } from "../../src/hooks/useNearbyDirections.ts";
import { departuresForStops } from "../../src/services/scheduleTileReadPath.ts";
import { useBikeShareStore } from "../../src/stores/bikeShareStore.ts";
import { useMapObstaclesStore } from "../../src/stores/mapObstaclesStore.ts";
import { useMapTapStore } from "../../src/stores/mapTapStore.ts";
import { useRtStore } from "../../src/stores/rtStore.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";
import { HomePage } from "../../src/pages/Home.tsx";

// ─── Geometry (metres from the grid origin) and fixtures ────────────────────

// Two-sided street: S on the user's side, R the same-name pole 20 m east.
const S: StopWithLines = { id: "S", name: "Main St", location: at(0), lastSeen: 0 };
const R: StopWithLines = { id: "R", name: "Main St", location: at(0, 20), lastSeen: 0 };
const USER = at(-10);

function dep(routeId: string, tripId: string, headsign: string, mins: number): Departure {
  return {
    routeId,
    routeShortName: routeId,
    mode: "BUS",
    headsign,
    scheduledTime: new Date(Date.now() + mins * 60_000 - 1_000).toISOString(),
    tripId,
  } as Departure;
}

const STREET_INDEX = patternIndex([
  directedPattern("1", ["A", "S", "B"], "t1", 0),
  directedPattern("1", ["B", "R", "A"], "t2", 1),
]);

function cannedStreet(): NearbyDirections {
  const top: Side = { stopId: "S", routeId: "1", dirKey: "d0", row: "top" };
  const bottom: Side = { stopId: "R", routeId: "1", dirKey: "d1", row: "bottom" };
  return {
    nearestStop: S,
    sides: [top, bottom],
    departuresBySide: new Map([
      [top, [dep("1", "t1", "Airport", 3)]],
      [bottom, [{ ...dep("1", "t2", "Centre", 4), routeColor: "e53935" }]],
    ]),
    loading: false,
  };
}

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

/** Re-render with a fresh element: an identical one would let React skip it. */
function rerenderHome(view: ReturnType<typeof renderHome>) {
  view.rerender(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

function geolocate(pos: LatLon) {
  act(() => {
    locationState.snapshot = { ...locationState.snapshot, position: pos };
    locationState.listeners.forEach((listener) => listener());
  });
}

function lastHookArgs(): UseNearbyDirectionsArgs {
  const calls = vi.mocked(useNearbyDirections).mock.calls;
  return calls[calls.length - 1][0];
}

/** Open the stop popup for `stop`, then its "see all" departure sheet. */
function openSheet(stop: StopWithLines) {
  act(() => surfaces.map!.onStopClick(stop));
  act(() => surfaces.popup!.onSeeAll());
}

const tripSheet = () => screen.queryByTestId("trip-sheet");

/**
 * Tap the strip's pill toward `headsign` (Airport leaves from S, Centre from
 * R); the trip sheet is open afterwards, so no closing test passes vacuously.
 */
function tapPill(headsign: "Airport" | "Centre") {
  const pill = screen
    .getAllByTestId("eta-card")
    .find((p) => p.getAttribute("aria-label")!.includes(`toward ${headsign},`));
  fireEvent.click(pill!);
  expect(tripSheet()).toBeTruthy();
}

/** Every `/rt/<routeId>` URL handed to `fetch` so far. */
function rtRequests(): string[] {
  return vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => String(input))
    .filter((url) => url.includes("/rt/"));
}

beforeEach(() => {
  locationState.snapshot = { ...locationState.snapshot, position: null };
  vi.clearAllMocks();
  settingsState.scheduleMode = false;
  settingsState.etaCardsEnabled = true;
  settingsState.etaCardsLayout = "rows";
  guidanceState.phase = "idle";
  storeState.stops = [S, R];
  storeState.visible = [S, R];
  storeState.raptorIndex = null;
  departuresState.byStop = new Map();
  hookState.real = false;
  hookState.canned = cannedStreet();
  surfaces.map = surfaces.favorites = surfaces.popup = surfaces.sheet = null;
  lineViewState.isVisible = false;
  lineViewState.activeRouteId = null;
  // A line load that has not finished yet; tests that need it settled say so.
  lineClickState.openLine.mockReturnValue(new Promise<boolean>(() => {}));
  cityState.activeCity = VILNIUS_CITY;
  useBikeShareStore.getState().disable();
  useBikeShareStore.setState({ stations: [], selectedStationId: null });
  useMapTapStore.getState().clear();
  usePrivacyStore.setState({ level: "standard", overrides: {} });
  resetFlows();
  allowFlow("operator.realtime");
  // jsdom has no RT backend: every request is answered 503 (a failed poll the
  // poller logs and retries on its next tick), and every URL is recorded.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 503 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(departuresForStops).mockImplementation(async ({ stopIds }) =>
    new Map(stopIds.filter((id) => id === "R").map((id) => [id, [dep("1", "t2", "Centre", 4)]])));
});

afterEach(() => {
  useBikeShareStore.setState({ selectedStationId: null });
  useMapTapStore.getState().clear();
  useRtStore.getState().unsubscribeAll();
  usePrivacyStore.setState({ level: "standard", overrides: {} });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Strip from the hook ─────────────────────────────────────────────────────

describe("Home – ETA strip", () => {
  it("renders the hook's sides in two rows, headed with live distances", () => {
    renderHome();
    geolocate(USER);
    const rows = screen.getAllByTestId("eta-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId("eta-card").getAttribute("aria-label"))
      .toBe("Line 1 toward Airport, from Main St, in 3 min");
    expect(within(rows[1]).getByTestId("eta-card").getAttribute("aria-label"))
      .toBe("Line 1 toward Centre, from Main St, in 4 min");
    // S 10 m, R √(10² + 20²) ≈ 22 m from the user.
    expect(screen.getAllByTestId("eta-row-header").map((h) => h.textContent))
      .toEqual(["Main St · 10 m", "Opposite direction · Main St · 22 m"]);

    // Walking on: the headers follow the position (S 30 m, R ≈ 36 m).
    geolocate(at(-30));
    expect(screen.getAllByTestId("eta-row-header").map((h) => h.textContent))
      .toEqual(["Main St · 30 m", "Opposite direction · Main St · 36 m"]);
  });

  it("hands the hook the GPS position and the visible stops", () => {
    renderHome();
    geolocate(USER);
    expect(lastHookArgs()).toEqual({ enabled: true, position: USER, visibleStops: [S, R] });
  });

  it("registers the strip as a map obstacle while it shows", () => {
    renderHome();
    expect(useMapObstaclesStore.getState().obstacles.has("eta-cards")).toBe(false);
    geolocate(USER);
    expect(useMapObstaclesStore.getState().obstacles.has("eta-cards")).toBe(true);
    act(() => surfaces.map!.onStopClick(S));
    expect(useMapObstaclesStore.getState().obstacles.has("eta-cards")).toBe(false);
  });

  it("hides the strip while the stop popup is open, keeping the hook enabled", () => {
    renderHome();
    geolocate(USER);
    act(() => surfaces.map!.onStopClick(S));
    expect(screen.getByTestId("stop-popup")).toBeTruthy();
    expect(screen.queryByTestId("eta-cards")).toBeNull();
    expect(lastHookArgs().enabled).toBe(true);

    act(() => surfaces.popup!.onClose());
    expect(screen.getByTestId("eta-cards")).toBeTruthy();
  });

  it("lays the strip out as the etaCardsLayout setting says", () => {
    settingsState.etaCardsLayout = "columns";
    const view = renderHome();
    geolocate(USER);
    const grid = screen.getByTestId("eta-columns");
    expect(within(grid).getAllByTestId("eta-card")).toHaveLength(2);
    expect(within(grid).getAllByTestId("eta-column-label").map((l) => l.textContent))
      .toEqual(["Main St · 10 m", "Opposite direction · Main St · 22 m"]);
    expect(screen.queryByTestId("eta-row")).toBeNull();

    settingsState.etaCardsLayout = "rows";
    // Fresh element: an identical one would let React skip the re-render.
    view.rerender(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("eta-columns")).toBeNull();
    expect(screen.getAllByTestId("eta-row")).toHaveLength(2);
  });

  it("hides the strip while the line view shows, keeping the hook enabled", () => {
    const view = renderHome();
    geolocate(USER);
    expect(screen.getByTestId("eta-cards")).toBeTruthy();

    lineViewState.isVisible = true;
    lineViewState.activeRouteId = "1";
    rerenderHome(view);
    // A pill tap would open a trip sheet over the line and its direction toggle.
    expect(screen.queryByTestId("eta-cards")).toBeNull();
    expect(lastHookArgs().enabled).toBe(true);

    lineViewState.isVisible = false;
    lineViewState.activeRouteId = null;
    rerenderHome(view);
    expect(screen.getByTestId("eta-cards")).toBeTruthy();
  });

  it("shows nothing when the hook finds no nearest stop", () => {
    hookState.canned = hookState.off;
    renderHome();
    geolocate(USER);
    expect(screen.queryByTestId("eta-cards")).toBeNull();
  });

  describe("switches the hook off", () => {
    it("while a departure sheet is open", () => {
      renderHome();
      geolocate(USER);
      openSheet(S);
      expect(screen.getByTestId("departure-sheet")).toBeTruthy();
      expect(lastHookArgs().enabled).toBe(false);
      expect(screen.queryByTestId("eta-cards")).toBeNull();
    });

    it("during guidance", () => {
      guidanceState.phase = "navigating";
      renderHome();
      geolocate(USER);
      expect(lastHookArgs().enabled).toBe(false);
      expect(screen.queryByTestId("eta-cards")).toBeNull();
    });

    it("while a bike station sheet is open", () => {
      renderHome();
      geolocate(USER);
      act(() => useBikeShareStore.getState().selectStation("station-1"));
      expect(lastHookArgs().enabled).toBe(false);
      expect(screen.queryByTestId("eta-cards")).toBeNull();
    });

    it("while the ETA cards setting is off", () => {
      settingsState.etaCardsEnabled = false;
      renderHome();
      geolocate(USER);
      expect(lastHookArgs().enabled).toBe(false);
      expect(screen.queryByTestId("eta-cards")).toBeNull();
    });

    it("in schedule mode, although the last GPS fix is still known", () => {
      const view = renderHome();
      geolocate(USER);
      expect(lastHookArgs().enabled).toBe(true);

      settingsState.scheduleMode = true;
      rerenderHome(view);
      expect(screen.getByTestId("schedule-home-sentinel")).toBeTruthy();
      expect(lastHookArgs()).toEqual({ enabled: false, position: USER, visibleStops: [S, R] });
    });
  });
});

// ─── The real hook: nothing is fetched while it is off ──────────────────────

describe("Home – ETA strip over the real hook", () => {
  beforeEach(() => {
    hookState.real = true;
    storeState.raptorIndex = STREET_INDEX;
    departuresState.byStop = new Map([
      ["S", { departures: [dep("1", "t1", "Airport", 3)], loading: false, error: null }],
    ]);
  });

  it("fetches the opposite stop through departuresForStops and shows both rows", async () => {
    renderHome();
    geolocate(USER);
    await waitFor(() => expect(screen.getAllByTestId("eta-row")).toHaveLength(2));
    expect(departuresForStops).toHaveBeenCalledTimes(1);
    expect(vi.mocked(departuresForStops).mock.calls[0][0].stopIds).toEqual(["R"]);
  });

  it("an opposite-row pill opens its trip from the reverse stop, with the stops ahead", async () => {
    renderHome();
    geolocate(USER);
    await waitFor(() => expect(screen.getAllByTestId("eta-row")).toHaveLength(2));
    tapPill("Centre");

    // t2 runs B → R → A and is boarded at R: B is folded away, R is current.
    const stopsList = screen.getByTestId("trip-stops");
    const shown = within(stopsList).getAllByTestId("trip-stop");
    expect(shown.map((li) => li.getAttribute("data-stop-id"))).toEqual(["R", "A"]);
    expect(shown[0].getAttribute("aria-current")).toBe("location");
    expect(screen.getByRole("button", { name: "1 earlier stop" })).toBeTruthy();
    expect(screen.getByTestId("trip-vehicle")).toBeTruthy();
    expect(screen.getByTestId("trip-source").textContent).toBe("Estimated from timetable");
  });

  it("without a pattern index: today's single row from S only, and a trip sheet without a timeline", async () => {
    storeState.raptorIndex = null;
    departuresState.byStop = new Map([
      ["S", {
        departures: [dep("1", "t1", "Airport", 3), dep("2", "t9", "Zoo", 5)],
        loading: false,
        error: null,
      }],
    ]);
    renderHome();
    geolocate(USER);
    await act(async () => {});

    const rows = screen.getAllByTestId("eta-row");
    expect(rows).toHaveLength(1);
    expect(screen.queryByTestId("eta-row-header")).toBeNull();
    expect(within(rows[0]).getAllByTestId("eta-card")).toHaveLength(2);
    expect(departuresForStops).not.toHaveBeenCalled();

    tapPill("Airport");
    expect(screen.getByRole("dialog", { name: "Line 1 toward Airport" })).toBeTruthy();
    expect(screen.queryByTestId("trip-stops")).toBeNull();
    expect(screen.queryByTestId("trip-vehicle")).toBeNull();
    expect(screen.getByRole("button", { name: "All departures here" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show on map" })).toBeTruthy();
  });

  it.each([
    [
      "a departure sheet",
      () => openSheet(S),
      () => act(() => surfaces.sheet!.onClose()),
    ],
    [
      "a bike station sheet",
      () => act(() => useBikeShareStore.getState().selectStation("station-1")),
      () => act(() => useBikeShareStore.getState().clearStationSelection()),
    ],
  ])("fetches nothing while %s is open, and resumes after", async (_name, open, close) => {
    renderHome();
    open();
    geolocate(USER);
    await act(async () => {});
    expect(departuresForStops).not.toHaveBeenCalled();
    expect(screen.queryByTestId("eta-cards")).toBeNull();

    close();
    await waitFor(() => expect(departuresForStops).toHaveBeenCalledTimes(1));
  });

  it("fetches nothing during guidance, and resumes after", async () => {
    guidanceState.phase = "navigating";
    const view = renderHome();
    geolocate(USER);
    await act(async () => {});
    expect(departuresForStops).not.toHaveBeenCalled();

    guidanceState.phase = "idle";
    // Fresh element: an identical one would let React skip the re-render.
    view.rerender(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(departuresForStops).toHaveBeenCalledTimes(1));
  });
});

// ─── Pill tap → trip sheet ──────────────────────────────────────────────────

describe("Home – trip sheet", () => {
  it("opens for the tapped pill's departure and hides the strip until it closes", () => {
    const { container } = renderHome();
    geolocate(USER);
    const root = container.firstElementChild!;
    expect(root.hasAttribute("data-sheet")).toBe(false);
    tapPill("Centre");
    expect(screen.getByRole("dialog", { name: "Line 1 toward Centre" })).toBeTruthy();
    expect(screen.queryByTestId("eta-cards")).toBeNull();
    // Hidden, not switched off: the strip is back at once when the sheet closes.
    expect(lastHookArgs().enabled).toBe(true);
    // The map controls lift above the sheet, and markers keep out from under it.
    expect(root.hasAttribute("data-sheet")).toBe(true);
    expect(useMapObstaclesStore.getState().obstacles.has("trip-sheet")).toBe(true);
    expect(useMapObstaclesStore.getState().obstacles.has("eta-cards")).toBe(false);

    fireEvent.click(screen.getByTestId("trip-close"));
    expect(tripSheet()).toBeNull();
    expect(screen.getByTestId("eta-cards")).toBeTruthy();
    expect(root.hasAttribute("data-sheet")).toBe(false);
    expect(useMapObstaclesStore.getState().obstacles.has("trip-sheet")).toBe(false);
  });

  it("gives keyboard focus back to the pill it was opened from, when the rider closes it", () => {
    renderHome();
    geolocate(USER);
    const pill = () =>
      screen.getAllByTestId("eta-card").find((p) => p.getAttribute("aria-label")!.includes("toward Centre,"))!;
    pill().focus();
    fireEvent.click(pill());
    expect(screen.getByTestId("trip-close")).toBe(document.activeElement);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(tripSheet()).toBeNull();
    expect(document.activeElement).toBe(pill());
  });

  it("does not pull focus to the strip when something else closed the sheet", () => {
    renderHome();
    geolocate(USER);
    const pill = screen.getAllByTestId("eta-card")[0];
    pill.focus();
    fireEvent.click(pill);
    // A long-press drops a pin: its own sheet takes the bottom slot.
    act(() => useMapTapStore.getState().emitTap(LAT0, LON0));
    expect(tripSheet()).toBeNull();
    expect(screen.getAllByTestId("eta-card")).not.toContain(document.activeElement);
  });

  it.each([
    ["a stop tap on the map", () => surfaces.map!.onStopClick(S)],
    [
      "a favourite stop",
      () =>
        surfaces.favorites!.onFavoriteClick({
          id: "fav-1",
          name: "Main St",
          type: "stop",
          location: S.location,
          stopId: "S",
          sortOrder: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        } satisfies FavoritePlace),
    ],
  ])("gives way to the stop popup opened by %s", (_name, openPopup) => {
    renderHome();
    geolocate(USER);
    tapPill("Airport");
    act(() => openPopup());
    expect(tripSheet()).toBeNull();
    expect(screen.getByTestId("stop-popup")).toBeTruthy();
  });

  it("\"All departures here\" swaps it for the boarding stop's departure sheet", () => {
    renderHome();
    geolocate(USER);
    // The Centre pill leaves from R, not from the nearest stop.
    tapPill("Centre");
    fireEvent.click(screen.getByRole("button", { name: "All departures here" }));
    expect(tripSheet()).toBeNull();
    expect(screen.getByTestId("departure-sheet")).toBeTruthy();
    expect(surfaces.sheet!.stop).toBe(R);
    // The departure sheet takes the bottom slot: the strip's hook is off.
    expect(lastHookArgs().enabled).toBe(false);
  });

  it("\"Show on map\" opens the pill's line in its direction; the line view then closes the sheet", () => {
    const view = renderHome();
    geolocate(USER);
    tapPill("Centre");
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    // With the pill's trip: its direction, not the first with its headsign
    // (both directions of a route may read the same).
    expect(lineClickState.openLine).toHaveBeenCalledWith("1", "1", "e53935", "Centre", "t2");
    // The line loads asynchronously; the sheet stays until the line view shows.
    expect(tripSheet()).not.toBeNull();

    lineViewState.isVisible = true;
    lineViewState.activeRouteId = "1";
    rerenderHome(view);
    expect(tripSheet()).toBeNull();
  });

  it("\"Show on map\" closes the sheet itself once the line shows", async () => {
    // The mocked line-view store does not change here, so the line-view
    // effect cannot be what closes the sheet (as when re-showing the route
    // already on screen, which changes neither of its deps).
    lineClickState.openLine.mockResolvedValue(true);
    renderHome();
    geolocate(USER);
    tapPill("Centre");

    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    await act(async () => {});
    expect(lineClickState.openLine).toHaveBeenCalledWith("1", "1", "e53935", "Centre", "t2");
    expect(tripSheet()).toBeNull();
  });

  it("\"Show on map\" leaves the sheet open when the line does not show", async () => {
    // No patterns, a load error, or a load superseded by another tap.
    lineClickState.openLine.mockResolvedValue(false);
    renderHome();
    geolocate(USER);
    tapPill("Centre");

    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    await act(async () => {});
    expect(tripSheet()).not.toBeNull();
  });

  it("a late \"Show on map\" never closes a trip sheet opened after it", async () => {
    let finish!: (shown: boolean) => void;
    lineClickState.openLine.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    renderHome();
    geolocate(USER);
    tapPill("Centre");
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));

    // While the line loads, the rider closes the sheet and opens another trip.
    fireEvent.click(screen.getByTestId("trip-close"));
    tapPill("Airport");
    await act(async () => finish(true));
    expect(screen.getByRole("dialog", { name: "Line 1 toward Airport" })).toBeTruthy();
  });

  it.each<[string, (view: ReturnType<typeof renderHome>) => void]>([
    ["closing it", () => fireEvent.click(screen.getByTestId("trip-close"))],
    ["\"All departures here\"", () => fireEvent.click(screen.getByRole("button", { name: "All departures here" }))],
    ["tapping another pill", () => {
      fireEvent.click(screen.getByTestId("trip-close"));
      lineClickState.cancel.mockClear();
      tapPill("Airport");
    }],
    ["starting guidance", (view) => {
      guidanceState.phase = "navigating";
      rerenderHome(view);
    }],
    ["a map long-press", () => act(() => useMapTapStore.getState().emitTap(LAT0, LON0))],
    ["selecting a bike station", () => act(() => useBikeShareStore.getState().selectStation("station-1"))],
    ["a city change", (view) => {
      cityState.activeCity = { id: "riga", name: "Riga", tz: "Europe/Riga" };
      rerenderHome(view);
    }],
  ])("cancels a pending \"Show on map\" load when the rider moves on by %s", (_name, moveOn) => {
    // The load, landing later, would show the line over whatever took the
    // bottom slot by then (after a city change, the old city's line).
    const view = renderHome();
    geolocate(USER);
    tapPill("Centre");
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    lineClickState.cancel.mockClear();

    moveOn(view);
    expect(lineClickState.cancel).toHaveBeenCalled();
  });

  it.each<[string, (view: ReturnType<typeof renderHome>) => void]>([
    ["starting guidance", (view) => {
      guidanceState.phase = "navigating";
      rerenderHome(view);
    }],
    ["a map long-press", () => act(() => useMapTapStore.getState().emitTap(LAT0, LON0))],
    ["selecting a bike station", () => act(() => useBikeShareStore.getState().selectStation("station-1"))],
    ["a city change", (view) => {
      cityState.activeCity = { id: "riga", name: "Riga", tz: "Europe/Riga" };
      rerenderHome(view);
    }],
  ])("a repeated \"Show on map\" stays cancellable by %s after the load it superseded settles", async (_name, moveOn) => {
    // Both taps are for the same trip. The second load supersedes the first,
    // which settles as not shown while the second is still loading: that must
    // not count as the second one finishing.
    const finish: Array<(shown: boolean) => void> = [];
    lineClickState.openLine.mockImplementation(() => new Promise<boolean>((resolve) => { finish.push(resolve); }));
    const view = renderHome();
    geolocate(USER);
    tapPill("Centre");
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    fireEvent.click(screen.getByRole("button", { name: "Show on map" }));
    expect(lineClickState.openLine).toHaveBeenCalledTimes(2);
    await act(async () => finish[0](false));
    expect(tripSheet()).not.toBeNull();
    lineClickState.cancel.mockClear();

    moveOn(view);
    expect(tripSheet()).toBeNull();
    expect(lineClickState.cancel).toHaveBeenCalled();
  });

  it("starting guidance leaves another surface's line load alone when no \"Show on map\" is pending", () => {
    const view = renderHome();
    geolocate(USER);
    tapPill("Centre");
    lineClickState.cancel.mockClear();

    guidanceState.phase = "navigating";
    rerenderHome(view);
    expect(tripSheet()).toBeNull();
    expect(lineClickState.cancel).not.toHaveBeenCalled();
  });

  it("closes when a bike station is selected", () => {
    renderHome();
    geolocate(USER);
    tapPill("Airport");
    act(() => useBikeShareStore.getState().selectStation("station-1"));
    expect(tripSheet()).toBeNull();
  });

  it("closes on a map long-press, and a pill tap closes the long-press sheet", () => {
    renderHome();
    geolocate(USER);
    act(() => useMapTapStore.getState().emitTap(LAT0, LON0));
    // The long-press sheet leaves the strip up.
    tapPill("Airport");
    expect(useMapTapStore.getState().rawTap).toBeNull();

    act(() => useMapTapStore.getState().emitTap(LAT0, LON0));
    expect(tripSheet()).toBeNull();
  });

  it("closes when guidance starts, and stays closed after it ends", () => {
    const view = renderHome();
    geolocate(USER);
    tapPill("Airport");

    guidanceState.phase = "navigating";
    rerenderHome(view);
    expect(tripSheet()).toBeNull();

    guidanceState.phase = "idle";
    rerenderHome(view);
    expect(tripSheet()).toBeNull();
    expect(screen.getByTestId("eta-cards")).toBeTruthy();
  });

  it("closes on a city change", () => {
    const view = renderHome();
    geolocate(USER);
    tapPill("Airport");

    cityState.activeCity = { id: "riga", name: "Riga", tz: "Europe/Riga" };
    rerenderHome(view);
    expect(tripSheet()).toBeNull();
  });
});

// ─── The trip sheet's live data under the real-time decision ────────────────

describe("Home – trip sheet live data", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("asks for the pill's route while the sheet is open, and stops once it closes", async () => {
    renderHome();
    geolocate(USER);
    await elapse(60_000);
    // The strip alone never asks for live data.
    expect(rtRequests()).toEqual([]);

    tapPill("Centre");
    await elapse(0);
    expect(rtRequests()).toHaveLength(1);
    expect(rtRequests()[0]).toMatch(/\/api\/vilnius\/rt\/1$/);
    // Every request settles, so the poller keeps asking while the sheet is open.
    await elapse(2 * 60_000);
    const whileOpen = rtRequests().length;
    expect(whileOpen).toBeGreaterThan(1);

    fireEvent.click(screen.getByTestId("trip-close"));
    await elapse(5 * 60_000);
    expect(rtRequests()).toHaveLength(whileOpen);
  });

  it.each([
    ["unset", () => resetFlows()],
    ["denied", () => denyFlow("operator.realtime")],
  ])("makes no /rt/<routeId> request while real-time updates are %s", async (_name, apply) => {
    apply();
    const subscribe = vi.spyOn(useRtStore.getState().poller, "subscribe");
    renderHome();
    geolocate(USER);
    tapPill("Centre");
    // The sheet does hold its route: the decision, read at every poll, is what
    // keeps the request from being made.
    expect(subscribe).toHaveBeenCalledWith("1", expect.any(Function));

    await elapse(5 * 60_000);
    expect(rtRequests()).toEqual([]);
    expect(tripSheet()).toBeTruthy();
  });
});
