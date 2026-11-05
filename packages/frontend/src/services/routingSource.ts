// packages/frontend/src/services/routingSource.ts
import type { PrivacyPolicy, PlanRequest, RaptorItinerary, RaptorQuery } from "@pt/shared";
import { engineMobilityProfile } from "@pt/shared/routing";

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

/** Thrown when remote routing is attempted above the privacy ceiling. */
export class RoutingNotAllowedError extends Error {
  constructor() {
    super("remote routing is not allowed at this privacy level");
    this.name = "RoutingNotAllowedError";
  }
}

/**
 * The `routingAdapter` axis is the routing residency ceiling. Remote routing is allowed only at
 * `user-choice` (baseline/standard); `local-only` (hardened/strict/paranoid) forbids it.
 */
export function isRemoteRoutingAllowed(policy: PrivacyPolicy): boolean {
  return policy.routingAdapter !== "local-only";
}

/**
 * The single **privacy-ceiling** choke-point every remote routing call passes through. It
 * enforces ONLY the ceiling; the *consent* is external — the caller's explicit user action (the
 * "Search on the server" click). On-device planners do NOT pass through here (no egress).
 */
export async function gateRemoteRouting<T>(
  run: () => Promise<T>,
  policy: PrivacyPolicy,
): Promise<T> {
  if (!isRemoteRoutingAllowed(policy)) throw new RoutingNotAllowedError();
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
 * through `gateRemoteRouting` (reading the policy at call time). Results flow
 * back through the orchestrator's compose→overlay→rank tail unchanged.
 */
export function makeRemoteStopPlanner(
  plan: (req: PlanRequest) => Promise<RaptorItinerary[]>,
  getPolicy: () => PrivacyPolicy,
): StopPlanner {
  return (query, date) => {
    if (query.excludedRouteIds?.length) {
      return Promise.reject(new Error("Use on-device planning for bus and minibus filters."));
    }
    return gateRemoteRouting(() => plan(planRequestFromQuery(query, date)), getPolicy());
  };
}
