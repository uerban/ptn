import { effectivePolicy, type PrivacyPolicy } from "@pt/shared/privacy";
import { db } from "../db/index.ts";
import {
  getPolicy,
  registerLevelChangeListener,
  usePrivacyStore,
} from "../stores/privacyStore.ts";
import { isOptionalStorageEnabledNow } from "./privacyChoices.ts";

import { canonicalCityId } from "../utils/cityId.ts";
import { useCityStore } from "../stores/cityStore.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const STOP_USAGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface StopUsageValue {
  tapCount: number;
  lastTapped: number;
}

export function retentionMsForStopUsage(
  axis: PrivacyPolicy["stopUsageRetention"],
): number | null {
  if (axis === "30d") return 30 * DAY_MS;
  if (axis === "7d") return 7 * DAY_MS;
  return null;
}

/** Records a stop tap only after both the standing choice and policy allow it. */
export async function recordStopUsage(
  stopId: string,
  now: () => number = Date.now,
): Promise<void> {
  if (!isOptionalStorageEnabledNow("personalization")) return;
  const cityId = canonicalCityId(useCityStore.getState().activeCity.id);
  const lastTapped = now();
  const id = JSON.stringify([cityId, stopId]);
  await db.transaction("rw", db.cityUsageStats, async () => {
    const existing = await db.cityUsageStats.get(id);
    // Recheck consent after waiting for another transaction.
    if (!isOptionalStorageEnabledNow("personalization")) return;
    await db.cityUsageStats.put({id, cityId, stopId,
      tapCount: (existing?.tapCount ?? 0) + 1, lastTapped});
  });
}

/**
 * Reads permitted, unexpired usage rows. Disabled personalization contributes
 * no ranking signal even if a cleanup retry is still pending.
 */
export async function loadStopUsage(
  stopIds: readonly string[],
  now: () => number = Date.now,
  cityId: string = useCityStore.getState().activeCity.id,
): Promise<Map<string, StopUsageValue>> {
  const result = new Map<string, StopUsageValue>();
  if (!isOptionalStorageEnabledNow("personalization")) return result;

  const ttl = retentionMsForStopUsage(getPolicy().stopUsageRetention);
  if (ttl === null) return result;
  const cutoff = now() - ttl;
  const staleIds: string[] = [];
  cityId = canonicalCityId(cityId);
  const records = await db.cityUsageStats.bulkGet(stopIds.map(stopId => JSON.stringify([cityId, stopId])));
  for (const rec of records) {
    if (!rec) continue;
    if (rec.lastTapped < cutoff) {
      staleIds.push(rec.id);
      continue;
    }
    result.set(rec.stopId, {
      tapCount: rec.tapCount,
      lastTapped: rec.lastTapped,
    });
  }
  if (staleIds.length > 0) await db.cityUsageStats.bulkDelete(staleIds);
  return result;
}

export interface SweepStopUsageOptions {
  now?: () => number;
  axis?: PrivacyPolicy["stopUsageRetention"];
}

/** Enforces the current retention ceiling across every personalization row. */
export async function sweepStopUsage(
  opts: SweepStopUsageOptions = {},
): Promise<number> {
  const axis = opts.axis ?? getPolicy().stopUsageRetention;
  // Old bare-stop IDs have no reliable city provenance. Keep them separate
  // from ranking, but enforce the same consent/retention policy on both stores.
  let removed = 0;
  for (const table of [db.usageStats, db.cityUsageStats]) {
    if (axis === "off") {
      removed += await table.count();
      await table.clear();
      continue;
    }
    const ttl = retentionMsForStopUsage(axis);
    if (ttl === null) continue;
    const cutoff = (opts.now ?? Date.now)() - ttl;
    const ids = await table.where("lastTapped").below(cutoff).primaryKeys();
    if (ids.length > 0) await table.bulkDelete(ids);
    removed += ids.length;
  }
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startStopUsageSweep(
  opts: { intervalMs?: number } = {},
): () => void {
  stopStopUsageSweep();
  void sweepStopUsage().catch(() => {});
  sweepTimer = setInterval(() => {
    void sweepStopUsage().catch(() => {});
  }, opts.intervalMs ?? STOP_USAGE_SWEEP_INTERVAL_MS);
  return stopStopUsageSweep;
}

export function stopStopUsageSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

let policySweep: Promise<number> = Promise.resolve(0);

// Queue every effective-axis change, including direct Settings overrides.
// setLevel invokes its registered listener after the store update, so awaiting
// the shared promise preserves its side-effect completion contract.
usePrivacyStore.subscribe((state, previous) => {
  const before = effectivePolicy(previous.level, previous.overrides)
    .stopUsageRetention;
  const after = effectivePolicy(state.level, state.overrides)
    .stopUsageRetention;
  if (before === after) return;
  policySweep = policySweep
    .catch(() => 0)
    .then(() => sweepStopUsage({ axis: after }));
  void policySweep.catch(() => {});
});

registerLevelChangeListener(async () => {
  await policySweep;
});
