import type {
  LatLon,
  PrivacyPolicy,
  RoutingRequirement,
  RoutingRequirements,
  TripResult,
} from "@pt/shared";
import { fetchJson } from "./api.ts";
import { isTransitousAllowed } from "./transitousAvailability.ts";
import { RoutingNotAllowedError } from "./routingSource.ts";
import { getRoutingProvider } from "../config/routingProviders.ts";
import { assertDeclaredRequestFields } from "../privacy/dataFlowRegistry.ts";

export interface TransitousPlanArgs {
  from: LatLon;
  to: LatLon;
  /** ISO 8601 departure time. */
  departAtIso: string;
  /** Functional constraints only. Transitous v1 currently declares none. */
  requirements?: RoutingRequirements;
}

/** Bounded so a hung upstream surfaces as a `failure` outcome, not a spinner. */
const TRANSITOUS_TIMEOUT_MS = 12_000;
const provider = getRoutingProvider("transitous");

const REQUIREMENT_KEYS: Readonly<
  Record<keyof RoutingRequirements, RoutingRequirement>
> = Object.freeze({
  stepFree: "step-free",
  maxWalkSeconds: "max-walk-seconds",
  walkingSpeedMps: "walking-speed",
  allowedModes: "allowed-modes",
});

export class UnsupportedRoutingRequirementError extends Error {
  constructor(requirement: RoutingRequirement) {
    super(`${provider.id} does not support routing requirement ${requirement}`);
    this.name = "UnsupportedRoutingRequirementError";
  }
}

function assertSupportedRequirements(
  requirements: RoutingRequirements | undefined,
): void {
  if (!requirements) return;
  for (const key of Object.keys(requirements) as (keyof RoutingRequirements)[]) {
    if (requirements[key] === undefined) continue;
    const requirement = REQUIREMENT_KEYS[key];
    if (!provider.supportedRoutingRequirements.includes(requirement)) {
      throw new UnsupportedRoutingRequirementError(requirement);
    }
  }
}

export function buildTransitousQuery(
  args: TransitousPlanArgs,
): Readonly<Record<string, string>> {
  assertSupportedRequirements(args.requirements);
  assertDeclaredRequestFields(provider.flowId, {
    from: args.from,
    to: args.to,
    departAt: args.departAtIso,
  });
  return {
    adapter: provider.adapter,
    fromLat: String(args.from.lat),
    fromLon: String(args.from.lon),
    toLat: String(args.to.lat),
    toLon: String(args.to.lon),
    departAt: args.departAtIso,
  };
}

/**
 * Calls the backend's FLAT `GET /api/plan?adapter=motis` (the MotisAdapter →
 * api.transitous.org proxy) and returns the coordinate `TripResult`. Re-asserts
 * the privacy double-gate at call time (defense-in-depth: render-time gating can
 * go stale). The flat path is intentional — `/api/plan` is single-flat, NOT the
 * city-scoped `/api/<city>/plan` that `api.plan` (pt-serve) uses.
 */
export async function planViaTransitous(
  args: TransitousPlanArgs,
  getPolicy: () => PrivacyPolicy,
): Promise<TripResult> {
  if (!isTransitousAllowed(getPolicy())) throw new RoutingNotAllowedError();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSITOUS_TIMEOUT_MS);
  try {
    const body = await fetchJson<{ data: TripResult; meta: unknown }>(
      "/api/plan",
      buildTransitousQuery(args),
      controller.signal,
    );
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}
