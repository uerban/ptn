import type {
  GeocoderCandidate,
  GeocoderProviderId,
  PrivacyPolicy,
} from "@pt/shared";
import { db, type GeocoderDedupRecord } from "../../db/index.ts";
import {
  CryptoBoxError,
  RECORD_VERSION,
  decrypt,
  encrypt,
  type EncryptedRecord,
} from "../cryptoBox.ts";
import {
  InstallKeyError,
  getOrCreateInstallKey,
  isInstallKeyDurable,
} from "../installKey.ts";
import { getPolicy } from "../../stores/privacyStore.ts";
import { reportError } from "../errorReporter.ts";
import type { ThirdPartyProviderId } from "../../config/geocoderProviders.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * TTL for a dedup-cache axis. Returns `null` when the axis disables caching
 * entirely. Note the `plaintext-30d` axis value name is historical — the M10 v2
 * cache is unconditionally encrypted regardless of axis; only the retention
 * window changes.
 */
export function ttlForDedupAxis(
  axis: PrivacyPolicy["m10DedupCache"],
): number | null {
  switch (axis) {
    case "plaintext-30d":
      return 30 * DAY_MS;
    case "encrypted-7d":
      return 7 * DAY_MS;
    case "encrypted-1d":
      return 1 * DAY_MS;
    case "disabled":
      return null;
  }
}

let warnedMissingKey = false;

function warnKeyMissing(mode: string): void {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  console.warn(
    `[dedupCache] install key unavailable (${mode}); dedup cache disabled for this session`,
  );
}

export interface DedupCacheOptions {
  /** Test hook: override clock. */
  now?: () => number;
  /** Override the axis used to derive TTL (defaults to current policy). */
  axis?: PrivacyPolicy["m10DedupCache"];
  /**
   * Always `"encrypted"`. Present so callers can assert the boundary explicitly;
   * any other value is rejected. The dedup table never accepts plaintext.
   */
  tier?: "encrypted";
}

function assertEncryptedTier(opts: DedupCacheOptions): void {
  if (opts.tier !== undefined && opts.tier !== "encrypted") {
    throw new Error(
      `dedupCache: tier "${String(opts.tier)}" rejected — dedup entries are always encrypted`,
    );
  }
}

/**
 * Persists a geocoder response under `queryHash` as an encrypted row. When
 * `policy.m10DedupCache === "disabled"` or the install key is unavailable,
 * the call is a no-op. Metadata (`providerId`, `gridMeters`, `createdAt`)
 * stays plaintext so the TTL sweep can range-scan without decrypting.
 */
export async function writeDedupEntry(
  queryHash: string,
  candidates: GeocoderCandidate[],
  providerId: GeocoderProviderId,
  gridMeters: number,
  opts: DedupCacheOptions = {},
): Promise<void> {
  assertEncryptedTier(opts);
  const axis = opts.axis ?? getPolicy().m10DedupCache;
  if (axis === "disabled") return;

  let key: CryptoKey;
  try {
    key = await getOrCreateInstallKey();
  } catch (e) {
    if (e instanceof InstallKeyError) {
      warnKeyMissing(e.mode);
      return;
    }
    throw e;
  }
  // A key that is lost on reload would leave rows nobody can read again.
  if (!isInstallKeyDurable()) return;

  const sealed = await encrypt(candidates, key);
  const now = opts.now ? opts.now() : Date.now();
  const row: GeocoderDedupRecord = {
    queryHash,
    ct: sealed.ct,
    iv: sealed.iv,
    createdAt: now,
    providerId,
    gridMeters,
  };
  await db.geocoderDedup.put(row);
}

/**
 * Returns the cached candidates for `queryHash`, or `null` if the row is
 * missing, expired, or the policy disables caching. Expired rows are deleted
 * as a side effect so subsequent reads skip the decrypt attempt.
 */
