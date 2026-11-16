import type { RaptorTransitLeg } from "@pt/shared";
import { transferRuleKey, transferTripScopedKey, transferRouteScopedKey, type RaptorIndex } from "./raptorIndex.ts";

/** Mirrors same-stop trip → route → stop precedence; cross-stop footpaths use only unscoped rules. Null forbids
 * transfer; zero waives the floor but never permits boarding before arrival. */
export function effectiveTransferFloor(index: RaptorIndex, from: RaptorTransitLeg, to: RaptorTransitLeg, fallback: number): number | null {
  const sameStop = from.toStopId === to.fromStopId;
  const scoped = sameStop ? index.transferRulesTripScoped?.get(transferTripScopedKey(from.toStopId, to.fromStopId, from.tripId, to.tripId))
    ?? index.transferRulesRouteScoped?.get(transferRouteScopedKey(from.toStopId, to.fromStopId, from.routeId, to.routeId))
    : undefined;
  const rule = scoped ?? index.transferRules?.get(transferRuleKey(from.toStopId, to.fromStopId));
  if (rule?.type === 3) return null;
  if (rule?.type === 1 || (sameStop && rule?.type === 4)) return 0;
  if (rule?.type === 2 && typeof rule.minSecs === "number" && Number.isFinite(rule.minSecs) && rule.minSecs >= 0) return rule.minSecs;
  return fallback;
}
