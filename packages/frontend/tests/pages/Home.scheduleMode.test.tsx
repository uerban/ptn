vi.mock("../../src/services/liveLocation.ts", () => ({ liveLocation: { request: vi.fn() } }));
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

/**
 * The home route's dispatcher: Map mode renders the map surface and never
 * Text mode's; Text mode renders the text surface and keeps the map module
 * unmounted until a temporary map (`?view=map`) asks for it. Leaving the
 * map (switching to Text mode, navigating away) disables the bike-share
 * store, so the 60 s operator poll never keeps running with the map (and the
 * layer's only off control) unmounted.
 */

// Mutable so individual tests can flip the mode and rerender.
const settingsState = vi.hoisted(() => ({ scheduleMode: false }));
const lineClickState = vi.hoisted(() => ({
  openLine: vi.fn(),
  cancel: vi.fn(),
}));

// TextHome mock — renders a sentinel so we can detect its presence
vi.mock("../../src/pages/TextHome.tsx", () => ({
  TextHome: () => <div data-testid="text-home-sentinel">TextHome</div>,
}));

// Map and heavy map dependencies
vi.mock("../../src/components/Map/TransitMap.tsx", () => ({
  TransitMap: vi.fn().mockImplementation((_, ref) => {
    if (ref && typeof ref === "object" && "current" in ref) {
      (ref as any).current = null;
    }
    return <div data-testid="transit-map" />;
  }),
}));

vi.mock("maplibre-gl", () => ({
  default: {},
}));

vi.mock("../../src/components/Map/LineRouteOverlay.tsx", () => ({
  LineRouteOverlay: () => null,
}));

vi.mock("../../src/components/Map/ModeToggle.tsx", () => ({
  ModeToggle: () => null,
}));

vi.mock("../../src/components/Map/StopPopup.tsx", () => ({
  StopPopup: () => null,
}));

vi.mock("../../src/components/Map/RouteOverlay.tsx", () => ({
  RouteOverlay: () => null,
}));

vi.mock("../../src/components/Map/UserPositionMarker.tsx", () => ({
  UserPositionMarker: () => null,
}));

vi.mock("../../src/components/Map/TransferBadge.tsx", () => ({
  TransferBadge: () => null,
}));

vi.mock("../../src/components/Map/MapTapActionSheet.tsx", () => ({
  MapTapActionSheet: () => null,
}));

vi.mock("../../src/components/Favorites/FavoritesBar.tsx", () => ({
  FavoritesBar: () => null,
}));

vi.mock("../../src/components/DepartureSheet/DepartureSheet.tsx", () => ({
  DepartureSheet: () => null,
}));

vi.mock("../../src/components/Guidance/StepList.tsx", () => ({
  StepList: () => null,
}));

vi.mock("../../src/components/Guidance/RiderDashboard.tsx", () => ({
  RiderDashboard: () => null,
}));

vi.mock("../../src/components/Guidance/RiderModePrompt.tsx", () => ({
  RiderModePrompt: () => null,
}));

vi.mock("../../src/stores/stopStore.ts", () => ({
  useStopStore: Object.assign((sel: any) => sel({ stops: [] }), {
    getState: () => ({ recordTap: vi.fn(), reset: vi.fn() }),
  }),
}));

vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: Object.assign((sel: any) => sel({ activeCity: { id: "vilnius", name: "Vilnius" } }), {
    getState: () => ({ setActiveCity: vi.fn() }),
  }),
}));

vi.mock("../../src/stores/gtfsDataStore.ts", () => ({
  useGtfsDataStore: Object.assign((sel: any) => sel({ raptorIndex: null }), {
    getState: () => ({ init: vi.fn(), reset: vi.fn().mockResolvedValue(undefined) }),
  }),
}));

vi.mock("../../src/stores/rtStore.ts", () => ({
  useRtStore: Object.assign(() => undefined, {
    getState: () => ({ unsubscribeAll: vi.fn() }),
  }),
}));

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
    phase: "idle",
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
  useLineViewStore: Object.assign((sel: any) => sel({ isVisible: false, activeRouteId: null }), {
    getState: () => ({ hideLine: vi.fn(), isVisible: false }),
  }),
}));

