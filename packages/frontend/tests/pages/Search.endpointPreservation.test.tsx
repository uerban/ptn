import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

const emptyRaptorIndex: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map(),
};

describe("Search endpoint preservation on typing", () => {
  let searchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    searchSpy = vi.fn().mockResolvedValue(undefined);
    useRoutingStore.setState({
      ranking: "fastest",
      results: [],
      error: null,
      loading: false,
      search: searchSpy,
    });
    const activeCityId = useCityStore.getState().activeCity.id;
    useGtfsDataStore.setState({
      raptorIndex: emptyRaptorIndex,
      stopNames: new Map(),
      loadedCityId: activeCityId,
      syncing: false,
    });
    await db.gtfsStops.clear();
    await db.gtfsStops.bulkPut([
      { id: "stop-a", name: "Alpha", lat: 50.1, lon: 19.9 },
      { id: "stop-b", name: "Beta", lat: 50.2, lon: 20.0 },
    ]);
  });

  it("does not re-run auto-search with a stale endpoint after free-text typing", async () => {
    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    const [firstOrigin] = searchSpy.mock.calls[0];
    expect(firstOrigin).toMatchObject({ kind: "stop", stopId: "stop-a" });

    searchSpy.mockClear();

    // Step 1: free-text edit into `from` should clear fromEndpoint.
    const fromInput = (screen.getAllByRole("searchbox") as HTMLInputElement[]).find(
      (el) => el.value === "Alpha",
    );
    expect(fromInput).toBeDefined();
    fireEvent.change(fromInput!, { target: { value: "something else" } });
    await new Promise((r) => setTimeout(r, 10));

    // Step 2: typing valid coords into `to` changes toEndpoint. The auto-search
    // effect's deps change either way, so this isolates whether fromEndpoint is
    // null (effect early-returns) vs. still holding the stale stop (effect fires
    // with the stale origin and a new destination).
    const toInput = (screen.getAllByRole("searchbox") as HTMLInputElement[]).find(
      (el) => el.value === "Beta",
    );
    expect(toInput).toBeDefined();
    fireEvent.change(toInput!, { target: { value: "54.7200, 25.2600" } });
    await new Promise((r) => setTimeout(r, 50));

    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("resolves a raw lat/lon typed into the from field to a mappoint endpoint", async () => {
    render(
      <MemoryRouter initialEntries={["/search?toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const values = (screen.getAllByRole("searchbox") as HTMLInputElement[]).map((e) => e.value);
      expect(values).toContain("Beta");
    });

    searchSpy.mockClear();

    const fromInput = (screen.getAllByRole("searchbox") as HTMLInputElement[]).find(
      (el) => el.value === "",
    );
    expect(fromInput).toBeDefined();
    fireEvent.change(fromInput!, { target: { value: "54.7138, 25.2506" } });

    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    const [origin] = searchSpy.mock.calls[0];
    expect(origin).toMatchObject({ kind: "mappoint", lat: 54.7138, lon: 25.2506 });
  });
});
