/**
 * Route endpoint seam invariant.
 *
 * Consumers pass `LatLon` into `SearchOrchestrator`. The orchestrator,
 * `SearchConfig`, and `SearchQuery` are deliberately NOT widened to
 * `BaseEndpoint`. Endpoint-to-`LatLon` resolution happens UPSTREAM in
 * `routingStore.search`, which calls `resolveToEntryStops` (or
 * `endpointCoord`) and forwards the coord into this module.
 *
 * Do not import `BaseEndpoint` here. Any future privacy transform
 * (coarsening, snap, fallback-redaction) is applied at the store
 * boundary before coordinates reach this file.
 */
import type { LatLon, RaptorQuery, RankingCriteria, MobilityProfile, RoutingPreference, TransportMode, PlanRequest, RaptorItinerary } from "@pt/shared";
import {
  DEFAULT_WALK_SPEED_MPS,
  DEFAULT_MAX_WALK_SECS,
  FALLBACK_STOP_RADIUS_METERS,
  ROUTING_MAX_RESULTS,
} from "@pt/shared/constants";
import { minTransferSecsFor, riderWalkSpeedMps } from "@pt/shared/routing";
import { unixToGtfsSecs, unixToServiceDate } from "@pt/shared/time";
import type { RaptorIndex } from "./raptorIndex.ts";
import { makeOsmTransferLookup } from "./raptorIndex.ts";
import type { OsrmWasmClient } from "./osrmWasm.ts";
import { resolveActiveServices } from "./serviceDay.ts";
import { planOnDevice, resolveDepartureOnDevice, type WasmPlanContext } from "./wasmPlanner.ts";
import { composeItineraries, rankResults } from "./raptorComposer.ts";
import { useGtfsDataStore } from "../stores/gtfsDataStore.ts";
import { applyRtOverlay, type RtComposedItinerary } from "./rtOverlay.ts";
import { findReachableStops } from "./isochrone.ts";
import type { ReachableStop } from "./stopFinder.ts";
import type { StopPlanner } from "./routingSource.ts";

interface StopLocation {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface BackendAssistConfig {
  enabled: boolean;
  plan: (req: PlanRequest) => Promise<RaptorItinerary[]>;
}

export interface SearchConfig {
  raptorIndex: RaptorIndex;
  allStops: StopLocation[];
  getDelay: (tripId: string) => {
    delaySeconds: number;
    cancelled: boolean;
    receivedAt?: number;
  } | null;
  osrm: Pick<OsrmWasmClient, "isReady" | "table" | "init">;
  /** City ID for lazy OSRM init (required if OSRM should be initialized on first search) */
  cityId?: string;
  /** Feed/agency IANA tz (CityConfig.tz). When set, the query resolves the
   *  feed-tz service-day + departureSecs; when absent, device-local (local user). */
  feedTz?: string;
  walkSpeedMps?: number;
  maxWalkSecs?: number;
  fallbackRadiusMeters?: number;
  maxResults?: number;
  backendAssist?: BackendAssistConfig;
  /**
 * Strategy for the stop-anchored plan step. Default: on-device `planOnDevice` (`pt-wasm`). A
 * remote planner (pt-serve via gateRemoteRouting) is injected ONLY for the consented "search on
 * server" path — never as an automatic fallback for an on-device failure.
 */
  stopPlanner?: StopPlanner;
  /** Enable "run to catch": search the same walk-time budget at running pace */
  runToCatch?: boolean;
  /** Mobility profile for accessibility filtering */
  mobilityProfile?: MobilityProfile;
  /** Routing preference preset */
  routingPreference?: RoutingPreference;
  /** Transport modes to exclude from results */
  excludedModes?: TransportMode[];
  excludedRouteIds?: string[];
}

export interface SearchQuery {
  origin: LatLon;
  destination: LatLon;
  departureTime: Date;
  ranking: RankingCriteria;
  maxRounds?: number;
  /**
   * Stop id the origin coordinate resolves to, when the caller's endpoint
   * was a `stop`-kind endpoint. Used by the OSM-walk override on
   * `findStopsInRadius`. The seam invariant still holds: this is an opaque
   * string id, not a `BaseEndpoint`.
   */
  originStopId?: string;
  /** Stop id for the destination endpoint; same contract as `originStopId`. */
  destStopId?: string;
  /**
   * Opaque stop ids forced into the entry reachable-set at walkSecs:0 (e.g. a
   * tapped stop group's members). NOTE the plural vs `originStopId` (singular):
   * the singular tunes transfer-table accuracy; this plural OVERRIDES the walk
   * time to 0. Forwarded verbatim to `findReachableStops`.
   */
  originStopIds?: string[];
  /** Same as `originStopIds`, for the exit side. */
  destStopIds?: string[];
}

/** The endpoint fields of a query: what entry and exit stops are found from. */
export type EndpointStopsQuery = Pick<SearchQuery,
  "origin" | "destination" | "originStopId" | "destStopId" | "originStopIds" | "destStopIds">;

export interface EndpointStops {
  readonly entryStops: ReachableStop[];
  readonly exitStops: ReachableStop[];
}

/**
 * End-to-end on-device search orchestrator.
 *
 * Flow:
 * 1. Resolve active services for the query date
 * 2. Find reachable entry stops from origin (OSRM isochrone or radius fallback)
 * 3. Find reachable exit stops from destination (OSRM isochrone or radius fallback)
 * 4. Run RAPTOR (on-device `pt-wasm`) from entry stops to exit stops
 * 5. Compose results with walk times
 * 6. Apply RT delay overlay
 * 7. Rank and return top results
 */
export class SearchOrchestrator {
  private config: Required<Omit<SearchConfig, "backendAssist" | "stopPlanner" | "cityId" | "feedTz" | "runToCatch" | "mobilityProfile" | "routingPreference" | "excludedModes" | "excludedRouteIds">> & Pick<SearchConfig, "backendAssist" | "stopPlanner" | "cityId" | "feedTz" | "runToCatch" | "mobilityProfile" | "routingPreference" | "excludedModes" | "excludedRouteIds">;

