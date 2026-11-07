import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
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
import type { RaptorIndex } from "../../src/services/raptorIndex.ts";

const emptyRaptorIndex: RaptorIndex = {
  routes: [],
  routeIdToIdx: new Map(),
  routesAtStop: new Map(),
  services: new Map(),
};

// Wiring contract (standing choice): in
// `provider-fallback` mode an on-device failure OR empty result AUTO-re-runs the
// SAME query on the server with `{ remote: true }` — NO button click. The setting
// itself is the routing choice. The default `on-device` mode keeps the recovery button
// path and never auto-falls-back. Gated by the operator routing decision
// (`canUse("operator.remote-routing")`), allowed in these cases.
describe("Search provider-fallback auto-fallback", () => {
  beforeEach(async () => {
    // The standing remote mode was chosen in Settings, which allowed the
    // routing flows it uses.
    usePrivacyStore.setState({ level: "standard", overrides: {} });
    resetFlows();
    allowFlow("operator.remote-routing");
    allowFlow("external.remote-routing", "transitous");
    useSettingsStore.setState({
      routingMode: "provider-fallback",
      routingProvider: "operator",
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

  afterEach(() => {
    // Reset privacy so this test's level doesn't leak to sibling tests.
    usePrivacyStore.setState({ level: "standard", overrides: {} });
  });

  it("auto-re-runs with { remote: true } after an on-device engine error (no click)", async () => {
    // The on-device (no-opts) search sets an engineError in the store; the remote
    // (`{ remote: true }`) re-run lands a clean empty result so the chain settles.
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null,
        engineError: "wasm failed to load", engineFailureKind: "import", loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // The remote re-run fires AUTOMATICALLY — no button click — once the on-device
    // engineError settles. Assert a 4th-arg `{ remote: true }` call appeared.
    await waitFor(() => {
      const remoteCall = searchSpy.mock.calls.find(
        (c) => c[3] && (c[3] as { remote?: boolean }).remote === true,
      );
      expect(remoteCall).toBeTruthy();
    });
    // And it carried the held query (stop-a → stop-b, a Date, { remote: true }).
    const remoteCall = searchSpy.mock.calls.find(
      (c) => c[3] && (c[3] as { remote?: boolean }).remote === true,
    )!;
    expect(remoteCall[0]).toEqual(expect.objectContaining({ kind: "stop", stopId: "stop-a" }));
    expect(remoteCall[1]).toEqual(expect.objectContaining({ kind: "stop", stopId: "stop-b" }));
    expect(remoteCall[2]).toEqual(expect.any(Date));
  });

  it("does NOT auto-fallback in on-device mode (default)", async () => {
    useSettingsStore.setState({ routingMode: "on-device" });
    const searchSpy = vi.fn().mockImplementation(async () => {
      useRoutingStore.setState({
        results: [], error: null,
        engineError: "wasm failed to load", engineFailureKind: "import", loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // The on-device auto-search fires once and surfaces the engine error.
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    // Give any (incorrect) auto-fallback a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    // In on-device mode the per-event button is the ONLY remote path — no
    // automatic `{ remote: true }` call without a click.
    expect(
      searchSpy.mock.calls.some((c) => c[3] && (c[3] as { remote?: boolean }).remote === true),
    ).toBe(false);
  });

  it("auto-re-runs with { remote: true } when on-device results.length === 0 with no error", async () => {
    // Headline path ( reachable-but-empty on device): on-device search settles
    // with an empty result and NO engineError/error → auto-fallback fires.
    // The remote re-run lands a clean empty result so the chain settles.
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      // On-device: empty result, no error.
      useRoutingStore.setState({
        results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // Remote re-run fires automatically because the on-device result was empty.
    await waitFor(() => {
      expect(
        searchSpy.mock.calls.some((c) => (c[3] as { remote?: boolean } | undefined)?.remote === true),
      ).toBe(true);
    });
    // Remote call carries the expected endpoints.
    const remoteCall = searchSpy.mock.calls.find(
      (c) => (c[3] as { remote?: boolean } | undefined)?.remote === true,
    )!;
    expect(remoteCall[0]).toEqual(expect.objectContaining({ kind: "stop", stopId: "stop-a" }));
    expect(remoteCall[1]).toEqual(expect.objectContaining({ kind: "stop", stopId: "stop-b" }));
    expect(remoteCall[2]).toEqual(expect.any(Date));
  });

  it("surfaces remote error and settles loading when auto-fallback remote re-run itself fails", async () => {
    // Terminal-state pin: auto-fallback fires AND the remote call sets an engineError.
    // Assert: engine-error surface renders, loading settles false, remote called exactly once.
    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        // Remote also fails with an engineError.
        useRoutingStore.setState({
          results: [], error: null,
          engineError: "remote engine failed", engineFailureKind: "import", loading: false,
        });
        return;
      }
      // On-device: engine error → triggers auto-fallback.
      useRoutingStore.setState({
        results: [], error: null,
        engineError: "wasm failed to load", engineFailureKind: "import", loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // Wait for the remote call to have fired (the auto-fallback fired + remote ran).
    await waitFor(() => {
      expect(
        searchSpy.mock.calls.some((c) => (c[3] as { remote?: boolean } | undefined)?.remote === true),
      ).toBe(true);
    });

    // engine-error surface must appear (remote engineError surfaced to the UI).
    await waitFor(() => {
      expect(getByTestId("engine-error")).toBeTruthy();
    });

    // Remote search called exactly once — no re-loop.
    const remoteCalls = searchSpy.mock.calls.filter(
      (c) => (c[3] as { remote?: boolean } | undefined)?.remote === true,
    );
    expect(remoteCalls).toHaveLength(1);
  });

  // Decision gate regression: with `provider-fallback` as the standing mode,
  // the auto-fallback effect must NOT fire a remote call while the operator's
  // routing is denied. The `remoteAllowed &&` guard in the auto-fallback
  // condition is the load-bearing gate this test validates.
  it("does NOT auto-fallback while remote routing is denied", async () => {
    denyFlow("operator.remote-routing");

    const searchSpy = vi.fn().mockImplementation(async (_from, _to, _at, opts?: { remote?: boolean }) => {
      if (opts?.remote) {
        useRoutingStore.setState({
          results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
        });
        return;
      }
      useRoutingStore.setState({
        results: [], error: null,
        engineError: "wasm failed to load", engineFailureKind: "import", loading: false,
      });
    });
    useRoutingStore.setState({
      ranking: "fastest",
      results: [], error: null, engineError: null, engineFailureKind: null, loading: false,
      search: searchSpy,
    });

    render(
      <MemoryRouter initialEntries={["/search?fromStopId=stop-a&toStopId=stop-b"]}>
        <SearchPage />
      </MemoryRouter>,
    );

    // The on-device auto-search fires and surfaces the engine error.
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(1));
    // Give any (incorrect) auto-fallback a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    // With remote routing denied the auto-fallback MUST NOT fire a remote call,
    // even though routingMode is provider-fallback.
    expect(
      searchSpy.mock.calls.some((c) => (c[3] as { remote?: boolean } | undefined)?.remote === true),
    ).toBe(false);
  });
});
