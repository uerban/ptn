/**
 * First-boot installation classification and legacy network mapping.
 *
 * Runs from `main.tsx` before `appMain` (and therefore before any store
 * module) is imported. Store hydration discards what this needs: stored
 * values are re-sanitized and defaults are merged in, so presence and raw
 * overrides are only visible here. Must stay free of store imports.
 *
 * The result is written to the onboarding record in a single `setItem`.
 * Later boots read the record and never look at store presence again —
 * setup itself writes `ptn-settings`, so presence-based detection would
 * skip setup after a reload.
 */
import {
  decisionKey,
  legacyEffectiveNetworkPolicy,
  type LegacyNetworkPolicy,
  type NetworkDecision,
  type PrivacyLevel,
  type ProtectionPolicy,
} from "@pt/shared/privacy";
import { PRIVACY_DATA_MIGRATION_KEY } from "./privacyDataMigrationState.ts";
import { readStoredCityId } from "../utils/cityId.ts";
import {
  isPrivacyLevel,
  newInstallRecord,
  readOnboardingRecord,
  writeOnboardingRecord,
  type OnboardingRecord,
} from "./onboardingRecord.ts";

/** Any of these means the app ran before on this browser profile. A stored
 * city alone does not: setup runs with that city preselected. */
export const EXISTING_INSTALL_KEYS: readonly string[] = [
  "ptn-settings",
  "ptn-privacy",
  "ptn-privacy-choices",
  "ptn-favorites",
  PRIVACY_DATA_MIGRATION_KEY,
];

/** The only external basemap provider older versions could use. */
export const LEGACY_BASEMAP_PROVIDER = "carto";

/** Settings fields the legacy mapping reads. Absent fields stay undefined:
 * consent is never inferred from a setting that was never stored. */
export interface LegacySettingsSnapshot {
  readonly mapDetailMode?: string;
  readonly searchProvider?: string;
  readonly routingMode?: string;
  readonly routingProvider?: string;
}

type StorageReader = Pick<Storage, "getItem">;