  constructor(config: SearchConfig) {
    this.config = {
      walkSpeedMps: DEFAULT_WALK_SPEED_MPS,
      maxWalkSecs: DEFAULT_MAX_WALK_SECS,
      fallbackRadiusMeters: FALLBACK_STOP_RADIUS_METERS,
      maxResults: ROUTING_MAX_RESULTS,
      ...config,
    };
  }

  /**
   * A fresh WasmPlanContext per call, so `ptRouter`/`wasmEngine` are re-read at
   * each await boundary (engineer #2 race defense: a swap could land between
   * resolve and execute). `cityId` threads the search city so `ensureWasmReady`
   * builds/awaits the RIGHT city's router.
   */
  private onDeviceContext(): WasmPlanContext {
    const s = useGtfsDataStore.getState();
    return {
      ptRouter: s.ptRouter,
      cityId: this.config.cityId ?? "",
      wasmEngine: s.wasmEngine,
      ensureWasmReady: s.ensureWasmReady,
      getInitGeneration: s.getInitGeneration,
    };
  }

  /**
   * Service date and GTFS `Time` of one departure instant. The on-device engine
   * resolves it through the bundle (`PtRouter.resolveTime`). The consented remote
   * planner has no router to ask, so it reads the same definition from the feed
   * zone (`unixToGtfsSecs`), or the device zone when no feed zone is known.
   */
  async resolveDeparture(
    departureTime: Date,
    feedTz: string | undefined,
  ): Promise<{ serviceDate: string; departureSecs: number }> {
    const unix = Math.floor(departureTime.getTime() / 1000);
    if (this.config.stopPlanner) {
      const tz = feedTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const serviceDate = unixToServiceDate(unix, tz);
      return {
        serviceDate: String(serviceDate),
        departureSecs: unixToGtfsSecs(unix, serviceDate, tz),
      };
    }
    const resolved = await resolveDepartureOnDevice(unix, this.onDeviceContext());
    return { serviceDate: resolved.serviceDate, departureSecs: resolved.departureSecs };
  }

