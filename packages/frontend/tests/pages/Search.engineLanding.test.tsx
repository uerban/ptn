import { seedLegacyCityProjection } from "../../src/test-helpers/cityData.ts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

const emptyRaptorIndex: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map(),
};

// One zero-leg itinerary: enough for convertRaptorResults to render a card.
const oneResult = [
  {
    legs: [],
    departureSecs: 0,
    arrivalSecs: 600,
    totalSecs: 600,
    transfers: 0,
    sourceWalkSecs: 0,
    destWalkSecs: 0,
    totalWalkSecs: 0,
  },
];

// The engine landing (`ptRouter` going non-null) re-runs the auto-search
// effect. A load search that is still waiting for that build plans on it, so
// the page keeps it instead of starting the same search again; a search that
// already settled with an engine error is re-run (recovery).
describe("Search when the engine lands", () => {
  beforeEach(async () => {
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    useSettingsStore.setState({ routingMode: "on-device", routingProvider: "operator" });
    useGtfsDataStore.setState({
      raptorIndex: emptyRaptorIndex,
      ptRouter: null,
      stopNames: new Map(),
      loadedCityId: useCityStore.getState().activeCity.id,
      syncing: false,
    });
    await db.gtfsStops.clear();
    await seedLegacyCityProjection();
    await db.gtfsStops.bulkPut([
      { id: "stop-a", name: "Alpha", lat: 50.1, lon: 19.9 },
      { id: "stop-b", name: "Beta", lat: 50.2, lon: 20.0 },
    ]);
  });

  afterEach(() => {
    // This repo's vitest config does not register RTL auto-cleanup.
    cleanup();
    useGtfsDataStore.setState({ ptRouter: null });
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  function renderSearch() {
    return render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );
  }

  it("keeps the search waiting for the build: one search, its result shown", async () => {
    let finish!: () => void;
    const searchSpy = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        finish = () => {
          useRoutingStore.setState({
            results: oneResult, error: null, engineError: null, engineFailureKind: null, loading: false,
          });
          resolve();
        };
      }),
    );
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));

    // The build lands while the search waits for it.
    await act(async () => {
      useGtfsDataStore.setState({ ptRouter: {} as never });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(searchSpy).toHaveBeenCalledTimes(1);

    // The kept search's result is published, not dropped.
    await act(async () => finish());
    await waitFor(() => expect(screen.getByTestId("itinerary-card")).toBeInTheDocument());
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-runs a search that settled with an engine error when the engine lands", async () => {
    const searchSpy = vi.fn()
      .mockImplementationOnce(async () => {
        useRoutingStore.setState({
          results: [], error: null,
          engineError: "wasm init timed out", engineFailureKind: "misconfigured", loading: false,
        });
      })
      .mockImplementation(async () => {
        useRoutingStore.setState({
          results: oneResult, error: null, engineError: null, engineFailureKind: null, loading: false,
        });
      });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));

    await act(async () => {
      useGtfsDataStore.setState({ ptRouter: {} as never });
    });
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("itinerary-card")).toBeInTheDocument());
  });

  it("a query change while the search waits still supersedes it", async () => {
    const finishers: Array<() => void> = [];
    const searchSpy = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        finishers.push(() => {
          useRoutingStore.setState({
            results: oneResult, error: null, engineError: null, engineFailureKind: null, loading: false,
          });
          resolve();
        });
      }),
    );
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));

    // The engine lands and, in the same update, the ranking changes: the
    // query is not the one the waiting search was started for.
    await act(async () => {
      useGtfsDataStore.setState({ ptRouter: {} as never });
      useRoutingStore.setState({ ranking: "fewest_transfers" });
    });
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(2));
  });
});
