import { captureCityData, StaleCityDataError } from "../services/cityData.ts";
import { effectiveExcludedModes } from "./settingsStore.ts";
import { excludedRouteIdsForGroups } from "../services/routeGroups.ts";
import { create } from "zustand";
import type { BaseEndpoint, RankingCriteria } from "@pt/shared";
import { endpointCoord } from "@pt/shared/route-endpoint";
import {
  SearchOrchestrator,
  type SearchConfig,
} from "../services/searchOrchestrator.ts";
import type { RtComposedItinerary } from "../services/rtOverlay.ts";
import { resolveToEntryStops } from "../services/resolveEndpoint.ts";
import { makeOsmTransferLookup } from "../services/raptorIndex.ts";
import { useGtfsDataStore } from "./gtfsDataStore.ts";
import { useCityStore } from "./cityStore.ts";
import { useRtStore } from "./rtStore.ts";
import { useSettingsStore } from "./settingsStore.ts";
import { osrmClient } from "../services/osrmWasm.ts";
import { api } from "../services/api.ts";
import {
  PtEngineMisconfiguredError, StaleWasmInitError,
  PtWasmImportError, PtWasmInitError, PtWasmQueryError, PtWasmTimeError, PtWasmTransfersError,
} from "../services/raptorWasm.ts";
import { classifyEngineFailure, type EngineFailureKind } from "../services/engineFailure.ts";
import { makeRemoteStopPlanner } from "../services/routingSource.ts";

/**
 * Engine-class errors: thrown by the on-device planning boundary when the
 * `pt-wasm` router can't be built or its plan() call fails. Distinct from
 * generic search errors (network failure, "no stops in walk budget", etc.)
 * because the remediation differs — engine errors mean "the routing engine
 * itself failed to load/run". There is no second on-device engine to switch
 * to: the user's recovery is the consented remote search, and a deployment's
 * is re-checking the bundle pipeline.
 */
function isEngineError(err: unknown): boolean {
  return err instanceof PtEngineMisconfiguredError
    || err instanceof PtWasmImportError
    || err instanceof PtWasmInitError
    || err instanceof PtWasmQueryError
    || err instanceof PtWasmTimeError
    || err instanceof PtWasmTransfersError;
}

interface RoutingState {
  results: RtComposedItinerary[];
  loading: boolean;
  error: string | null;
  /**
   * Wasm-engine setup/query failures land here, separate from
   * `error` (which carries generic search problems). The UI uses
   * `engineError` to render the `data-testid="engine-error"` surface
   * (`e2e/core/wasm-engine-failure.spec.ts`).
   */
  engineError: string | null;
  /**
 * Classified kind of the last engine failure, for the failure UX.
 */
  engineFailureKind: EngineFailureKind | null;
  /** Record an engine-class failure: stores the message AND the classified kind. */
  recordEngineFailure: (err: unknown) => void;
  ranking: RankingCriteria;
  /** Whether backend-assist is enabled (user opt-in) */
  backendAssist: boolean;
  /**
   * Pending origin/destination endpoints set via non-search-page flows (e.g.
   * MapTapActionSheet). SearchPage hydrates from these and clears them on
   * consume. Values are `BaseEndpoint` so the precision seam from
   * `persistMapTap` is already applied before reaching the store.
   */
  origin: BaseEndpoint | null;
  destination: BaseEndpoint | null;

  /**
   * Search accepts `BaseEndpoint` values. The store extracts `LatLon` via
   * `endpointCoord` before constructing `SearchConfig` — the RAPTOR orchestrator
   * itself is never widened (see `searchOrchestrator.ts` seam invariant).
   * `resolveToEntryStops` is invoked once per endpoint as the privacy seam
   * (future milestones apply coarsening / redaction here).
   *
   * `opts.remote` opts this single search into the gated pt-serve remote
   * planner (the per-event "Search on the server" consent; ).
   */
  search: (origin: BaseEndpoint, destination: BaseEndpoint, departureTime: Date, opts?: { remote?: boolean }) => Promise<void>;
  setRanking: (ranking: RankingCriteria) => void;
  setBackendAssist: (enabled: boolean) => void;
  setOrigin: (endpoint: BaseEndpoint) => void;
  setDestination: (endpoint: BaseEndpoint) => void;
  clear: () => void;
}

