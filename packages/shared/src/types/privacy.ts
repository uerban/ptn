// Privacy policy: 5 levels × 22 axes.
//
// Source of truth for both backend and frontend. Levels enumerate increasing
// strictness presets; axes are independent dimensions a user (or preset) can
// tighten. `effectivePolicy(level, overrides)` applies the override-ratchet:
// per axis, the result is whichever of (level floor, user override) is
// stricter — overrides may only tighten, never loosen.

export type PrivacyLevel =
  | "baseline"
  | "standard"
  | "hardened"
  | "strict"
  | "paranoid";

export const PRIVACY_LEVELS: readonly PrivacyLevel[] = [
  "baseline",
  "standard",
  "hardened",
  "strict",
  "paranoid",
] as const;

export interface PrivacyPolicy {
  recentsEncryption:
    | "plaintext"
    | "encrypted"
    | "encrypted-30d"
    | "encrypted-7d"
    | "ram-only"
    | "off";
  savesEncryption:
    | "opt-in"
    | "default"
    | "always"
    | "always-no-export"
    | "always-no-share";
  mapTapPersistedPrecision:
    | "raw"
    | "snap-centroid"
    | "snap-rounded-50m"
    | "snap-rounded-100m"
    | "snap-rounded-100m-no-reverse";
  mapTapSnapRadiusMeters: number;
  m9SelfHosted: "respect-multitenant" | "always-coarsen" | "disabled";
  m10ThirdPartyEnabled: boolean;
  m10CoarsenGridFloorMeters: number;
  m10CoarsenGridDefaultMeters: number;
  m10Jitter: boolean;
  m11TileDefense:
    | "none"
    | "prefetch"
    | "prefetch-padding"
    | "prefetch-padding-decoy";
  m10DedupCache:
    | "plaintext-30d"
    | "encrypted-7d"
    | "encrypted-1d"
    | "disabled";
  providerFallback: "silent" | "visible" | "fail-loud";
  urlShare: "coords-raw" | "coords-rounded" | "coords-stripped" | "disabled";
  errorReporting: boolean;
  m11TileCacheBudgetBytes: number;
  routingAdapter: "user-choice" | "local-only";
  /** POI search-corpus residency ceiling. "local-only" forbids the remote
   *  "server-side" POI mode (corpus stays on-device); "user-choice" permits it.
   *  Mirrors routingAdapter. Governs local-vs-remote ONLY — the eager-vs-lazy
   *  (download-all vs deferred-chunks) choice is privacy-neutral and not gated
   *  here. */
  poiResidency: "user-choice" | "local-only";
  realTimePolling:
    | "backend-adaptive"
    | "backend-foreground-only"
    | "disabled-schedule-only";
  /** Whether the map may load a detailed style/tiles from an external
   * provider. The local transit schematic remains available in both modes. */
  basemapMode: "external-detailed" | "local-only";
  /** Whether the nearby-stop optimization may send the nearest public stop
   * centroid to the operator. It never permits measured GPS coordinates. */
  nearbyStopLookup: "centroid-server" | "local-only";
  /** Precision allowed for automatic persistence of the last viewed map area.
   * This is separate from user-confirmed mapTapPersistedPrecision. */
  viewportPersistence:
    | "raw"
    | "snap-centroid"
    | "rounded-50m"
    | "rounded-100m"
    | "off";
  /** Retention ceiling for optional local stop-use personalization. */
  stopUsageRetention: "30d" | "7d" | "off";
}

