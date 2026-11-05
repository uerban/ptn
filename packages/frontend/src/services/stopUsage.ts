import { effectivePolicy, type PrivacyPolicy } from "@pt/shared/privacy";
import { db } from "../db/index.ts";
import {
  getPolicy,
  registerLevelChangeListener,
  usePrivacyStore,
} from "../stores/privacyStore.ts";
import { isOptionalStorageEnabledNow } from "./privacyChoices.ts";

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
  const existing = await db.usageStats.get(stopId);
  await db.usageStats.put({
    stopId,
    tapCount: (existing?.tapCount ?? 0) + 1,
    lastTapped: now(),
  });
}

/**
 * Reads permitted, unexpired usage rows. Disabled personalization contributes
 * no ranking signal even if a cleanup retry is still pending.
 */
export async function loadStopUsage(
  stopIds: readonly string[],
  now: () => number = Date.now,
): Promise<Map<string, StopUsageValue>> {
  const result = new Map<string, StopUsageValue>();
  if (!isOptionalStorageEnabledNow("personalization")) return result;

  const ttl = retentionMsForStopUsage(getPolicy().stopUsageRetention);
  if (ttl === null) return result;
  const cutoff = now() - ttl;
  const staleIds: string[] = [];
  const records = await db.usageStats.bulkGet([...stopIds]);
  for (const rec of records) {
    if (!rec) continue;
    if (rec.lastTapped < cutoff) {
      staleIds.push(rec.stopId);
      continue;
    }
    result.set(rec.stopId, {
      tapCount: rec.tapCount,
      lastTapped: rec.lastTapped,
    });
  }
  if (staleIds.length > 0) await db.usageStats.bulkDelete(staleIds);
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
  if (axis === "off") {
    const count = await db.usageStats.count();
    if (count > 0) await db.usageStats.clear();
    return count;
  }
  const ttl = retentionMsForStopUsage(axis);
  if (ttl === null) return 0;
  const cutoff = (opts.now ?? Date.now)() - ttl;
  const staleIds = await db.usageStats
    .where("lastTapped")
    .below(cutoff)
    .primaryKeys();
  if (staleIds.length > 0) await db.usageStats.bulkDelete(staleIds);
  return staleIds.length;
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