// settingsStore — key mock: scheduleMode read from the mutable hoisted state
vi.mock("../../src/stores/settingsStore.ts", () => ({
  useSettingsStore: Object.assign((sel: any) => sel({ scheduleMode: settingsState.scheduleMode }), {
    getState: () => ({
      setScheduleMode: (enabled: boolean) => {
        settingsState.scheduleMode = enabled;
      },
    }),
  }),
}));

vi.mock("../../src/hooks/useStopPreloader.ts", () => ({
  useStopPreloader: () => undefined,
}));

vi.mock("../../src/hooks/useDepartures.ts", () => ({
  useDepartures: () => ({ departures: [], loading: false, error: null }),
}));

vi.mock("../../src/hooks/useNearbyDirections.ts", () => ({
  useNearbyDirections: () => ({ nearestStop: null, sides: [], departuresBySide: new Map(), loading: false }),
}));

vi.mock("../../src/hooks/useLineClick.ts", () => ({
  useLineClick: () => lineClickState,
}));

vi.mock("../../src/hooks/useWatchPosition.ts", () => ({
  useWatchPosition: () => ({ position: null, speed: null, heading: null, accuracy: null }),
}));

vi.mock("../../src/hooks/useDeviceHeading.ts", () => ({
  useDeviceHeading: () => ({ heading: null }),
}));

vi.mock("../../src/hooks/useGuidanceLegProgress.ts", () => ({
  useGuidanceLegProgress: () => undefined,
}));

vi.mock("../../src/hooks/useRiderModeDetection.ts", () => ({
  useRiderModeDetection: () => undefined,
  findStopContextCandidates: () => [],
}));

vi.mock("../../src/hooks/useMapGuidance.ts", () => ({
  useMapGuidance: () => ({ zoomToLeg: vi.fn() }),
}));

vi.mock("../../src/hooks/useRiderDashboardData.ts", () => ({
  useRiderDashboardData: () => ({ upcomingStops: [], connectingDepartures: [] }),
}));

vi.mock("../../src/config/cities.ts", () => ({
  findNearestCity: () => ({ id: "vilnius", name: "Vilnius" }),
}));

vi.mock("../../src/i18n/index.ts", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock("@pt/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pt/shared")>();
  return {
    ...actual,
    GTFS_CLIENT_REFRESH_INTERVAL_MS: 3_600_000,
    PEDESTRIAN_SPEED_THRESHOLD_MS: 1.5,
  };
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function renderDispatcher(entry = "/") {
  const { HomeDispatcher } = await import("../../src/pages/HomeDispatcher.tsx");
  const ui = () => (
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<><HomeDispatcher /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(ui());
  return { ...view, rerenderDispatcher: () => view.rerender(ui()) };
}

describe("Home dispatcher – Map mode (scheduleMode: false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsState.scheduleMode = false;
  });

  it("renders the TransitMap and not the text surface", async () => {
    await renderDispatcher();
    expect(await screen.findByTestId("transit-map")).toBeTruthy();
    expect(screen.queryByTestId("text-home-sentinel")).toBeNull();
  });

  it("ignores ?view=map: the map is the starting view already", async () => {
    await renderDispatcher("/?view=map");
    expect(await screen.findByTestId("transit-map")).toBeTruthy();
    expect(screen.queryByTestId("back-to-text-btn")).toBeNull();
    expect(screen.getByTestId("show-schedule-btn")).toBeTruthy();
  });
});

describe("Home dispatcher – Text mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsState.scheduleMode = true;
  });

  it("renders the text surface without mounting the map", async () => {
    await renderDispatcher();
    expect(await screen.findByTestId("text-home-sentinel")).toBeTruthy();
    expect(screen.queryByTestId("transit-map")).toBeNull();
  });

  it("opens a temporary map from ?view=map and Back to text returns without changing the starting view", async () => {
    await renderDispatcher("/?view=map");
    expect(await screen.findByTestId("transit-map")).toBeTruthy();
    act(() => screen.getByTestId("back-to-text-btn").click());
    expect(await screen.findByTestId("text-home-sentinel")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(settingsState.scheduleMode).toBe(true);
  });
});