export const LEVEL_FLOORS: Record<PrivacyLevel, PrivacyPolicy> = {
  baseline: {
    recentsEncryption: "plaintext",
    savesEncryption: "opt-in",
    mapTapPersistedPrecision: "raw",
    mapTapSnapRadiusMeters: 0,
    m9SelfHosted: "respect-multitenant",
    m10ThirdPartyEnabled: true,
    m10CoarsenGridFloorMeters: 0,
    m10CoarsenGridDefaultMeters: 0,
    m10Jitter: false,
    m11TileDefense: "none",
    m10DedupCache: "plaintext-30d",
    providerFallback: "silent",
    urlShare: "coords-raw",
    errorReporting: true,
    m11TileCacheBudgetBytes: 100_000_000,
    routingAdapter: "user-choice",
    poiResidency: "user-choice",
    realTimePolling: "backend-adaptive",
    basemapMode: "external-detailed",
    nearbyStopLookup: "centroid-server",
    viewportPersistence: "raw",
    stopUsageRetention: "30d",
  },
  standard: {
    recentsEncryption: "encrypted",
    savesEncryption: "default",
    mapTapPersistedPrecision: "snap-centroid",
    mapTapSnapRadiusMeters: 25,
    m9SelfHosted: "respect-multitenant",
    m10ThirdPartyEnabled: true,
    m10CoarsenGridFloorMeters: 25,
    m10CoarsenGridDefaultMeters: 50,
    m10Jitter: true,
    m11TileDefense: "prefetch",
    m10DedupCache: "encrypted-7d",
    providerFallback: "visible",
    urlShare: "coords-rounded",
    errorReporting: true,
    m11TileCacheBudgetBytes: 50_000_000,
    routingAdapter: "user-choice",
    poiResidency: "user-choice",
    realTimePolling: "backend-adaptive",
    basemapMode: "external-detailed",
    nearbyStopLookup: "centroid-server",
    viewportPersistence: "snap-centroid",
    stopUsageRetention: "30d",
  },
  hardened: {
    recentsEncryption: "encrypted-30d",
    savesEncryption: "always",
    mapTapPersistedPrecision: "snap-rounded-50m",
    mapTapSnapRadiusMeters: 50,
    m9SelfHosted: "always-coarsen",
    m10ThirdPartyEnabled: false,
    m10CoarsenGridFloorMeters: 50,
    m10CoarsenGridDefaultMeters: 100,
    m10Jitter: true,
    m11TileDefense: "prefetch-padding",
    m10DedupCache: "encrypted-1d",
    providerFallback: "visible",
    urlShare: "coords-stripped",
    errorReporting: false,
    m11TileCacheBudgetBytes: 25_000_000,
    routingAdapter: "local-only",
    poiResidency: "local-only",
    realTimePolling: "backend-foreground-only",
    basemapMode: "local-only",
    nearbyStopLookup: "local-only",
    viewportPersistence: "rounded-50m",
    stopUsageRetention: "7d",
  },
  strict: {
    recentsEncryption: "encrypted-7d",
    savesEncryption: "always-no-export",
    mapTapPersistedPrecision: "snap-rounded-100m",
    mapTapSnapRadiusMeters: 100,
    m9SelfHosted: "disabled",
    m10ThirdPartyEnabled: false,
    m10CoarsenGridFloorMeters: 100,
    m10CoarsenGridDefaultMeters: 200,
    m10Jitter: true,
    m11TileDefense: "prefetch-padding-decoy",
    m10DedupCache: "disabled",
    providerFallback: "fail-loud",
    urlShare: "coords-stripped",
    errorReporting: false,
    m11TileCacheBudgetBytes: 10_000_000,
    routingAdapter: "local-only",
    poiResidency: "local-only",
    realTimePolling: "disabled-schedule-only",
    basemapMode: "local-only",
    nearbyStopLookup: "local-only",
    viewportPersistence: "rounded-100m",
    stopUsageRetention: "off",
  },
  paranoid: {
    recentsEncryption: "ram-only",
    savesEncryption: "always-no-share",
    mapTapPersistedPrecision: "snap-rounded-100m-no-reverse",
    mapTapSnapRadiusMeters: 100,
    m9SelfHosted: "disabled",
    m10ThirdPartyEnabled: false,
    m10CoarsenGridFloorMeters: 100,
    m10CoarsenGridDefaultMeters: 200,
    m10Jitter: true,
    m11TileDefense: "prefetch-padding-decoy",
    m10DedupCache: "disabled",
    providerFallback: "fail-loud",
    urlShare: "disabled",
    errorReporting: false,
    m11TileCacheBudgetBytes: 5_000_000,
    routingAdapter: "local-only",
    poiResidency: "local-only",
    realTimePolling: "disabled-schedule-only",
    basemapMode: "local-only",
    nearbyStopLookup: "local-only",
    viewportPersistence: "off",
    stopUsageRetention: "off",
  },
};

// For each axis, describe how to compare two values and pick the stricter one.
// Enum axes use an explicit ascending-strictness list. Numeric axes declare
// whether higher or lower numbers are stricter.
type AxisOrder<K extends keyof PrivacyPolicy> =
  | { readonly kind: "enum"; readonly values: readonly PrivacyPolicy[K][] }
  | { readonly kind: "numeric"; readonly stricterIs: "higher" | "lower" };

