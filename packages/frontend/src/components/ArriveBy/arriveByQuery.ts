import { excludedRouteIdsForGroups } from "../../services/routeGroups.ts";
/**
 * The arrive-by request for two endpoints and a deadline, resolved the way
 * the normal planner resolves its query: the same settings, the same
 * endpoint-to-coordinate seam as `routingStore.search`, and the same entry and
 * exit stops (`SearchOrchestrator.reachableStops`).
 */
import type { BaseEndpoint, LatLon, MobilityProfile } from "@pt/shared";
import { endpointCoord } from "@pt/shared/route-endpoint";
import { minTransferSecsFor, riderWalkSpeedMps } from "@pt/shared/routing";
import { useCityStore } from "../../stores/cityStore.ts";
import { useGtfsDataStore } from "../../stores/gtfsDataStore.ts";
import { useSettingsStore } from "../../stores/settingsStore.ts";
import { osrmClient } from "../../services/osrmWasm.ts";
import { transportModeToRouteTypes, type PtRouterHandle } from "../../services/raptorWasm.ts";
import { SearchOrchestrator } from "../../services/searchOrchestrator.ts";
import {
  ARRIVE_BY_WINDOW_SECS, arriveByScope, type ArriveBySearchInput,
} from "../../services/temporalArriveByClient.ts";
import type { ArriveByStop } from "./arriveByItineraries.ts";
import { ARRIVE_BY_MARKS, markArriveBy, type ArriveByCaller } from "./arriveByMarks.ts";
import { arriveByRouteColors, arriveByStopTable } from "./arriveByTables.ts";

export interface ArriveByPrepared {
  readonly input: ArriveBySearchInput;
  readonly origin: LatLon;
  readonly destination: LatLon;
  readonly stops: ReadonlyMap<string, ArriveByStop>;
  readonly runToCatchStops: ReadonlySet<string>;
}

export type ArriveByPrepareResult =
  | { readonly kind: "ready"; readonly prepared: ArriveByPrepared }
  | { readonly kind: "no-stops" };

/**
 * The engine's mobility profiles. A vision-impaired rider has no engine
 * profile of their own: their pace reaches the engine as the walk speed below
 * and in the entry and exit walks.
 */
function engineMobility(profile: MobilityProfile): ArriveBySearchInput["mobilityProfile"] {
  return profile === "wheelchair" || profile === "bicycle" ? profile : "default";
}

/** `caller` only labels the H73 mark of each step's end. */
export async function prepareArriveBy(
  origin: BaseEndpoint,
  destination: BaseEndpoint,
  deadlineMs: number,
  router: PtRouterHandle,
  caller: ArriveByCaller = "apply",
): Promise<ArriveByPrepareResult> {
  const { raptorIndex } = useGtfsDataStore.getState();
  if (!raptorIndex) throw new Error("GTFS data not loaded");
  const start = performance.now();
  // The cards need the route colours; reading them now keeps them for Apply.
  arriveByRouteColors().catch(() => {});
  const table = await arriveByStopTable();
  const stopsRead = performance.now();
  const { mobilityProfile, walkSpeedMps, maxWalkSecs, runToCatch, excludedModes, excludedRouteGroupsByCity } = useSettingsStore.getState();
  const city = useCityStore.getState().activeCity;
  const orchestrator = new SearchOrchestrator({
    raptorIndex, cityId: city.id, allStops: [...table.rows], getDelay: () => null, osrm: osrmClient,
    walkSpeedMps, maxWalkSecs, mobilityProfile, runToCatch,
    excludedModes: excludedModes.length > 0 ? excludedModes : undefined, feedTz: city.tz,
  });
  const from = endpointCoord(origin), to = endpointCoord(destination);
  const { entryStops, exitStops } = await orchestrator.reachableStops({
    origin: from, destination: to,
    originStopId: origin.kind === "stop" ? origin.stopId : undefined,
    destStopId: destination.kind === "stop" ? destination.stopId : undefined,
    originStopIds: origin.kind === "stopGroup" ? [...origin.stopIds] : undefined,
    destStopIds: destination.kind === "stopGroup" ? [...destination.stopIds] : undefined,
  });
  const reachable = performance.now();
  if (entryStops.length === 0 || exitStops.length === 0) {
    markArriveBy(ARRIVE_BY_MARKS.prepared, { caller, start, stopsRead, reachable, stops: table.rows.length });
    return { kind: "no-stops" };
  }
  const windowStart = await router.resolveTime(Math.floor(deadlineMs / 1000) - ARRIVE_BY_WINDOW_SECS);
  const resolveTime = performance.now();
  const input: ArriveBySearchInput = {
    scope: arriveByScope(windowStart, entryStops, exitStops),
    mobilityProfile: engineMobility(mobilityProfile),
    excludedModes: excludedModes.flatMap(transportModeToRouteTypes),
    excludedRouteIds: excludedRouteIdsForGroups(raptorIndex.routes, city.routeGroups ?? [], excludedRouteGroupsByCity[city.id] ?? []),
    // The engine's transfer walks at the rider's pace and the profile's
    // minimum transfer, as the normal planner's query (`SearchOrchestrator`).
    walkSpeedMps: riderWalkSpeedMps(mobilityProfile, walkSpeedMps),
    minTransferSecs: minTransferSecsFor(mobilityProfile),
  };
  const runToCatchStops = new Set(entryStops.filter((s) => s.runToCatch).map((s) => s.stopId));
  markArriveBy(ARRIVE_BY_MARKS.prepared, {
    caller, start, stopsRead, reachable, resolveTime, lookup: performance.now(), stops: table.rows.length,
  });
  return { kind: "ready", prepared: { input, origin: from, destination: to, stops: table.lookup, runToCatchStops } };
}
