// Optional network decisions, keyed by data flow.
//
// Each optional network flow (and, for provider-backed flows, each provider)
// carries its own decision. A decision never spans flows: granting live
// departures says nothing about detailed maps, even though both were once
// governed by shared policy axes. The protection level (privacy.ts) and these
// decisions are independent — changing one never rewrites the other.

import type { PrivacyLevel } from "./privacy.js";
import type { PrivacyDataFlowId } from "./privacyNotice.js";

export const NETWORK_DECISIONS_SCHEMA_VERSION = 1;

/** Flows the app may always use: without them there is no transit data. */
export const NECESSARY_FLOW_IDS = ["operator.transit-data"] as const;
export type NecessaryFlowId = (typeof NECESSARY_FLOW_IDS)[number];

/** Optional flows that each need their own decision before they run. */
export const NETWORK_DECISION_FLOW_IDS = [
  "operator.realtime",
  "operator.service-alerts",
  "operator.nearby-stop-centroid",
  "external.detailed-basemap",
  "operator.place-search",
  "external.place-search",
  "external.stop-search",
  "operator.remote-routing",
  "external.remote-routing",
  "operator.client-report",
] as const;
export type NetworkDecisionFlowId = (typeof NETWORK_DECISION_FLOW_IDS)[number];

/** Every capability the resolver answers for. */
export type CapabilityFlowId =
  | NecessaryFlowId
  | NetworkDecisionFlowId
  | PrivacyDataFlowId;

/** Flows whose decision is recorded per provider: a grant for one provider
 * never covers another. */
export const PROVIDER_SCOPED_FLOW_IDS = [
  "external.detailed-basemap",
  "external.place-search",
  "external.remote-routing",
] as const satisfies readonly NetworkDecisionFlowId[];
export type ProviderScopedFlowId = (typeof PROVIDER_SCOPED_FLOW_IDS)[number];

export type NetworkDecisionValue = "unset" | "allowed" | "denied";
export type StoredNetworkDecisionValue = Exclude<NetworkDecisionValue, "unset">;
export type NetworkDecisionSource = "setup" | "contextual" | "settings" | "legacy";

export const NETWORK_DECISION_SOURCES: readonly NetworkDecisionSource[] = [
  "setup",
  "contextual",
  "settings",
  "legacy",
];

/** A recorded decision. `unset` is never stored: absence means unset. */
export interface NetworkDecision {
  readonly value: StoredNetworkDecisionValue;
  readonly source: NetworkDecisionSource;
  /** Epoch milliseconds of the decision, when known. */
  readonly decidedAt?: number;
}

/** Decisions keyed by `decisionKey(flowId, providerId?)`. */
export type NetworkDecisionMap = Readonly<Record<string, NetworkDecision>>;

export interface ResolvedNetworkDecision {
  readonly value: NetworkDecisionValue;
  readonly source?: NetworkDecisionSource;
}

export function isNecessaryFlow(flowId: string): flowId is NecessaryFlowId {
  return (NECESSARY_FLOW_IDS as readonly string[]).includes(flowId);
}

export function isNetworkDecisionFlow(
  flowId: string,
): flowId is NetworkDecisionFlowId {
  return (NETWORK_DECISION_FLOW_IDS as readonly string[]).includes(flowId);
}

export function isProviderScopedFlow(
  flowId: string,
): flowId is ProviderScopedFlowId {
  return (PROVIDER_SCOPED_FLOW_IDS as readonly string[]).includes(flowId);
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Storage key of a decision. Provider-scoped flows require a provider; other
 * flows ignore it. Returns `undefined` for keys that can never hold a
 * decision (unknown flow, missing or malformed provider).
 */
export function decisionKey(
  flowId: string,
  providerId?: string,
): string | undefined {
  if (!isNetworkDecisionFlow(flowId)) return undefined;
  if (!isProviderScopedFlow(flowId)) return flowId;
  if (!providerId || !PROVIDER_ID_PATTERN.test(providerId)) return undefined;
  return `${flowId}@${providerId}`;
}

function parseDecisionKey(key: string): string | undefined {
  const at = key.indexOf("@");
  if (at < 0) return decisionKey(key) === key ? key : undefined;
  const normalized = decisionKey(key.slice(0, at), key.slice(at + 1));
  return normalized === key ? key : undefined;
}

function sanitizeDecision(raw: unknown): NetworkDecision | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { value, source, decidedAt } = raw as Record<string, unknown>;
  if (value !== "allowed" && value !== "denied") return undefined;
  if (!NETWORK_DECISION_SOURCES.includes(source as NetworkDecisionSource)) {
    return undefined;
  }
  const decision: NetworkDecision = {
    value,
    source: source as NetworkDecisionSource,
  };
  return typeof decidedAt === "number" && Number.isFinite(decidedAt)
    ? { ...decision, decidedAt }
    : decision;
}