  /**
   * Lazy OSRM init: try to initialize with a timeout so the first search can
   * benefit from OSRM if it loads quickly. Falls back to radius-based stop
   * lookup if init takes too long or fails.
   */
  private async awaitOsrm(): Promise<void> {
    const { osrm } = this.config;
    if (!osrm.isReady() && this.config.cityId) {
      try {
        await Promise.race([
          osrm.init(this.config.cityId),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      } catch (err) {
        console.warn("OSRM lazy init failed, using radius fallback:", err);
      }
      if (!osrm.isReady()) {
        console.warn("OSRM init timed out, using radius-based fallback");
      }
    }
  }

  /**
   * Reachable entry/exit stops (falls back to radius if OSRM not ready).
   * When the endpoint resolves to a known stop and the pre-computed
   * pedestrian transfer table covers that stop, the haversine fallback
   * path swaps in OSM-routed walk seconds so the stop-to-stop reach
   * doesn't get a false "across the river" hit.
   */
  private async findEndpointStops(query: EndpointStopsQuery): Promise<EndpointStops> {
    const { raptorIndex, allStops, osrm, walkSpeedMps, maxWalkSecs, fallbackRadiusMeters } = this.config;
    const osmLookup = makeOsmTransferLookup(raptorIndex.footTransfers);
    const baseIsoOptions = {
      maxWalkSecs, walkSpeedMps, radiusMeters: fallbackRadiusMeters,
      runToCatch: this.config.runToCatch,
      osmLookup,
    };
    const [entryStops, exitStops] = await Promise.all([
      findReachableStops(
        query.origin, allStops,
        { ...baseIsoOptions, originStopId: query.originStopId, originStopIds: query.originStopIds, role: "origin" },
        osrm, this.config.mobilityProfile,
      ),
      // Exit walk goes "candidate stop → destination" — pass destStopId
      // and role="destination" so both the transfer-table lookup and the
      // OSRM-WASM table query read in the correct directed pair. Using
      // originStopId / origin-role here would read "destination → candidate",
      // which is only equivalent when the routing engine is symmetric
      // (Dijkstra is; OSRM with its foot profile may not be).
      findReachableStops(
        query.destination, allStops,
        { ...baseIsoOptions, destStopId: query.destStopId, destStopIds: query.destStopIds, role: "destination" },
        osrm, this.config.mobilityProfile,
      ),
    ]);
    return { entryStops, exitStops };
  }

  /**
   * The entry and exit stops `search` plans from, for another search over the
   * same endpoints (the opt-in arrive-by experiment): the same OSRM wait and
   * the same reachable-stop rules.
   */
  async reachableStops(query: EndpointStopsQuery): Promise<EndpointStops> {
    await this.awaitOsrm();
    return this.findEndpointStops(query);
  }

  async search(query: SearchQuery): Promise<RtComposedItinerary[]> {
    performance.mark("ptn:search-start");
    const { raptorIndex, getDelay, maxResults, walkSpeedMps } = this.config;

    // 0. Lazy OSRM init.
    await this.awaitOsrm();

    // 1. Resolve the departure into the engine's service-day frame. The engine
    // plans in GTFS `Time` against the bundle's own service-day origins, so a
    // DST date keeps every departure; wall-clock seconds would be an hour off.
    // It also scans every service date its horizon reaches, so there is no
    // v1-style overnight pass or early-morning empty-day short-circuit here.
    const feedTz = this.config.feedTz;
    const { serviceDate, departureSecs } = await this.resolveDeparture(query.departureTime, feedTz);
    const activeServiceIds = resolveActiveServices(raptorIndex.services, query.departureTime, feedTz);

    // 2. Find reachable entry/exit stops.
    const { entryStops, exitStops } = await this.findEndpointStops(query);

    if (entryStops.length === 0 || exitStops.length === 0) return [];

    // 3. Build RAPTOR query (departureSecs hoisted above for the empty-services guard)
    const minTransferSecs = minTransferSecsFor(this.config.mobilityProfile);
    const raptorQuery: RaptorQuery = {
      entryStops: entryStops.map((s) => ({ stopId: s.stopId, walkSecs: s.walkSecs })),
      exitStops: exitStops.map((s) => ({ stopId: s.stopId, walkSecs: s.walkSecs })),
      departureSecs,
      activeServiceIds,
      maxRounds: query.maxRounds,
      mobilityProfile: this.config.mobilityProfile,
      excludedModes: this.config.excludedModes,
      excludedRouteIds: this.config.excludedRouteIds,
      // The engine's transfer walks at the rider's pace, as the entry and exit
      // walks above, and the profile's minimum transfer.
      walkSpeedMps: riderWalkSpeedMps(this.config.mobilityProfile, walkSpeedMps),
      minTransferSecs,
    };

    // 4. Run RAPTOR. `serviceDate` is the service day the departure resolved
    // to; the engine resolves that day's services itself from it.
    // A consented remote planner replaces the on-device plan step outright; it
    // is never reached by an on-device failure (that throws a typed engine
    // error out of `planOnDevice` and is surfaced, not substituted).
    const raptorPlan: StopPlanner = this.config.stopPlanner
      ?? ((q, ymd) => planOnDevice(q, this.onDeviceContext(), ymd));
    const raptorResults: RaptorItinerary[] = await raptorPlan(raptorQuery, serviceDate);

    // Entry/exit walks for the compose below. Each carries its distance, so
    // the card's walking distance does not depend on the speed that turned
    // it into seconds. The entry side also carries the run-to-catch mark, so
    // the card can tell a run from a walk.
    const entryWalks = entryStops.map((s) => ({
      stopId: s.stopId,
      walkSecs: s.walkSecs,
      distanceMeters: s.distanceMeters,
      ...(s.runToCatch ? { runToCatch: true } : {}),
    }));
    const exitWalks = exitStops.map((s) => ({
      stopId: s.stopId,
      walkSecs: s.walkSecs,
      distanceMeters: s.distanceMeters,
    }));

    // An empty on-device result returns []. The app never *silently* auto-fires
    // a server query; the consented remote `stopPlanner` is explicit (routing-
    // source ). The `backendAssist.plan` transport is kept in `SearchConfig`
    // for a later stage that re-introduces it behind explicit user consent, but
    // it is never invoked silently here.
    if (raptorResults.length === 0) return [];

    // 5. Compose with walk times
    const composed = composeItineraries(raptorResults, entryWalks, exitWalks, departureSecs);

    // 6. Apply RT overlay
    const withRt = applyRtOverlay(composed, getDelay, minTransferSecs);

    // 7. Rank and limit
    const ranked = rankResults(withRt, query.ranking);
    performance.mark("ptn:search-end");
    performance.measure("ptn:search", "ptn:search-start", "ptn:search-end");
    return ranked.slice(0, maxResults);
  }
}
