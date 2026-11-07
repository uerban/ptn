/**
 * Capability registry: which network flows the app can use, built on the
 * data-flow registry. Descriptions (recipient, request fields, localized
 * name and purpose) live in `dataFlowRegistry`; this module only adds what
 * the resolver needs — whether a flow is necessary, whether its decision is
 * per provider, and the hard constraints that must hold before any decision
 * is consulted.
 */
import {
  isNecessaryFlow,
  isProviderScopedFlow,
  NECESSARY_FLOW_IDS,
  NETWORK_DECISION_FLOW_IDS,
  type CapabilityFlowId,
  type PrivacyDataFlowDescriptor,
} from "@pt/shared";
import { DATA_FLOW_REGISTRY } from "./dataFlowRegistry.ts";
import { getBasemapProvider } from "../config/basemapProviders.ts";
import { GEOCODER_PROVIDERS } from "../config/geocoderProviders.ts";
import { ROUTING_PROVIDERS } from "../config/routingProviders.ts";

export interface CapabilityDescriptor {
  readonly flowId: CapabilityFlowId;
  /** Necessary flows run without a decision (they are disclosed instead). */
  readonly necessary: boolean;
  /** Decisions for this flow are recorded per provider. */
  readonly providerScoped: boolean;
  /** Shared description, when the flow is registered for disclosure. */
  readonly dataFlow?: Readonly<PrivacyDataFlowDescriptor>;
}

/** A hard constraint returns false when the flow cannot run at all, for
 * example because its provider is not configured or the city lacks it. */
export type HardConstraint = (providerId?: string) => boolean;

export const CAPABILITY_FLOW_IDS: readonly CapabilityFlowId[] = Object.freeze([
  ...NECESSARY_FLOW_IDS,
  ...NETWORK_DECISION_FLOW_IDS,
]);

const DATA_FLOWS = new Map(
  DATA_FLOW_REGISTRY.map((flow) => [flow.id as string, flow] as const),
);

const CAPABILITIES = new Map<string, Readonly<CapabilityDescriptor>>(
  CAPABILITY_FLOW_IDS.map((flowId) => {
    const dataFlow = DATA_FLOWS.get(flowId);
    const descriptor: CapabilityDescriptor = {
      flowId,
      necessary: isNecessaryFlow(flowId),
      providerScoped: isProviderScopedFlow(flowId),
      ...(dataFlow ? { dataFlow } : {}),
    };
    return [flowId, Object.freeze(descriptor)] as const;
  }),
);

export function getCapability(
  flowId: string,
): Readonly<CapabilityDescriptor> | undefined {
  return CAPABILITIES.get(flowId);
}

export function isKnownCapability(flowId: string): flowId is CapabilityFlowId {
  return CAPABILITIES.has(flowId);
}

/** Provider-scoped flows only run for a provider the build actually ships. */
const BUILT_IN_CONSTRAINTS: Readonly<Record<string, HardConstraint>> = {
  "external.detailed-basemap": (providerId) =>
    !!providerId && getBasemapProvider(providerId) !== undefined,
  "external.place-search": (providerId) =>
    !!providerId && Object.hasOwn(GEOCODER_PROVIDERS, providerId),
  "external.remote-routing": (providerId) =>
    !!providerId && Object.hasOwn(ROUTING_PROVIDERS, providerId),
};

const registeredConstraints = new Map<string, Set<HardConstraint>>();

/**
 * Add a hard constraint for a flow (city availability, platform support,
 * ...). Every registered constraint must pass. Returns an unregister
 * function.
 */
export function registerHardConstraint(
  flowId: CapabilityFlowId,
  constraint: HardConstraint,
): () => void {
  let set = registeredConstraints.get(flowId);
  if (!set) {
    set = new Set();
    registeredConstraints.set(flowId, set);
  }
  set.add(constraint);
  return () => {
    registeredConstraints.get(flowId)?.delete(constraint);
  };
}

/** Test-only: drop every registered (non built-in) constraint. */
export function __clearHardConstraintsForTests(): void {
  registeredConstraints.clear();
}

export function hardConstraintsPass(flowId: string, providerId?: string): boolean {
  const builtIn = BUILT_IN_CONSTRAINTS[flowId];
  if (builtIn && !safeCheck(builtIn, providerId)) return false;
  for (const constraint of registeredConstraints.get(flowId) ?? []) {
    if (!safeCheck(constraint, providerId)) return false;
  }
  return true;
}

function safeCheck(constraint: HardConstraint, providerId?: string): boolean {
  try {
    return constraint(providerId) === true;
  } catch {
    // A failing check fails closed.
    return false;
  }
}