/** Keep only well-formed decisions for known flows. Untrusted input. */
export function sanitizeNetworkDecisions(raw: unknown): NetworkDecisionMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, NetworkDecision> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!parseDecisionKey(key)) continue;
    const decision = sanitizeDecision(value);
    if (decision) result[key] = decision;
  }
  return result;
}

/** Decision for a flow (and provider). Unknown flows are `unset`. */
export function resolveNetworkDecision(
  decisions: NetworkDecisionMap,
  flowId: string,
  providerId?: string,
): ResolvedNetworkDecision {
  const key = decisionKey(flowId, providerId);
  const decision = key ? decisions[key] : undefined;
  return decision
    ? { value: decision.value, source: decision.source }
    : { value: "unset" };
}

// --- Setup presets ---------------------------------------------------------

export type OnboardingPresetId = "recommended" | "strict" | "customize";

export interface OnboardingPreset {
  readonly id: OnboardingPresetId;
  /** Protection level the preset applies. */
  readonly level: PrivacyLevel;
  /** Decisions the preset writes. Flows not listed stay `unset`. */
  readonly decisions: Readonly<
    Partial<Record<NetworkDecisionFlowId, StoredNetworkDecisionValue>>
  >;
}

/**
 * Setup presets. Each one sets both the protection level and a set of
 * decisions. Resolution never consults a preset: once applied, only the
 * level and the decisions remain.
 */
export const ONBOARDING_PRESETS: Readonly<
  Record<OnboardingPresetId, Readonly<OnboardingPreset>>
> = Object.freeze({
  recommended: Object.freeze({
    id: "recommended",
    level: "standard",
    decisions: Object.freeze({
      "operator.realtime": "allowed",
      "operator.service-alerts": "allowed",
    }),
  }),
  strict: Object.freeze({
    id: "strict",
    level: "strict",
    decisions: Object.freeze({}),
  }),
  customize: Object.freeze({
    id: "customize",
    level: "standard",
    decisions: Object.freeze({}),
  }),
} satisfies Record<OnboardingPresetId, OnboardingPreset>);

/** Answer to the guided network question offered by Customize. */
export type GuidedNetworkChoice = "live-information" | "ask-first";

/** Flows covered by the guided network question. */
export const GUIDED_NETWORK_FLOW_IDS = [
  "operator.realtime",
  "operator.service-alerts",
] as const satisfies readonly NetworkDecisionFlowId[];

/**
 * Decisions a preset writes. Customize writes only the answer to its guided
 * question: live information grants the guided flows, asking first leaves
 * them `unset` so they are offered when relevant.
 */
export function presetDecisions(
  presetId: OnboardingPresetId,
  guidedChoice?: GuidedNetworkChoice,
): Partial<Record<NetworkDecisionFlowId, StoredNetworkDecisionValue>> {
  if (presetId !== "customize") return { ...ONBOARDING_PRESETS[presetId].decisions };
  if (guidedChoice !== "live-information") return {};
  const result: Partial<Record<NetworkDecisionFlowId, StoredNetworkDecisionValue>> = {};
  for (const flowId of GUIDED_NETWORK_FLOW_IDS) result[flowId] = "allowed";
  return result;
}

/** Which preset the current level and decisions match, or `custom`. */
export function matchOnboardingPreset(
  level: PrivacyLevel,
  decisions: NetworkDecisionMap,
): "recommended" | "strict" | "custom" {
  for (const id of ["recommended", "strict"] as const) {
    const preset = ONBOARDING_PRESETS[id];
    if (preset.level !== level) continue;
    const keys = Object.keys(decisions);
    const expected = Object.entries(preset.decisions);
    if (keys.length !== expected.length) continue;
    if (expected.every(([flowId, value]) => decisions[flowId]?.value === value)) {
      return id;
    }
  }
  return "custom";
}