describe("Home dispatcher – switching to Text mode disables bike-share polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsState.scheduleMode = false;
  });

  it("switching to Text mode unmounts the map and disables the bike-share store", async () => {
    const { useBikeShareStore } = await import("../../src/stores/bikeShareStore.ts");
    // Real store, forced into the enabled state a user's opt-in tap set up.
    useBikeShareStore.setState({ enabled: true });

    const view = await renderDispatcher();
    await screen.findByTestId("transit-map");
    // Map view leaves the user's opt-in alone.
    expect(useBikeShareStore.getState().enabled).toBe(true);

    act(() => screen.getByTestId("show-schedule-btn").click());
    view.rerenderDispatcher();

    // The text surface took over the page — and the store was disabled with
    // the map, so the 60 s third-party poll cannot keep running headless.
    expect(await screen.findByTestId("text-home-sentinel")).toBeTruthy();
    expect(useBikeShareStore.getState().enabled).toBe(false);
  });
});

describe("Home – navigating away disables bike-share polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsState.scheduleMode = false;
  });

  it("unmounting Home (navigation to /search, /settings, a line view) disables the store", async () => {
    const { HomePage } = await import("../../src/pages/Home.tsx");
    const { useBikeShareStore } = await import("../../src/stores/bikeShareStore.ts");
    useBikeShareStore.setState({ enabled: true }); // user's opt-in tap

    const view = render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    // Staying on the map leaves the user's opt-in alone.
    expect(useBikeShareStore.getState().enabled).toBe(true);

    // Any navigation away from "/" swaps the routed page and unmounts Home —
    // the map, the toggle, and the layer with it. The 60 s operator poll
    // must stop too: no third-party polling without a visible off control.
    view.unmount();
    expect(useBikeShareStore.getState().enabled).toBe(false);
  });

  it("returning to Home does not auto-re-enable: opt-in is per-visit", async () => {
    const { HomePage } = await import("../../src/pages/Home.tsx");
    const { useBikeShareStore } = await import("../../src/stores/bikeShareStore.ts");
    const enableSpy = vi.spyOn(useBikeShareStore.getState(), "enable");
    useBikeShareStore.setState({ enabled: true });

    const first = render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    first.unmount();
    expect(useBikeShareStore.getState().enabled).toBe(false);

    // Second visit: chip must come back OFF and nothing may call enable()
    // (an auto-refetch would poll the operator without a fresh opt-in tap).
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
    expect(useBikeShareStore.getState().enabled).toBe(false);
    expect(enableSpy).not.toHaveBeenCalled();
  });
});

describe("Home – bottom panels are mutually exclusive", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settingsState.scheduleMode = false;

    const { useBikeShareStore } = await import("../../src/stores/bikeShareStore.ts");
    const { useMapTapStore } = await import("../../src/stores/mapTapStore.ts");
    useBikeShareStore.getState().disable();
    useBikeShareStore.setState({ stations: [], selectedStationId: null });
    useMapTapStore.getState().clear();
  });

  it("opening a bike station clears an existing dropped pin", async () => {
    const { HomePage } = await import("../../src/pages/Home.tsx");
    const { useBikeShareStore } = await import("../../src/stores/bikeShareStore.ts");
    const { useMapTapStore } = await import("../../src/stores/mapTapStore.ts");
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    act(() => useMapTapStore.getState().emitTap(54.6872, 25.2797));
    expect(useMapTapStore.getState().rawTap).not.toBeNull();

    act(() => useBikeShareStore.getState().selectStation("station-1"));

    await waitFor(() => expect(useMapTapStore.getState().rawTap).toBeNull());
    expect(useBikeShareStore.getState().selectedStationId).toBe("station-1");
  });

  it("opening a dropped pin clears an existing bike station", async () => {
    const { HomePage } = await import("../../src/pages/Home.tsx");
    const { useBikeShareStore } = await import("../../src/stores/bikeShareStore.ts");
    const { useMapTapStore } = await import("../../src/stores/mapTapStore.ts");
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    act(() => useBikeShareStore.getState().selectStation("station-1"));
    expect(useBikeShareStore.getState().selectedStationId).toBe("station-1");

    act(() => useMapTapStore.getState().emitTap(54.6872, 25.2797));

    await waitFor(() => expect(useBikeShareStore.getState().selectedStationId).toBeNull());
    expect(useMapTapStore.getState().rawTap).not.toBeNull();
  });
});
