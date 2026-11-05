import type { PrivacyPolicy } from "@pt/shared";
import { isRemoteRoutingAllowed } from "./routingSource.ts";

/**
 * Transitous is THIRD-PARTY egress (the trip query reaches api.transitous.org,
 * even though the PTN backend proxies the call), so it passes TWO orthogonal
 * privacy axes — strictly stricter than first-party pt-serve, which passes only
 * the residency axis:
 *   1. routingAdapter !== "local-only"  — the remote residency ceiling (== isRemoteRoutingAllowed)
 *   2. m10ThirdPartyEnabled              — the third-party egress gate (the geocoder's gate)
 * Used both to resolve the standing provider choice AND as the call-time backstop in
 * planViaTransitous (defense-in-depth: a stale render must not egress).
 */
export function isTransitousAllowed(policy: PrivacyPolicy): boolean {
  return isRemoteRoutingAllowed(policy) && policy.m10ThirdPartyEnabled;
}