export const useRoutingStore = create<RoutingState>()((set, get) => ({
  results: [],
  loading: false,
  error: null,
  engineError: null,
  engineFailureKind: null,
  ranking: "fastest",
  backendAssist: false,
  origin: null,
  destination: null,

  async search(origin: BaseEndpoint, destination: BaseEndpoint, departureTime: Date, opts?: { remote?: boolean }) {
    const data = captureCityData();
    const {raptorIndex, loadedCityId} = useGtfsDataStore.getState();
    if (!raptorIndex || (loadedCityId != null && loadedCityId !== useCityStore.getState().activeCity.id)) {
      set({ error: "GTFS data not loaded. Please wait for sync to complete.", loading: false,
        results: [], engineError: null, engineFailureKind: null });
      return;
    }

    set({ loading: true, error: null, engineError: null, engineFailureKind: null, results: [] });

    try {
      const allStops = await data.gtfsStops.toArray();
      const backendAssist = get().backendAssist;

      const {
        mobilityProfile,
        walkSpeedMps,
        maxWalkSecs,
        runToCatch,
        excludedRouteGroupsByCity,
      } = useSettingsStore.getState();

      const excludedModes = effectiveExcludedModes(useSettingsStore.getState(), useCityStore.getState().activeCity.defaultExcludedModes);

      // Privacy seam: resolve each endpoint to its candidate entry stops before
      // any coord reaches the orchestrator. Future milestones apply coarsening
      // / redaction at this boundary. An empty resolution means the endpoint
      // has no stops within the walk budget — short-circuit with a clear error
      // rather than letting the orchestrator return [].
      const osmLookup = makeOsmTransferLookup(raptorIndex.footTransfers);
      const resolveOpts = { maxWalkSecs, walkSpeedMps, osmLookup };
      const originStops = resolveToEntryStops(origin, allStops, resolveOpts);
      const destStops = resolveToEntryStops(destination, allStops, {
        ...resolveOpts,
        role: "destination",
      });
      if (originStops.length === 0 || destStops.length === 0) {
        set({
          error: "No transit stops within walking distance of origin or destination.",
          loading: false,
        });
        return;
      }

      const config: SearchConfig = {
        raptorIndex,
        cityId: useCityStore.getState().activeCity.id,
        allStops,
        getDelay: (tripId: string) => {
          // Stitch the trip delay together with its `receivedAt` stamp so
          // `applyRtOverlay`'s 120s freshness guard can drop stale entries.
          // Missing `receivedAt` (legacy/seeded data) is treated as fresh.
          const rtState = useRtStore.getState();
          const delay = rtState.getTripDelay(tripId);
          if (!delay) return null;
          const receivedAt = rtState.getReceivedAt(tripId);
          return { ...delay, receivedAt: receivedAt ?? undefined };
        },
        osrm: osrmClient,
        walkSpeedMps,
        maxWalkSecs,
        mobilityProfile,
        runToCatch,
        excludedModes: excludedModes.length > 0 ? excludedModes : undefined,
        excludedRouteIds: excludedRouteIdsForGroups(raptorIndex.routes, useCityStore.getState().activeCity.routeGroups ?? [],
          excludedRouteGroupsByCity[useCityStore.getState().activeCity.id] ?? []),
        feedTz: useCityStore.getState().activeCity.tz,
        backendAssist: {
          enabled: backendAssist,
          plan: api.plan.bind(api),
        },
        stopPlanner: opts?.remote
          ? makeRemoteStopPlanner(api.plan.bind(api))
          : undefined,
      };

      const orchestrator = new SearchOrchestrator(config);
      const ranking = get().ranking;

      const itineraries = await orchestrator.search({
        origin: endpointCoord(origin),
        destination: endpointCoord(destination),
        departureTime,
        ranking,
        originStopId: origin.kind === "stop" ? origin.stopId : undefined,
        destStopId: destination.kind === "stop" ? destination.stopId : undefined,
        originStopIds: origin.kind === "stopGroup" ? [...origin.stopIds] : undefined,
        destStopIds: destination.kind === "stopGroup" ? [...destination.stopIds] : undefined,
      });

      data.assertCurrent();
      set({ results: itineraries, loading: false });
    } catch (err) {
      // Staleness: a reset()/city-switch/refresh invalidated the wasm build
      // mid-search, so THIS search is obsolete and a superseding one is already
      // in flight for the new generation. Do NOT surface an engine/search error.
      // RE-THROW (rather than resolve) so the caller's search effect skips its
      // result-handling: `results` was cleared to [] at search start, and a
      // resolved promise would be misread as a successful "no routes" outcome
      // (and could fire a provider-fallback server search). The caller's
      // `.catch` recognises StaleWasmInitError and drops it silently. `loading`
      // is dropped here too so the store state can't hang on a bare reset().
      if (err instanceof StaleCityDataError) throw new StaleWasmInitError();
      if (err instanceof StaleWasmInitError) {
        set({ loading: false });
        throw err;
      }
      // Route engine-class throws to `engineError` so the UI's
      // `engine-error` testid surfaces only on actual engine failures,
      // not on generic search problems (network / no-stops / etc.).
      // Keep `error` empty in the engine-error case so the RouteResults
      // error branch renders the engine surface (precedence rule in
      // Search.tsx) instead of duplicating the message.
      if (isEngineError(err)) {
        get().recordEngineFailure(err);
      } else {
        // Use `.message` (not `String(err)`) so the class-name prefix (e.g.
        // "RoutingNotAllowedError: ") is stripped — parity with Search.tsx's
        // main effect, which surfaces the bare message.
        set({ error: err instanceof Error ? err.message : String(err), loading: false });
      }
    }
  },

  setRanking(ranking: RankingCriteria) {
    set({ ranking });
  },

  setBackendAssist(enabled: boolean) {
    set({ backendAssist: enabled });
  },

  recordEngineFailure(err: unknown) {
    set({
      engineError: err instanceof Error ? err.message : String(err),
      engineFailureKind: classifyEngineFailure(err),
      loading: false,
    });
  },

  setOrigin(endpoint: BaseEndpoint) {
    set({ origin: endpoint });
  },

  setDestination(endpoint: BaseEndpoint) {
    set({ destination: endpoint });
  },

  clear() {
    set({ results: [], error: null, engineError: null, engineFailureKind: null, loading: false });
  },
}));