export const AXIS_STRICTNESS_ORDER: {
  readonly [K in keyof PrivacyPolicy]: AxisOrder<K>;
} = {
  recentsEncryption: {
    kind: "enum",
    values: [
      "plaintext",
      "encrypted",
      "encrypted-30d",
      "encrypted-7d",
      "ram-only",
      "off",
    ],
  },
  savesEncryption: {
    kind: "enum",
    values: [
      "opt-in",
      "default",
      "always",
      "always-no-export",
      "always-no-share",
    ],
  },
  mapTapPersistedPrecision: {
    kind: "enum",
    values: [
      "raw",
      "snap-centroid",
      "snap-rounded-50m",
      "snap-rounded-100m",
      "snap-rounded-100m-no-reverse",
    ],
  },
  mapTapSnapRadiusMeters: { kind: "numeric", stricterIs: "higher" },
  m9SelfHosted: {
    kind: "enum",
    values: ["respect-multitenant", "always-coarsen", "disabled"],
  },
  m10ThirdPartyEnabled: { kind: "enum", values: [true, false] },
  m10CoarsenGridFloorMeters: { kind: "numeric", stricterIs: "higher" },
  m10CoarsenGridDefaultMeters: { kind: "numeric", stricterIs: "higher" },
  m10Jitter: { kind: "enum", values: [false, true] },
  m11TileDefense: {
    kind: "enum",
    values: [
      "none",
      "prefetch",
      "prefetch-padding",
      "prefetch-padding-decoy",
    ],
  },
  m10DedupCache: {
    kind: "enum",
    values: ["plaintext-30d", "encrypted-7d", "encrypted-1d", "disabled"],
  },
  providerFallback: {
    kind: "enum",
    values: ["silent", "visible", "fail-loud"],
  },
  urlShare: {
    kind: "enum",
    values: ["coords-raw", "coords-rounded", "coords-stripped", "disabled"],
  },
  errorReporting: { kind: "enum", values: [true, false] },
  m11TileCacheBudgetBytes: { kind: "numeric", stricterIs: "lower" },
  routingAdapter: { kind: "enum", values: ["user-choice", "local-only"] },
  poiResidency: { kind: "enum", values: ["user-choice", "local-only"] },
  realTimePolling: {
    kind: "enum",
    values: [
      "backend-adaptive",
      "backend-foreground-only",
      "disabled-schedule-only",
    ],
  },
  basemapMode: {
    kind: "enum",
    values: ["external-detailed", "local-only"],
  },
  nearbyStopLookup: {
    kind: "enum",
    values: ["centroid-server", "local-only"],
  },
  viewportPersistence: {
    kind: "enum",
    values: [
      "raw",
      "snap-centroid",
      "rounded-50m",
      "rounded-100m",
      "off",
    ],
  },
  stopUsageRetention: {
    kind: "enum",
    values: ["30d", "7d", "off"],
  },
};

export function stricterValue<K extends keyof PrivacyPolicy>(
  axis: K,
  a: PrivacyPolicy[K],
  b: PrivacyPolicy[K],
): PrivacyPolicy[K] {
  const order = AXIS_STRICTNESS_ORDER[axis];
  if (order.kind === "numeric") {
    const an = a as unknown as number;
    const bn = b as unknown as number;
    if (order.stricterIs === "higher") return an >= bn ? a : b;
    return an <= bn ? a : b;
  }
  const values = order.values as readonly PrivacyPolicy[K][];
  const ia = values.indexOf(a);
  const ib = values.indexOf(b);
  // Unknown override values are conservatively rejected — fall back to b.
  if (ia < 0) return b;
  if (ib < 0) return a;
  return ia >= ib ? a : b;
}

export function effectivePolicy(
  level: PrivacyLevel,
  overrides: Partial<PrivacyPolicy> = {},
): PrivacyPolicy {
  const floor = LEVEL_FLOORS[level];
  const result = { ...floor };
  for (const key of Object.keys(floor) as (keyof PrivacyPolicy)[]) {
    const override = overrides[key];
    if (override === undefined) continue;
    // Type-narrowing helper: per-axis stricterValue.
    (result as Record<string, unknown>)[key] = stricterValue(
      key,
      override as PrivacyPolicy[typeof key],
      floor[key],
    );
  }
  return result;
}
