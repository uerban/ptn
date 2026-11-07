import { canUse } from "../privacy/canUse.ts";

/**
 * Transitous is THIRD-PARTY egress (the trip query reaches api.transitous.org,
 * even though the PTN backend proxies the call), so it is its own flow:
 * `external.remote-routing` for the `transitous` provider. A grant for the
 * operator's planner never covers it. Used both to resolve the standing
 * provider choice AND as the call-time backstop in planViaTransitous
 * (defense-in-depth: a stale render must not egress).
 */
export function isTransitousAllowed(): boolean {
  return canUse("external.remote-routing", "transitous");
}
