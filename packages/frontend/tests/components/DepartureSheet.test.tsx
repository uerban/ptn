import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nContext } from "../../src/i18n/index.ts";
import { DepartureSheet } from "../../src/components/DepartureSheet/DepartureSheet.tsx";
import { useLineViewStore } from "../../src/stores/lineViewStore.ts";

const mockT = (key: string, fallback?: string) => fallback ?? key;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContext.Provider value={{ locale: "en", formattingLocale: "en", t: mockT }}>
      {children}
    </I18nContext.Provider>
  );
}

// Mock useDepartures
vi.mock("../../src/hooks/useDepartures.ts", () => ({
  useDepartures: () => ({
    departures: [
      { routeId: "r1", routeShortName: "1", routeColor: "e53935", mode: "BUS", headsign: "Centre", scheduledTime: new Date(Date.now() + 3 * 60_000).toISOString(), tripId: "t1" },
      { routeId: "r1", routeShortName: "1", routeColor: "e53935", mode: "BUS", headsign: "Centre", scheduledTime: new Date(Date.now() + 11 * 60_000).toISOString(), tripId: "t2" },
      { routeId: "r2", routeShortName: "3", routeColor: "1e88e5", mode: "TRAM", headsign: "Station", scheduledTime: new Date(Date.now() + 5 * 60_000).toISOString(), tripId: "t3" },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../src/stores/favoritesStore.ts", () => ({
  useFavoritesStore: () => ({
    favorites: [],
    addFavorite: vi.fn(),
    removeFavorite: vi.fn(),
  }),
}));

const mockBuildLinePatterns = vi.fn();
vi.mock("../../src/utils/buildLinePatterns.ts", () => ({
  buildLinePatterns: (...args: unknown[]) => mockBuildLinePatterns(...args),
}));

describe("DepartureSheet", () => {
  beforeEach(() => {
    mockBuildLinePatterns.mockReset();
    useLineViewStore.getState().hideLine();
  });

  it("renders stop name in header", () => {
    render(
      <DepartureSheet
        stop={{ id: "s1", name: "Gedimino pr.", location: { lat: 54.68, lon: 25.28 } }}
        onClose={vi.fn()}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("Gedimino pr.")).toBeDefined();
  });

  it("groups departures by route", () => {
    render(
      <DepartureSheet
        stop={{ id: "s1", name: "Stop", location: { lat: 54.68, lon: 25.28 } }}
        onClose={vi.fn()}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("Centre")).toBeDefined();
    expect(screen.getByText("Station")).toBeDefined();
  });

  it("renders view-route buttons for each line group", () => {
    render(
      <DepartureSheet
        stop={{ id: "s1", name: "Stop", location: { lat: 54.68, lon: 25.28 } }}
        onClose={vi.fn()}
      />,
      { wrapper: Wrapper }
    );
    const viewBtns = screen.getAllByTestId("view-route-btn");
    expect(viewBtns.length).toBe(2);
  });

  it("calls buildLinePatterns and showLine when view-route button is clicked", async () => {
    const patterns = [
      { directionId: 0, headsign: "Centre", stops: [{ id: "s1", name: "A", location: { lat: 1, lon: 2 } }] },
    ];
    mockBuildLinePatterns.mockResolvedValue(patterns);

    render(
      <DepartureSheet
        stop={{ id: "s1", name: "Stop", location: { lat: 54.68, lon: 25.28 } }}
        onClose={vi.fn()}
      />,
      { wrapper: Wrapper }
    );

    const viewBtns = screen.getAllByTestId("view-route-btn");
    fireEvent.click(viewBtns[0]);

    // Wait for async handler
    await vi.waitFor(() => {
      expect(mockBuildLinePatterns).toHaveBeenCalledWith("r1");
    });

    await vi.waitFor(() => {
      const store = useLineViewStore.getState();
      expect(store.isVisible).toBe(true);
      expect(store.activeRouteId).toBe("r1");
      expect(store.activeRouteShortName).toBe("1");
    });
  });

  it("cycles through peek/half/full states on handle click", () => {
    render(
      <DepartureSheet
        stop={{ id: "s1", name: "Stop", location: { lat: 54.68, lon: 25.28 } }}
        onClose={vi.fn()}
      />,
      { wrapper: Wrapper }
    );

    const sheet = screen.getByTestId("departure-sheet");
    const handle = screen.getByTestId("sheet-handle");

    // Initial state: half — body visible
    expect(sheet.className).toContain("max-h-[50vh]");
    expect(screen.getByText("Centre")).toBeDefined();

    // half → full
    fireEvent.click(handle);
    expect(sheet.className).toContain("max-h-[90vh]");
    expect(screen.getByText("Centre")).toBeDefined();

    // full → peek — body hidden
    fireEvent.click(handle);
    expect(sheet.className).toContain("max-h-[120px]");
    expect(screen.queryByText("Centre")).toBeNull();

    // peek → half — body visible again
    fireEvent.click(handle);
    expect(sheet.className).toContain("max-h-[50vh]");
    expect(screen.getByText("Centre")).toBeDefined();
  });

  it("does not open line view when buildLinePatterns returns empty array", async () => {
    mockBuildLinePatterns.mockResolvedValue([]);

    render(
      <DepartureSheet
        stop={{ id: "s1", name: "Stop", location: { lat: 54.68, lon: 25.28 } }}
        onClose={vi.fn()}
      />,
      { wrapper: Wrapper }
    );

    const viewBtns = screen.getAllByTestId("view-route-btn");
    fireEvent.click(viewBtns[0]);

    await vi.waitFor(() => {
      expect(mockBuildLinePatterns).toHaveBeenCalledWith("r1");
    });

    // Line view should remain hidden
    expect(useLineViewStore.getState().isVisible).toBe(false);
  });
});