function readPersistedState(
  storage: StorageReader,
  key: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!parsed || typeof parsed !== "object") return undefined;
    const state = (parsed as { state?: unknown }).state;
    return state && typeof state === "object"
      ? (state as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasKey(storage: StorageReader, key: string): boolean {
  try {
    return storage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readLegacySettings(storage: StorageReader): LegacySettingsSnapshot {
  const state = readPersistedState(storage, "ptn-settings") ?? {};
  return {
    mapDetailMode: optionalString(state.mapDetailMode),
    searchProvider: optionalString(state.searchProvider),
    routingMode: optionalString(state.routingMode),
    routingProvider: optionalString(state.routingProvider),
  };
}

/** Level and raw overrides of the stored privacy store, before hydration. */
export function readLegacyPrivacy(storage: StorageReader): {
  level: PrivacyLevel;
  overrides: unknown;
} {
  const state = readPersistedState(storage, "ptn-privacy");
  return {
    level: isPrivacyLevel(state?.level) ? state.level : "standard",
    overrides: state?.overrides,
  };
}

/**
 * Map previously effective network behavior to per-flow decisions.
 *
 * - Behavior that was on stays on (`allowed`, source `legacy`).
 * - Behavior the level or an override forbade becomes `denied` (legacy).
 * - Nearby stop lookup is local now: the server centroid flow stays unset.
 * - Everything else, including service alerts, stays unset.
 */
export function mapLegacyNetworkDecisions(
  network: LegacyNetworkPolicy,
  settings: LegacySettingsSnapshot,
): Record<string, NetworkDecision> {
  const decisions: Record<string, NetworkDecision> = {};
  const put = (
    value: NetworkDecision["value"] | undefined,
    flowId: string,
    providerId?: string,
  ) => {
    const key = decisionKey(flowId, providerId);
    if (key && value) decisions[key] = { value, source: "legacy" };
  };

  put(
    network.realTimePolling === "disabled-schedule-only" ? "denied" : "allowed",
    "operator.realtime",
  );

  const basemapAllowed = network.basemapMode === "external-detailed";
  put(
    !basemapAllowed
      ? "denied"
      : settings.mapDetailMode === "detailed"
        ? "allowed"
        : undefined,
    "external.detailed-basemap",
    LEGACY_BASEMAP_PROVIDER,
  );

  if (network.nearbyStopLookup === "local-only") {
    put("denied", "operator.nearby-stop-centroid");
  }

  const remoteRoutingAllowed = network.routingAdapter !== "local-only";
  const thirdPartyAllowed = network.m10ThirdPartyEnabled;
  const usesRemoteRouting =
    settings.routingMode === "provider-fallback" ||
    settings.routingMode === "remote-primary";

  put(
    !remoteRoutingAllowed
      ? "denied"
      : usesRemoteRouting && settings.routingProvider === "operator"
        ? "allowed"
        : undefined,
    "operator.remote-routing",
  );

  const externalRoutingProvider =
    settings.routingProvider && settings.routingProvider !== "operator"
      ? settings.routingProvider
      : undefined;
  if (!remoteRoutingAllowed || !thirdPartyAllowed) {
    // Forbidden for every provider older versions offered.
    put("denied", "external.remote-routing", externalRoutingProvider ?? "transitous");
  } else if (usesRemoteRouting && externalRoutingProvider) {
    put("allowed", "external.remote-routing", externalRoutingProvider);
  }

  put(
    !remoteRoutingAllowed || !thirdPartyAllowed
      ? "denied"
      : settings.searchProvider === "remote"
        ? "allowed"
        : undefined,
    "external.stop-search",
  );

  // Third-party geocoders could be configured but were never selected for
  // use, so a permitted axis leaves the flow unset.
  if (!thirdPartyAllowed) {
    for (const provider of ["mapbox", "nominatim", "photon"]) {
      put("denied", "external.place-search", provider);
    }
  }

  // The operator geocoder ran whenever its host configured one and the axis
  // permitted it.
  put(
    network.m9SelfHosted === "disabled" ? "denied" : "allowed",
    "operator.place-search",
  );

  return decisions;
}

/** Overrides that keep an existing installation's protections intact. */
export function carriedOverOverrides(level: PrivacyLevel): Partial<ProtectionPolicy> {
  // The decoy timer left the `strict` floor; existing strict installations
  // keep it until they remove it or lower their level.
  return level === "strict" ? { m11TileDefense: "prefetch-padding-decoy" } : {};
}

function isExistingInstall(storage: StorageReader): boolean {
  return EXISTING_INSTALL_KEYS.some((key) => hasKey(storage, key));
}

/** Build the record for an installation that has no onboarding record. */
export function buildClassification(
  storage: StorageReader,
  previousRecordCorrupt = false,
): OnboardingRecord {
  const preselectedCityId = readStoredCityId(storage);
  // A corrupt record cannot tell a finished legacy migration from a setup in
  // progress (which may already have written ptn-settings). Run setup again
  // rather than guess: it never grants anything on its own, and it never
  // lowers a stricter stored level.
  if (previousRecordCorrupt || !isExistingInstall(storage)) {
    return newInstallRecord({
      kind: "new",
      ...(preselectedCityId ? { preselectedCityId } : {}),
    });
  }

  const { level, overrides } = readLegacyPrivacy(storage);
  const network = legacyEffectiveNetworkPolicy(level, overrides);
  const flows = mapLegacyNetworkDecisions(network, readLegacySettings(storage));
  return {
    ...newInstallRecord({ kind: "existing" }),
    decisions: { preset: null, level: null, flows },
    applied: false,
    legacyOverrides: carriedOverOverrides(level),
  };
}

/**
 * Classify this installation once. Idempotent: an existing valid record is
 * returned untouched, so a removed carried-over override is never re-added.
 * Returns the record (kept for this session when storage refuses the write),
 * or null when storage cannot be read at all.
 */
export function classifyInstallation(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })(),
): OnboardingRecord | null {
  const existing = readOnboardingRecord(storage);
  if (existing.status === "ok") return existing.record;
  if (existing.status === "unavailable" || !storage) return null;
  const record = buildClassification(storage, existing.status === "corrupt");
  writeOnboardingRecord(record, storage);
  return record;
}
