import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Mock the heavy dependencies
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}));

// Geolocation is configured per-test via the mutable state below so we can
// simulate users landing in different cities.
const geoState: { location: { lat: number; lon: number } | null } = {
  location: { lat: 54.68, lon: 25.28 }, // Vilnius by default
};
vi.mock("../../src/hooks/useGeolocation.ts", () => ({
  useGeolocation: () => ({ location: geoState.location, error: null, loading: false }),
}));

vi.mock("../../src/stores/gtfsDataStore.ts", () => ({
  useGtfsDataStore: Object.assign(() => null, {
    getState: () => ({
      init: vi.fn(),
      reset: vi.fn().mockResolvedValue(undefined),
      raptorIndex: null,
    }),
  }),
}));

vi.mock("../../src/stores/rtStore.ts", () => ({
  useRtStore: Object.assign(() => null, {
    getState: () => ({ unsubscribeAll: vi.fn() }),
  }),
}));

vi.mock("../../src/stores/colorConfigStore.ts", () => ({
  useColorConfigStore: Object.assign(() => null, {
    getState: () => ({ fetchForCity: vi.fn().mockResolvedValue(undefined) }),
  }),
}));

const setActiveCityMock = vi.fn();
vi.mock("../../src/stores/cityStore.ts", () => ({
  useCityStore: Object.assign(
    (sel: any) => sel({ activeCity: { id: "vilnius", name: "Vilnius" } }),
    { getState: () => ({ setActiveCity: setActiveCityMock }) },
  ),
}));

vi.mock("../../src/hooks/useDepartures.ts", () => ({
  useDepartures: () => ({ departures: [], loading: false, error: null }),
}));

vi.mock("../../src/hooks/useLineClick.ts", () => ({
  useLineClick: () => ({ openLine: vi.fn(), cancel: vi.fn() }),
}));

vi.mock("../../src/components/Favorites/FavoritesBar.tsx", () => ({
  FavoritesBar: () => null,
}));

vi.mock("../../src/components/DepartureSheet/DepartureSheet.tsx", () => ({
  DepartureSheet: () => null,
}));

vi.mock("../../src/components/Schedule/NearbyStopsList.tsx", () => ({
  NearbyStopsList: () => null,
}));

vi.mock("../../src/i18n/index.ts", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

describe("ScheduleHome", () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveCityMock.mockClear();
    geoState.location = { lat: 54.68, lon: 25.28 };
  });

  it("renders without crashing", async () => {
    const { ScheduleHome } = await import("../../src/pages/ScheduleHome.tsx");
    render(
      <MemoryRouter>
        <ScheduleHome />
      </MemoryRouter>,
    );
    expect(screen.getByText("Vilnius")).toBeTruthy();
    expect(screen.getByTestId("plan-trip-btn")).toBeTruthy();
  });

  it("auto-switches to Tricity when the user's location is in Gdańsk on first visit", async () => {
    // Gdańsk main station coordinates — inside the tricity bbox
    geoState.location = { lat: 54.3557, lon: 18.6442 };
    const { ScheduleHome } = await import("../../src/pages/ScheduleHome.tsx");
    render(
      <MemoryRouter>
        <ScheduleHome />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(setActiveCityMock).toHaveBeenCalled();
    });
    expect(setActiveCityMock.mock.calls[0][0].id).toBe("tricity");
  });

  it("does not auto-switch when ptn-city is already persisted", async () => {
    localStorage.setItem("ptn-city", JSON.stringify({ state: { activeCity: { id: "vilnius" } } }));
    geoState.location = { lat: 54.3557, lon: 18.6442 }; // Gdańsk
    const { ScheduleHome } = await import("../../src/pages/ScheduleHome.tsx");
    render(
      <MemoryRouter>
        <ScheduleHome />
      </MemoryRouter>,
    );
    // Give the effect a tick to run
    await new Promise((r) => setTimeout(r, 0));
    expect(setActiveCityMock).not.toHaveBeenCalled();
  });
});
