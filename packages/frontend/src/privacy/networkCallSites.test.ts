/**
 * Every optional network call site resolves its own flow at the request
 * boundary: while the decision is `unset` or `denied` it sends nothing, and it
 * sends again once the flow is granted. The protection level plays no part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RaptorQuery } from "@pt/shared";
import { api } from "../services/api.ts";
import { backendDeparturesAllowed, liveTileOverlayAllowed } from "../services/departuresPolicy.ts";
import { RtPoller } from "../services/rtPoller.ts";
import { fetchBasemapStyle } from "../services/basemapPrivacy.ts";
import { makeRemoteStopPlanner, RoutingNotAllowedError } from "../services/routingSource.ts";
import { planViaTransitous } from "../services/transitousClient.ts";
import {
  canUseRemoteStopSearch,
  chooseRoutingMode,
  chooseSearchProvider,
  grantRemoteRouting,
} from "../services/routingAccess.ts";
import { ThirdPartyGeocoderAdapter } from "../services/geocoder/ThirdPartyGeocoderAdapter.ts";
import { geocoderRegistry } from "../services/geocoder/instance.ts";
import {
  registerSelfHostedGeocoder,
  unregisterSelfHostedGeocoder,
} from "../services/geocoder/registerSelfHosted.ts";
import { resolvePoiFetchMode } from "../services/poiFetchMode.ts";
import {
  sendEngineFailureReport,
  sendEngineFailureReportOnRequest,
} from "../services/engineFailureReport.ts";
import {
  setThirdPartyEgressAccessor,
  __resetThirdPartyEgressAccessorForTests,
  searchSuggestions,
} from "../services/searchSuggestions.ts";
import { applyMapMode } from "../map/mapMode.ts";
import { usePrivacyStore } from "../stores/privacyStore.ts";
import { useSettingsStore } from "../stores/settingsStore.ts";
import { canUse, getNetworkDecision } from "./canUse.ts";
import { allowFlow, denyFlow, resetFlows } from "../test-helpers/networkDecisions.ts";

vi.mock("../buildInfo.ts", () => ({
  buildInfo: { version: "test-version", commit: "abc", builtAt: "2026-01-01" },
}));

const OFF: [string, (flowId: string, providerId?: string) => void][] = [
  ["unset", () => resetFlows()],
  ["denied", (flowId, providerId) => denyFlow(flowId, providerId)],
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetFlows();
  // The most permissive level: the level must not open any flow.
  usePrivacyStore.setState({ level: "baseline", overrides: {} });
  fetchSpy = vi.fn(async () => jsonResponse([]));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  resetFlows();
  usePrivacyStore.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(OFF)("while the decision is %s", (_state, off) => {
  it("live departures and the live overlay stay off", () => {
    off("operator.realtime");
    expect(backendDeparturesAllowed()).toBe(false);
    expect(liveTileOverlayAllowed()).toBe(false);
  });

  it("the real-time poller sends nothing", async () => {
    vi.useFakeTimers();
    try {
      off("operator.realtime");
      const fetchRouteRt = vi.spyOn(api, "fetchRouteRt").mockResolvedValue({
        routeId: "r1",
        trips: [],
        generatedAt: 0,
      });
      const poller = new RtPoller();
      poller.subscribe("r1", vi.fn());
      poller.start();
      await vi.advanceTimersByTimeAsync(120_000);
      poller.stop();
      expect(fetchRouteRt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the detailed map style is not fetched", async () => {
    off("external.detailed-basemap", "carto");
    const fetchImpl = vi.fn();
    await expect(
      fetchBasemapStyle({
        providerId: "carto",
        dark: false,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the operator's planner is not called", async () => {
    off("operator.remote-routing");
    const plan = vi.fn(async () => []);
    const planner = makeRemoteStopPlanner(plan);
    await expect(
      planner(
        {
          entryStops: [{ stopId: "A", walkSecs: 0 }],
          exitStops: [{ stopId: "B", walkSecs: 0 }],
          departureSecs: 0,
          maxRounds: 3,
        } as unknown as RaptorQuery,
        "20260624",
      ),
    ).rejects.toBeInstanceOf(RoutingNotAllowedError);
    expect(plan).not.toHaveBeenCalled();
  });

  it("Transitous is not asked, even with the operator's routing allowed", async () => {
    allowFlow("operator.remote-routing");
    off("external.remote-routing", "transitous");
    await expect(
      planViaTransitous({
        from: { lat: 1, lon: 2 },
        to: { lat: 3, lon: 4 },
        departAtIso: "2026-06-26T08:00:00Z",
      }),
    ).rejects.toBeInstanceOf(RoutingNotAllowedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a third-party place search provider is not asked", async () => {
    off("external.place-search", "nominatim");
    const adapter = new ThirdPartyGeocoderAdapter(
      { provider: "nominatim", endpoint: "https://nominatim.openstreetmap.org" },
      () => ({ m10CoarsenGridDefaultMeters: 500 }),
    );
    expect(adapter.isAvailable()).toBe(false);
    await expect(
      adapter.forward("Gdansk", null, new AbortController().signal),
    ).rejects.toThrow(/not available/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the operator's place search is not asked and POIs stay local", async () => {
    off("operator.place-search");
    geocoderRegistry.setActiveModeAccessor(() => "server-side");
    try {
      registerSelfHostedGeocoder({
        kind: "self-hosted",
        endpoint: "https://geo.example",
        flavor: "nominatim",
        multiTenant: false,
      });
      await geocoderRegistry.forward("museum", null, new AbortController().signal);
      expect(fetchSpy).not.toHaveBeenCalled();
      useSettingsStore.setState({ poiFetchModeOverride: "server-side" });
      expect(resolvePoiFetchMode("vilnius")).toBe("eager-bundle");
    } finally {
      unregisterSelfHostedGeocoder();
      geocoderRegistry.setActiveModeAccessor(() => "eager-bundle");
      useSettingsStore.setState({ poiFetchModeOverride: undefined });
    }
  });

  it("remote stop search falls back to the local scan", async () => {
    off("external.stop-search");
    const searchStops = vi.spyOn(api, "searchStops").mockResolvedValue({ data: [] } as never);
    setThirdPartyEgressAccessor(canUseRemoteStopSearch);
    try {
      await searchSuggestions("Central", "gdansk", null, new AbortController().signal, "remote");
      expect(searchStops).not.toHaveBeenCalled();
    } finally {
      __resetThirdPartyEgressAccessorForTests();
    }
  });

  it("no diagnostic report is sent without the explicit action", async () => {
    off("operator.client-report");
    const send = vi.spyOn(api, "sendClientReport").mockResolvedValue(undefined);
    await sendEngineFailureReport("import");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("after a grant", () => {
  it("live departures resume", async () => {
    vi.useFakeTimers();
    try {
      denyFlow("operator.realtime");
      const fetchRouteRt = vi.spyOn(api, "fetchRouteRt").mockResolvedValue({
        routeId: "r1",
        trips: [],
        generatedAt: 0,
      });
      const poller = new RtPoller();
      poller.subscribe("r1", vi.fn());
      poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchRouteRt).not.toHaveBeenCalled();
      allowFlow("operator.realtime");
      expect(backendDeparturesAllowed()).toBe(true);
      expect(liveTileOverlayAllowed()).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      poller.stop();
      expect(fetchRouteRt).toHaveBeenCalledWith("r1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("picking the detailed map records the decision and the style is fetched", async () => {
    applyMapMode("detailed", { setMapDetailMode: vi.fn() });
    expect(getNetworkDecision("external.detailed-basemap", "carto")).toEqual({
      value: "allowed",
      source: "settings",
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ version: 8, sources: {}, layers: [] }));
    await expect(
      fetchBasemapStyle({
        providerId: "carto",
        dark: false,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).resolves.not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("choosing a remote routing mode lets the operator's planner run", async () => {
    useSettingsStore.setState({ routingMode: "on-device", routingProvider: "operator" });
    chooseRoutingMode("provider-fallback");
    expect(canUse("operator.remote-routing")).toBe(true);
    const plan = vi.fn(async () => []);
    await makeRemoteStopPlanner(plan)(
      {
        entryStops: [{ stopId: "A", walkSecs: 0 }],
        exitStops: [{ stopId: "B", walkSecs: 0 }],
        departureSecs: 0,
        maxRounds: 3,
      } as unknown as RaptorQuery,
      "20260624",
    );
    expect(plan).toHaveBeenCalledOnce();
    useSettingsStore.setState({ routingMode: "on-device" });
  });

  it("Transitous is asked once its own provider is granted", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ data: { itineraries: [] }, meta: {} }));
    expect(grantRemoteRouting("transitous", "contextual")).toBe(true);
    await planViaTransitous({
      from: { lat: 1, lon: 2 },
      to: { lat: 3, lon: 4 },
      departAtIso: "2026-06-26T08:00:00Z",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("a third-party place search provider is asked once it is allowed", async () => {
    fetchSpy.mockResolvedValue(jsonResponse([]));
    const adapter = new ThirdPartyGeocoderAdapter(
      { provider: "nominatim", endpoint: "https://nominatim.openstreetmap.org" },
      () => ({ m10CoarsenGridDefaultMeters: 500 }),
    );
    allowFlow("external.place-search", "nominatim");
    await adapter.forward("Gdansk", null, new AbortController().signal);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("the operator's place search is asked once it is allowed", async () => {
    fetchSpy.mockResolvedValue(jsonResponse([]));
    allowFlow("operator.place-search");
    geocoderRegistry.setActiveModeAccessor(() => "server-side");
    try {
      registerSelfHostedGeocoder({
        kind: "self-hosted",
        endpoint: "https://geo.example",
        flavor: "nominatim",
        multiTenant: false,
      });
      await geocoderRegistry.forward("museum", null, new AbortController().signal);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      unregisterSelfHostedGeocoder();
      geocoderRegistry.setActiveModeAccessor(() => "eager-bundle");
    }
  });

  it("searching online in Settings lets remote stop search reach the server", async () => {
    const searchStops = vi.spyOn(api, "searchStops").mockResolvedValue({ data: [] } as never);
    setThirdPartyEgressAccessor(canUseRemoteStopSearch);
    try {
      chooseSearchProvider("remote");
      expect(getNetworkDecision("external.stop-search").source).toBe("settings");
      await searchSuggestions("Central", "gdansk", null, new AbortController().signal, "remote");
      expect(searchStops).toHaveBeenCalled();
    } finally {
      __resetThirdPartyEgressAccessorForTests();
      useSettingsStore.getState().setSearchProvider("local");
    }
  });

  it("the explicit report action records a contextual decision and sends", async () => {
    const send = vi.spyOn(api, "sendClientReport").mockResolvedValue(undefined);
    await sendEngineFailureReportOnRequest("import");
    expect(getNetworkDecision("operator.client-report").source).toBe("contextual");
    expect(send).toHaveBeenCalledOnce();
  });
});
