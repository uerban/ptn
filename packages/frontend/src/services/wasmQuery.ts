import type {RaptorQuery, TransportMode} from "@pt/shared";
import {engineMobilityProfile, type EngineMobilityProfile} from "@pt/shared/routing";

export interface WasmQuery {
  entryStops: { stopId: string; walkSecs: number }[];
  exitStops: { stopId: string; walkSecs: number }[];
  date: string;
  departureSecs: number;
  maxRounds?: number;
  mobilityProfile?: EngineMobilityProfile;
  excludedModes?: number[];
  excludedRouteIds?: string[];
  firstRouteId?: string;
  walkSpeedMps?: number;
  minTransferSecs?: number;
}
/**
 * Coerce a TransportMode to a SINGLE canonical base route_type. The engine
 * forward-maps the int to its Mode and excludes the whole family (spec A5 ),
 * so [11] (TROLLEYBUS) covers Vilnius 800, [1] (METRO) covers 401, etc. Every
 * base type round-trips: routeTypeToMode(base) === mode (tested). Tolerant:
 * unknown / legacy / leg modes (WALK, BIKE, a stale "CABLE_CAR") coerce to no
 * exclusion rather than throwing.
 */
export function transportModeToRouteTypes(mode: TransportMode): number[] {
  switch (mode) {
    case "TRAM": return [0];
    case "METRO": return [1];
    case "RAIL": return [2];
    case "BUS": return [3];
    case "FERRY": return [4];
    case "CABLE_TRAM": return [5];
    case "AERIAL": return [6];
    case "FUNICULAR": return [7];
    case "TROLLEYBUS": return [11];
    case "OTHER": return [1700];
    default:
      return [];
  }
}

/** Production query adaptation shared by live routing and retained replay. */
export function toWasmQuery(query: RaptorQuery, date: string): WasmQuery {
  const coerced = query.excludedModes?.flatMap(transportModeToRouteTypes);
  return {
    entryStops: query.entryStops,
    exitStops: query.exitStops,
    date,
    departureSecs: query.departureSecs,
    maxRounds: query.maxRounds,
    mobilityProfile: engineMobilityProfile(query.mobilityProfile),
    ...(query.walkSpeedMps !== undefined ? { walkSpeedMps: query.walkSpeedMps } : {}),
    ...(query.minTransferSecs !== undefined ? { minTransferSecs: query.minTransferSecs } : {}),
    // Empty array means "no exclusion" — pass undefined to match the
    // wasm-side default (panel qa MEDIUM: pinned contract).
    ...(coerced && coerced.length > 0 ? { excludedModes: coerced } : {}),
    ...(query.firstRouteId ? { firstRouteId: query.firstRouteId } : {}),
    ...(query.excludedRouteIds?.length ? { excludedRouteIds: query.excludedRouteIds } : {}),
  };
}
