/**
 * Which network flows the app knows, and the hard constraints that must hold
 * before any decision is consulted. Descriptions (recipient, request fields,
 * localized name and purpose) live in `dataFlowRegistry`.
 */
import {
  isNecessaryFlow,
  isNetworkDecisionFlow,
  type CapabilityFlowId,
} from "@pt/shared";
import { getBasemapProvider } from "../config/basemapProviders.ts";
import { GEOCODER_PROVIDERS } from "../config/geocoderProviders.ts";
import { ROUTING_PROVIDERS } from "../config/routingProviders.ts";

/** A hard constraint returns false when the flow cannot run at all, for
 * example because its provider is not shipped. */
type HardConstraint = (providerId?: string) => boolean;

export function isKnownFlow(flowId: string): flowId is CapabilityFlowId {
  return isNecessaryFlow(flowId) || isNetworkDecisionFlow(flowId);
}

/** Provider-scoped flows only run for a provider the build actually ships. */
const HARD_CONSTRAINTS: Readonly<Record<string, HardConstraint>> = {
  "external.detailed-basemap": (providerId) =>
    !!providerId && getBasemapProvider(providerId) !== undefined,
  "external.place-search": (providerId) =>
    !!providerId && Object.hasOwn(GEOCODER_PROVIDERS, providerId),
  "external.remote-routing": (providerId) =>
    !!providerId && Object.hasOwn(ROUTING_PROVIDERS, providerId),
};

export function hardConstraintsPass(flowId: string, providerId?: string): boolean {
  const constraint = HARD_CONSTRAINTS[flowId];
  return !constraint || constraint(providerId);
}
