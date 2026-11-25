import { seedLegacyCityProjection } from "../../src/test-helpers/cityData.ts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "../../src/pages/Search.tsx";
import { db } from "../../src/db/index.ts";
import { useSettingsStore } from "../../src/stores/settingsStore.ts";
import { useRoutingStore } from "../../src/stores/routingStore.ts";
import { useGtfsDataStore } from "../../src/stores/gtfsDataStore.ts";
import { useCityStore } from "../../src/stores/cityStore.ts";
import { usePrivacyStore } from "../../src/stores/privacyStore.ts";
import { allowFlow, denyFlow, resetFlows } from "../../src/test-helpers/networkDecisions.ts";
import * as connectivity from "../../src/hooks/useConnectivity.ts";
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

vi.mock(
  "../../src/components/RouteResults/TransitousPanel.tsx",
  () => ({
    TransitousPanel: ({ onFallback }: { onFallback?: () => void }) => (
      <button data-testid="transitous-primary" onClick={onFallback}>
        transitous primary
      </button>
    ),
  }),
);

const emptyRaptorIndex: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map(),
};

// A minimal RtComposedItinerary-shaped result so convertRaptorResults produces a
// non-empty itinerary list (the shape the store's `results` array carries). A
// single zero-leg itinerary is enough to make `itineraries.length > 0`.
const nonEmptyResults = [
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

// Wiring contract (design A'): in `remote-primary`
// mode the SERVER is the primary planner — BUT the current `{ remote: true }`
// transport still resolves coords→stops and composes/overlays via the local
// index, so remote-primary requires the GTFS index loaded just like every other
// mode (C1). The auto-search effect waits for the index, then fires
// `{ remote: true }` FIRST. On a plan() rejection (store `error`/`engineError`
// set) it ALWAYS falls back to on-device (the index is loaded) and SIGNALS it
// (the transient banner); `navigator.onLine` (read via the `isDeviceOnline()`
// seam) only PICKS the banner copy. A reachable-but-empty remote result is the
// distinct `serverEmpty` state (no on-device retry). While remote routing is
// not allowed the mode is inert → the on-device-first path runs.
describe("Search remote-primary flow", () => {
  beforeEach(async () => {
    // These tests control readiness explicitly; startup must not replace the
    // deliberately absent index from the endpoint-resolution cache fixture.
    vi.spyOn(useGtfsDataStore.getState(), "init").mockResolvedValue(undefined);
    // The standing remote mode was chosen in Settings, which allowed the
    // routing flows it uses.
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    resetFlows();
    allowFlow("operator.remote-routing");
    allowFlow("external.remote-routing", "transitous");
    useSettingsStore.setState({
      routingMode: "remote-primary",
      routingProvider: "operator",
    });

    const activeCityId = useCityStore.getState().activeCity.id;
    // Index PRESENT (non-null), not syncing, city matches — so the new GTFS-ready
    // guard (C1) passes for every scenario except the dedicated index-guard test,
    // which overrides this with raptorIndex: null.
    useGtfsDataStore.setState({
      raptorIndex: emptyRaptorIndex,
      ptRouter: null,
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
    // Unmount the component FIRST (this repo's vitest config does not register
    // RTL auto-cleanup), so the store resets below cannot re-render a live
    // SearchPage and re-fire the routing effect against a torn-down search spy.
    cleanup();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    // Reset privacy AND the routing mode so this file's `remote-primary` mode
    // doesn't leak into sibling test files (a stray mount under remote-primary
    // would fire the server branch against their not-yet-installed search spy).
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    useSettingsStore.setState({
      routingMode: "on-device",
      routingProvider: "operator",
    });
  });

  function renderSearch() {
    return render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );
  }

  // (1) remote-primary fires the SERVER first (with the index present).
  it("fires the server first with { remote: true }", async () => {
    const searchSpy = vi.fn().mockImplementation(async () => {
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    await waitFor(() => expect(searchSpy).toHaveBeenCalled());
    // The FIRST search call is the remote one (server primary): 4th arg { remote: true }.
    expect(searchSpy.mock.calls[0][3]).toEqual({ remote: true });
    expect(searchSpy.mock.calls[0][0]).toEqual(expect.objectContaining({ kind: "stop", stopId: "stop-a" }));
    expect(searchSpy.mock.calls[0][1]).toEqual(expect.objectContaining({ kind: "stop", stopId: "stop-b" }));
    expect(searchSpy.mock.calls[0][2]).toEqual(expect.any(Date));
  });

  it("dispatches remote-primary through transitous and falls back locally on failure", async () => {
    useSettingsStore.setState({
      routingMode: "remote-primary",
      routingProvider: "transitous",
    });
    const searchSpy = vi.fn().mockImplementation(async () => {
      useRoutingStore.setState({
        results: [],
        error: null,
        engineError: null,
        engineFailureKind: null,
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

    renderSearch();

    const transitousPrimary = await screen.findByTestId("transitous-primary");
    expect(screen.queryByTestId("sort-summary")).not.toBeInTheDocument();
    expect(searchSpy).not.toHaveBeenCalled();
    fireEvent.click(transitousPrimary);

    await waitFor(() => expect(searchSpy).toHaveBeenCalled());
    expect(searchSpy.mock.calls[0][3]).toBeUndefined();
    await waitFor(() =>
      expect(screen.queryByTestId("transitous-primary")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("sort-summary")).toBeInTheDocument();
  });

  it("never shows Transitous plans while a route filter is active", async () => {
    const activeCity = useCityStore.getState().activeCity;
    useSettingsStore.setState({
      routingMode: "remote-primary",
      routingProvider: "transitous",
      excludedRouteGroupsByCity: { [activeCity.id]: ["night:BUS"] },
    });
    useGtfsDataStore.setState({
      raptorIndex: {
        ...emptyRaptorIndex,
        routes: [
          { id: "a", mode: "BUS", networkId: "city" },
          { id: "b", mode: "BUS", networkId: "night" },
        ],
      } as unknown as RaptorIndex,
    });
    const searchSpy = vi.fn().mockResolvedValue(undefined);
    useRoutingStore.setState({ results: [], error: null, engineError: null, loading: false, search: searchSpy });

    renderSearch();

    await waitFor(() => expect(searchSpy).toHaveBeenCalled());
    expect(screen.queryByTestId("transitous-primary")).not.toBeInTheDocument();
    useSettingsStore.setState({ excludedRouteGroupsByCity: {} });
  });

  // (2) remote success → itineraries + indicator, no banner.
  it("remote success renders itineraries and the indicator, no fallback banner", async () => {
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: nonEmptyResults, error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    // The standing-mode indicator says "Routing on server".
    await waitFor(() =>
      expect(screen.getByTestId("routing-mode-indicator")).toHaveTextContent("Routing on server"),
    );
    // Itineraries rendered (the empty/no-routes copy is absent).
    await waitFor(() =>
      expect(screen.queryByTestId("server-no-route")).not.toBeInTheDocument(),
    );
    // No fallback banner on a clean remote success.
    expect(screen.queryByTestId("routing-fallback-notice")).not.toBeInTheDocument();
    // Server called exactly once (no on-device retry on success).
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  // (3) remote reachable-but-empty → server-no-route, no on-device retry.
  it("remote reachable-but-empty shows server-no-route and does not retry on-device", async () => {
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    await waitFor(() =>
      expect(screen.getByTestId("server-no-route")).toHaveTextContent("The server found no route for this trip."),
    );
    // No on-device fallback call — the server was reachable, just empty.
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("routing-fallback-notice")).not.toBeInTheDocument();
  });

  // (4) remote rejection, online → ALWAYS falls back (the index is loaded) +
  // fallback-server banner. Asserts the on-device itineraries actually RENDER
  // (review finding I2 — not just the banner).
  it("remote rejection while online falls back to on-device, renders routes, clears loading", async () => {
    vi.spyOn(connectivity, "isDeviceOnline").mockReturnValue(true);
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: [], error: "boom", engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      // On-device fallback: clean non-empty result.
      useRoutingStore.setState({
        results: nonEmptyResults, error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    await waitFor(() =>
      expect(screen.getByTestId("routing-fallback-notice")).toHaveTextContent("Server unavailable — showing on-device routes"),
    );
    // The recovered on-device itineraries actually render (I2): an itinerary card
    // is present. Because RouteResults shows EITHER the loading skeleton OR the
    // itinerary list, a rendered card also proves `loading` was cleared.
    await waitFor(() => {
      expect(screen.queryByTestId("server-no-route")).not.toBeInTheDocument();
      expect(screen.getByTestId("itinerary-card")).toBeInTheDocument();
    });
    // Two calls: remote first, then on-device fallback.
    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(searchSpy.mock.calls[0][3]).toEqual({ remote: true });
    expect(searchSpy.mock.calls[1][3]).toBeUndefined();
  });

  // (5) remote rejection, offline → fallback-offline banner.
  it("remote rejection while offline falls back with the offline banner", async () => {
    vi.spyOn(connectivity, "isDeviceOnline").mockReturnValue(false);
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: [], error: "boom", engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: nonEmptyResults, error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    await waitFor(() =>
      expect(screen.getByTestId("routing-fallback-notice")).toHaveTextContent("Offline — showing on-device routes"),
    );
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(2));
  });

  // (6') index-guard (C1): remote-primary, remote allowed, but the GTFS index is
  // NOT loaded → the server must NOT be fired index-free (the effect waits). Once
  // the index lands and the effect re-triggers, the remote `{ remote: true }`
  // search fires exactly once.
  it("waits for the local index before firing the server (index-guard)", async () => {
    const activeCityId = useCityStore.getState().activeCity.id;
    // No raptorIndex → on-device routing AND the index-dependent remote transport
    // are both unavailable; the effect's GTFS-ready guard holds.
    useGtfsDataStore.setState({
      raptorIndex: null,
      ptRouter: null,
      stopNames: new Map(),
      loadedCityId: activeCityId,
      syncing: false,
    });
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: nonEmptyResults, error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    // The endpoints resolve from the URL params; give the effect a chance to run.
    // With a null index the server is NOT fired.
    await new Promise((r) => setTimeout(r, 50));
    expect(searchSpy).not.toHaveBeenCalled();

    // Index lands → the effect re-triggers (raptorReady dep flips) → the remote
    // search fires exactly once.
    await act(async () => {
      useGtfsDataStore.setState({ raptorIndex: emptyRaptorIndex });
    });
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    expect(searchSpy.mock.calls[0][3]).toEqual({ remote: true });
  });

  // (7) remote-primary without an allowed decision behaves as on-device-first; no indicator.
  it("while remote routing is denied behaves as on-device-first (no { remote: true } first call, no indicator)", async () => {
    denyFlow("operator.remote-routing");
    const searchSpy = vi.fn().mockImplementation(async () => {
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    await waitFor(() => expect(searchSpy).toHaveBeenCalled());
    // The on-device-first path ran: the first call has NO { remote: true }.
    expect(searchSpy.mock.calls[0][3]).toBeUndefined();
    // The indicator is inert while remote routing is denied.
    expect(screen.queryByTestId("routing-mode-indicator")).not.toBeInTheDocument();
  });

  // (8) stale-guard (coverage C1): the remote /plan RTT can outlive a query
  // change. A `ranking` flip mid-RTT must mark the in-flight remote result STALE
  // so it can't clobber the newer query's state. (Mirrors the deferred-promise
  // idiom in Search.searchServer.test.tsx.)
  it("does NOT apply a stale remote result after ranking flips mid-RTT", async () => {
    let resolveRemote!: () => void;
    const remoteSettled = new Promise<void>((res) => { resolveRemote = res; });
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        // Hold pending; then publish a DISTINCT error that, if (wrongly) applied
        // past the stale guard, becomes the visible surface.
        await remoteSettled;
        useRoutingStore.setState({
          results: [], error: "stale-remote-error", engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    // The remote search fired and is pending.
    await waitFor(() =>
      expect(searchSpy).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.any(Date), { remote: true },
      ),
    );

    // Flip ranking WHILE the remote /plan is still pending. This re-fires the main
    // auto-search effect (ranking is in its deps) and advances
    // latestQueryRef.current.ranking so the in-flight remote result is now stale.
    fireEvent.click(screen.getByTestId("sort-summary"));
    fireEvent.click(screen.getByRole("button", { name: /fewest transfers/i }));

    // Resolve the stale remote result and let its .then chain run.
    await act(async () => {
      resolveRemote();
      await remoteSettled;
    });

    // The stale result must NOT clobber: its distinct error never renders.
    await waitFor(() => {
      expect(screen.queryByText("stale-remote-error")).not.toBeInTheDocument();
    });
  });

  // (9) dedup (no double egress): a remote-primary search fired once must NOT
  // re-fire the server when only a readiness dep flips (e.g. ptRouter lands) with
  // the query unchanged.
  it("restarts a pending remote-primary attempt after GTFS refresh with the same endpoints", async () => {
    let resolveOld!: () => void, resolveCurrent!: () => void;
    const older = new Promise<void>((resolve) => { resolveOld = resolve; });
    const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
    let calls = 0;
    const search = vi.fn().mockImplementation(async () => {
      const call = ++calls;
      useRoutingStore.setState({ results: [], error: null, engineError: null, engineFailureKind: null, loading: true });
      if (call === 1) { await older; return; }
      await current;
      useRoutingStore.setState({ results: [], error: null, engineError: null, engineFailureKind: null, loading: false });
    });
    useRoutingStore.setState({ search, origin: { kind: "mappoint", lat: 54.7, lon: 25.3 }, destination: { kind: "mappoint", lat: 54.71, lon: 25.31 } });
    const view = renderSearch();
    try {
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      await act(async () => { useGtfsDataStore.setState({ syncing: true }); });
      await act(async () => { useGtfsDataStore.setState({ syncing: false }); });
      await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
      expect(search.mock.calls[1][0]).toBe(search.mock.calls[0][0]);
      expect(search.mock.calls[1][1]).toBe(search.mock.calls[0][1]);
      expect(search.mock.calls.every((call) => call[3]?.remote === true)).toBe(true);
      await act(async () => { resolveOld(); await older; });
      expect(screen.queryByTestId("server-no-route")).not.toBeInTheDocument();
      expect(view.container.querySelectorAll(".h-20.animate-pulse")).toHaveLength(3);
      await act(async () => { resolveCurrent(); await current; });
      expect(await screen.findByTestId("server-no-route")).toBeInTheDocument();
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => { resolveOld(); resolveCurrent(); await Promise.allSettled([older, current]); });
    }
  });

  it("preserves a pending attempt on a readiness-only change", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const search = vi.fn().mockImplementation(async () => {
      await pending;
      useRoutingStore.setState({ results: [], error: null, engineError: null, engineFailureKind: null, loading: false });
    });
    useRoutingStore.setState({ search });
    renderSearch();
    try {
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      await act(async () => { useGtfsDataStore.setState({ ptRouter: {} as never }); });
      await act(async () => { finish(); await pending; });
      expect(await screen.findByTestId("server-no-route")).toBeInTheDocument();
      expect(search).toHaveBeenCalledTimes(1);
    } finally { await act(async () => { finish(); await pending; }); }
  });

  it("does not start fallback after unmount", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const search = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        await pending;
        useRoutingStore.setState({ results: [], error: "server failed after leaving", engineError: null, engineFailureKind: null, loading: false });
      } else useRoutingStore.setState({ results: [], error: null, engineError: null, engineFailureKind: null, loading: false });
    });
    useRoutingStore.setState({ search });
    const view = renderSearch();
    try {
      await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      view.unmount();
      await act(async () => { finish(); await pending; });
      expect(search).toHaveBeenCalledTimes(1);
    } finally { await act(async () => { finish(); await pending; }); }
  });

  it("does not re-leave the device when only a readiness dep flips (dedup)", async () => {
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: nonEmptyResults, error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    expect(searchSpy.mock.calls[0][3]).toEqual({ remote: true });

    // Flip ONLY a readiness dep (ptRouter lands). The query is unchanged → the
    // dedup latch must suppress a re-fire.
    await act(async () => {
      useGtfsDataStore.setState({ ptRouter: {} as never });
    });
    // Give the effect a chance to (not) re-fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  // (10) dedup reset on mode flip-back (I1): firing remote-primary for query Q,
  // then switching to on-device (clears the latch), then back to remote-primary
  // with Q unchanged must re-query the server (the latch was reset).
  it("re-queries the server after a flip to on-device and back (dedup latch reset)", async () => {
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: nonEmptyResults, error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    renderSearch();

    // Initial remote-primary fire for query Q.
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    expect(searchSpy.mock.calls[0][3]).toEqual({ remote: true });

    // Flip to on-device — the on-device path runs and clears the dedup latch.
    await act(async () => {
      useSettingsStore.setState({ routingMode: "on-device" });
    });
    await waitFor(() =>
      expect(searchSpy.mock.calls.some((c) => c[3] === undefined)).toBe(true),
    );
    const callsAfterOnDevice = searchSpy.mock.calls.length;

    // Flip back to remote-primary with Q unchanged — the latch was reset, so the
    // server is re-queried.
    await act(async () => {
      useSettingsStore.setState({ routingMode: "remote-primary" });
    });
    await waitFor(() =>
      expect(searchSpy.mock.calls.length).toBeGreaterThan(callsAfterOnDevice),
    );
    // The newest call is a remote one.
    const lastCall = searchSpy.mock.calls[searchSpy.mock.calls.length - 1];
    expect(lastCall[3]).toEqual({ remote: true });
  });
});
