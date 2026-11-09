// packages/frontend/src/services/routingSource.ts
import type { PlanRequest, RaptorItinerary, RaptorQuery } from "@pt/shared";
import { engineMobilityProfile } from "@pt/shared/routing";
import { canUse } from "../privacy/canUse.ts";

/**
 * A StopPlanner runs an already-resolved, stop-anchored RaptorQuery to a Pareto set by POSTing
 * the corresponding PlanRequest to pt-serve `/plan` (excludedModes omitted — see
 * planRequestFromQuery). The orchestrator owns resolve/compose/overlay/rank; only this
 * execution step varies.

 *
 * This is the CONSENTED REMOTE path only. It is never an automatic substitute
 * for the on-device engine: the orchestrator uses it only when the caller
 * injected one after an explicit user action, and an on-device engine failure
 * surfaces as an engine error rather than silently routing here.
 */
export type StopPlanner = (
  query: RaptorQuery,
  date: string,
) => Promise<RaptorItinerary[]>;

/** Thrown when remote routing is attempted while its flow is not allowed. */
export class RoutingNotAllowedError extends Error {
  constructor() {
    super("remote routing is not allowed");
    this.name = "RoutingNotAllowedError";
  }
}

/**
 * Remote routing by the operator (`operator.remote-routing`). Allowed only by a recorded
 * decision: a Settings choice of a remote strategy or an explicit "Search on the server".
 */
export function isRemoteRoutingAllowed(): boolean {
  return canUse("operator.remote-routing");
}

/**
 * The single choke-point every operator remote routing call passes through, resolving the flow
 * at call time. On-device planners do NOT pass through here (no egress).
 */
export async function gateRemoteRouting<T>(
  run: () => Promise<T>,
  isAllowed: () => boolean = isRemoteRoutingAllowed,
): Promise<T> {
  if (!isAllowed()) throw new RoutingNotAllowedError();
  return run();
}

/** Map a resolved RaptorQuery + service-day YYYYMMDD into a pt-serve PlanRequest.
 *  `walkSpeedMps` and `minTransferSecs` stay on the device: a walking speed
 *  such as the vision-impaired profile's 3.5 km/h start can single out the
 *  rider's profile, so the remote plan uses the engine profile's defaults.
 *  `excludedModes` is intentionally omitted (pt-serve wants route_type ints; the
 *  mapping is deferred — see PlanRequest docs). `activeServiceIds` is also dropped
 *  intentionally: pt-serve derives service activity from `date`, so the
 *  client-resolved service set is redundant on the wire. */
export function planRequestFromQuery(query: RaptorQuery, date: string): PlanRequest {
  return {
    entryStops: query.entryStops,
    exitStops: query.exitStops,
    departureSecs: query.departureSecs,
    date,
    maxRounds: query.maxRounds,
    mobilityProfile: engineMobilityProfile(query.mobilityProfile),
  };
}

/**
 * Build a remote StopPlanner from the pt-serve `/plan` transport
 * (`api.plan`). The returned planner maps the query → PlanRequest and runs it
 * through `gateRemoteRouting` (resolving the flow at call time). Results flow
 * back through the orchestrator's compose→overlay→rank tail unchanged.
 */
export function makeRemoteStopPlanner(
  plan: (req: PlanRequest) => Promise<RaptorItinerary[]>,
  isAllowed: () => boolean = isRemoteRoutingAllowed,
): StopPlanner {
  return (query, date) => {
    if (query.excludedRouteIds?.length) {
      return Promise.reject(new Error("Use on-device planning for bus and minibus filters."));
    }
    return gateRemoteRouting(() => plan(planRequestFromQuery(query, date)), isAllowed);
  };
}