export async function readDedupEntry(
  queryHash: string,
  opts: DedupCacheOptions = {},
): Promise<GeocoderCandidate[] | null> {
  assertEncryptedTier(opts);
  const axis = opts.axis ?? getPolicy().m10DedupCache;
  const ttl = ttlForDedupAxis(axis);
  if (ttl === null) return null;

  const row = await db.geocoderDedup.get(queryHash);
  if (!row) return null;

  const now = opts.now ? opts.now() : Date.now();
  if (now - row.createdAt > ttl) {
    await db.geocoderDedup.delete(queryHash);
    return null;
  }

  let key: CryptoKey;
  try {
    key = await getOrCreateInstallKey();
  } catch (e) {
    if (e instanceof InstallKeyError) {
      warnKeyMissing(e.mode);
      return null;
    }
    throw e;
  }

  const rec: EncryptedRecord = {
    v: RECORD_VERSION,
    iv: row.iv,
    ct: row.ct,
  };
  try {
    return (await decrypt(rec, key)) as GeocoderCandidate[];
  } catch (e) {
    if (e instanceof CryptoBoxError) {
      // Ciphertext unreadable (corrupted row or version drift). Drop it so
      // the next write refreshes; treat as a miss.
      await db.geocoderDedup.delete(queryHash);
      return null;
    }
    throw e;
  }
}

export interface SweepExpiredOptions {
  /** Test hook: override clock. */
  now?: () => number;
  /** Override the axis used to derive TTL (defaults to current policy). */
  axis?: PrivacyPolicy["m10DedupCache"];
}

// Third-party providers are the only producers of dedup entries today.
// Listed explicitly so `sweepExpired` can range-scan via the
// `[providerId+createdAt]` index per provider rather than full-scanning.
// The `satisfies Record<...>` check forces adding an entry here whenever a
// new `ThirdPartyProviderId` is introduced — otherwise new-provider rows
// would be orphaned by the TTL sweep.
type ThirdPartyGeocoderId = `third-party-${ThirdPartyProviderId}`;
const DEDUP_PROVIDER_SET = {
  "third-party-mapbox": true,
  "third-party-nominatim": true,
  "third-party-photon": true,
} as const satisfies Record<ThirdPartyGeocoderId, true>;
const DEDUP_PROVIDERS: readonly GeocoderProviderId[] = Object.keys(
  DEDUP_PROVIDER_SET,
) as ThirdPartyGeocoderId[];

/**
 * Removes dedup rows whose `createdAt` is older than the TTL implied by the
 * current `m10DedupCache` axis. When the axis is `"disabled"` the whole table
 * is cleared. Returns the number of rows removed. Metadata (`createdAt`,
 * `providerId`, `gridMeters`) is plaintext, so the sweep never decrypts.
 */
export async function sweepExpired(
  opts: SweepExpiredOptions = {},
): Promise<number> {
  const axis = opts.axis ?? getPolicy().m10DedupCache;
  const ttl = ttlForDedupAxis(axis);
  if (ttl === null) {
    const count = await db.geocoderDedup.count();
    if (count > 0) await db.geocoderDedup.clear();
    return count;
  }
  const now = opts.now ? opts.now() : Date.now();
  const cutoff = now - ttl;
  let removed = 0;
  for (const providerId of DEDUP_PROVIDERS) {
    removed += await db.geocoderDedup
      .where("[providerId+createdAt]")
      .between([providerId, -Infinity], [providerId, cutoff], true, false)
      .delete();
  }
  return removed;
}

export const DEDUP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Runs a sweep immediately, then schedules hourly sweeps. Returns a stopper.
 * Calling twice without stopping replaces the prior schedule.
 */
function runSweep(): void {
  void sweepExpired().catch((e: unknown) => {
    reportError(e instanceof Error ? e : new Error(String(e)), {
      context: { source: "dedupSweep" },
    });
  });
}

export function startDedupSweep(
  opts: { intervalMs?: number } = {},
): () => void {
  stopDedupSweep();
  runSweep();
  const interval = opts.intervalMs ?? DEDUP_SWEEP_INTERVAL_MS;
  sweepTimer = setInterval(runSweep, interval);
  return stopDedupSweep;
}

export function stopDedupSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/** Test-only: resets the one-shot missing-key warning latch. */
export function __resetDedupCacheWarningsForTests(): void {
  warnedMissingKey = false;
}
