import { seedLegacyCityProjection } from "../../src/test-helpers/cityData.ts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import * as availability from "../../src/services/remoteRoutingAvailability.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

const emptyRaptorIndex: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map(),
};

// Wiring contract (routing-source S2a): the "Search on the server" button in the
// engine-failure surface re-runs the HELD query with `{ remote: true }`, and the
// button only appears when the privacy ceiling permits remote routing
// (`routingAdapter !== "local-only"`). At the `standard` level routingAdapter is
// "user-choice", so `remoteAllowed` is true.
describe("Search 'search on the server' re-run + remoteAllowed", () => {
  let searchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // `standard` keeps routingAdapter = "user-choice" → remoteAllowed === true.
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    // Default the availability hook to "up" so the server affordance shows. The
    // real hook fires a bounded probe on mount that fail-closes to false in jsdom
    // (no fetch), which would otherwise suppress the button mid-`waitFor`. Cases
    // that exercise suppression override this spy.
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(true);
    // Defensive reset: ensure on-device default even if a sibling file left a different mode.
    useSettingsStore.setState({
      routingMode: "on-device",
      routingProvider: "operator",
    });

    // The auto-search effect copies engineError out of the store into local
    // state, which makes <RouteResults> render the engine-failure surface (and,
    // with remoteAllowed true, the "Search on the server" button). Each call to
    // the spy leaves engineError set so the surface persists; the spy records
    // the 4th `opts` arg so we can assert `{ remote: true }` on the re-run.
    searchSpy = vi.fn().mockImplementation(async () => {
      useRoutingStore.setState({
        results: [],
        error: null,
        engineError: "wasm failed to load",
        engineFailureKind: "import",
        loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [],
      error: null,
      engineError: null,
      engineFailureKind: null,
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
    await seedLegacyCityProjection();
    await db.gtfsStops.bulkPut([
      { id: "stop-a", name: "Alpha", lat: 50.1, lon: 19.9 },
      { id: "stop-b", name: "Beta", lat: 50.2, lon: 20.0 },
    ]);
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("clicking 'Search on the server' re-runs the held query with { remote: true }", async () => {
    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // Auto-search fires once with the held (stop-a → stop-b) query and surfaces
    // the engine error.
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    // First (auto) search is local — no remote opt-in.
    expect(searchSpy.mock.calls[0][3]).toBeUndefined();

    // remoteAllowed is true at `standard`, so the remote button is present.
    const serverButton = await screen.findByTestId("engine-failure-search-server");

    searchSpy.mockClear();
    fireEvent.click(serverButton);

    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    // The held query re-runs through the gated pt-serve planner: same endpoints,
    // a Date, and the 4th arg `{ remote: true }`.
    expect(searchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stop", stopId: "stop-a" }),
      expect.objectContaining({ kind: "stop", stopId: "stop-b" }),
      expect.any(Date),
      { remote: true },
    );
  });

  // Stale-guard regression: the remote /plan RTT can outlive
  // a query-identity change. The guard in handleSearchOnServer mirrors the main
  // auto-search effect's re-fire triggers (from/to/paginationTime AND ranking/
  // excludedModes). A `ranking` flip mid-RTT must mark the in-flight remote
  // result STALE so it cannot clobber the newer query's state. (Mirrors the
  // controlled-mid-await-mutation idiom in stopStore.test.ts.)
  it("does NOT apply a stale remote result after ranking flips mid-RTT", async () => {
    // Control the remote (4th-arg `{ remote: true }`) search via a deferred we
    // resolve by hand. The FIRST auto-search call sets the engine error (so the
    // server button mounts); the ranking-flip re-fire (a LATER auto-search) sets
    // a CLEAN empty state — so the only thing that could put "stale-remote-error"
    // on screen is the stale remote .then bypassing the guard.
    let resolveRemote!: () => void;
    const remoteSettled = new Promise<void>((res) => { resolveRemote = res; });
    let autoCalls = 0;
    const spy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        // Hold pending; then publish a DISTINCT error that, if (wrongly) applied
        // by a guard that missed the ranking flip, becomes the visible surface.
        await remoteSettled;
        useRoutingStore.setState({
          results: [], error: "stale-remote-error",
          engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      autoCalls += 1;
      if (autoCalls === 1) {
        useRoutingStore.setState({
          results: [], error: null,
          engineError: "wasm failed to load", engineFailureKind: "import", loading: false,
        });
      } else {
        // Ranking-flip re-fire: clean empty state, no engine/search error. The
        // empty-results surface (with the server button) shows — NOT an error.
        useRoutingStore.setState({
          results: [], error: null,
          engineError: null, engineFailureKind: null, loading: false,
        });
      }
    });
    useRoutingStore.setState({ ranking: "fastest", search: spy });

    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // Auto-search surfaces the engine error → the server button is present.
    const serverButton = await screen.findByTestId("engine-failure-search-server");
    spy.mockClear();
    fireEvent.click(serverButton);
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.any(Date), { remote: true },
      ),
    );

    // Flip ranking WHILE the remote /plan is still pending. This re-fires the
    // main auto-search effect (ranking is in its deps) and, critically, advances
    // latestQueryRef.current.ranking so the in-flight remote result is now stale.
    fireEvent.click(screen.getByRole("tab", { name: /fewest transfers/i }));

    // Now resolve the stale remote result and let its .then chain run.
    await act(async () => {
      resolveRemote();
      await remoteSettled;
    });
    // The stale result must NOT clobber: its distinct error never renders. With a
    // narrow from/to/at-only guard this assertion FAILS (the stale .then runs
    // setSearchError("stale-remote-error")). The ranking-aware guard skips it.
    await waitFor(() => {
      expect(screen.queryByText("stale-remote-error")).not.toBeInTheDocument();
    });
  });

  // Recovery affordance is NOT availability-gated (headline
  // fix): the engine-failure "Search on the server" button is the no-wasm user's
  // ONLY route — their on-device engine can't run. Gating it on a fail-closed
  // probe of the Node /health/ready (a DIFFERENT process than the pt-serve /plan
  // that serves the recovery) would strand them on a wrong/transient probe. The
  // real fallback fires on the actual plan() rejection. So: the recovery
  // button is present whenever `remoteAllowed`, INCLUDING availability false.
  it("offers the engine-failure recovery button even when the remote source is unavailable", async () => {
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(false);
    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // Auto-search fires and surfaces the engine error.
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    // The engine-failure surface is on screen…
    await screen.findByTestId("engine-error");
    // …and the recovery button is STILL present despite availability false: it
    // gates on the privacy ceiling only, never on the availability probe.
    expect(await screen.findByTestId("engine-failure-search-server")).toBeInTheDocument();
  });

  it("offers the engine-failure recovery button when the remote source is available", async () => {
    vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("engine-failure-search-server")).toBeInTheDocument();
  });

  // The EMPTY-STATE nicety (on-device ran and found nothing) IS availability-
  // gated: suppressing a dead "try the server" button is cheap on a hint,
  // and there's no recovery imperative — on-device already produced a result
  // (just empty). So `empty-search-server` is present when available, ABSENT
  // when the source is probed-unavailable.
  describe("empty-state 'Search on the server' nicety is availability-gated", () => {
    beforeEach(() => {
      // Drive a CLEAN empty on-device result (no engine error) so the generic
      // empty-results surface renders — that's where the empty-state button lives.
      searchSpy = vi.fn().mockImplementation(async () => {
        useRoutingStore.setState({
          results: [],
          error: null,
          engineError: null,
          engineFailureKind: null,
          loading: false,
        });
      });
      useRoutingStore.setState({ search: searchSpy });
    });

    it("offers the empty-state button when the remote source is available", async () => {
      vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(true);
      render(
        <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
          <SearchPage />
        </MemoryRouter>,
      );

      await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
      expect(await screen.findByTestId("empty-search-server")).toBeInTheDocument();
    });

    it("suppresses the empty-state button when the remote source is unavailable", async () => {
      vi.spyOn(availability, "useRemoteRoutingAvailable").mockReturnValue(false);
      render(
        <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
          <SearchPage />
        </MemoryRouter>,
      );

      await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
      // Let the empty-results surface settle, then assert the nicety is gone.
      await waitFor(() =>
        expect(screen.getByText(/No routes found/i)).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("empty-search-server")).not.toBeInTheDocument();
    });
  });
});
