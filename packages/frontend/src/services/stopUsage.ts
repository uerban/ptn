import { effectivePolicy, type PrivacyPolicy } from "@pt/shared/privacy";
import {
  clearPersonal,
  deletePersonal,
  listPersonal,
  newPersonalId,
  putPersonal,
  type PersonalEntry,
} from "./personalStorage.ts";
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

const TABLE = "personalUsage";

/**
 * One stop's use history in one city, sealed whole (stop and city IDs
 * included) when persisted. Legacy rows have no city: they keep obeying
 * retention but never rank stops, since their city is unknown.
 */
interface StopUsagePayload extends StopUsageValue {
  stopId: string;
  cityId?: string;
}

function inCity(value: StopUsagePayload, cityId: string): boolean {
  return !!value.cityId && canonicalCityId(value.cityId) === cityId;
}

function isUsagePayload(value: unknown): value is StopUsagePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<StopUsagePayload>;
  return (
    typeof v.stopId === "string" &&
    typeof v.tapCount === "number" &&
    typeof v.lastTapped === "number"
  );
}

async function listUsage(): Promise<PersonalEntry<StopUsagePayload>[]> {
  return (await listPersonal<unknown>(TABLE)).filter(
    (e): e is PersonalEntry<StopUsagePayload> => isUsagePayload(e.value),
  );
}

export function retentionMsForStopUsage(
  axis: PrivacyPolicy["stopUsageRetention"],
): number | null {
  if (axis === "30d") return 30 * DAY_MS;
  if (axis === "7d") return 7 * DAY_MS;
  return null;
}

/** Records a stop tap only after both the standing choice and policy allow it. */
// Taps are counted one at a time: each reads the sealed rows, then rewrites
// one, so concurrent taps of a stop must not both start from the same count.
let recordQueue: Promise<void> = Promise.resolve();

export function recordStopUsage(
  stopId: string,
  now: () => number = Date.now,
): Promise<void> {
  if (!isOptionalStorageEnabledNow("personalization")) return Promise.resolve();
  // Capture ownership and time at the tap, not when the queue reaches it.
  const cityId = canonicalCityId(useCityStore.getState().activeCity.id);
  const lastTapped = now();
  const run = recordQueue.then(() => recordOne(stopId, cityId, lastTapped));
  recordQueue = run.catch(() => {});
  return run;
}

async function recordOne(stopId: string, cityId: string, lastTapped: number): Promise<void> {
  if (!isOptionalStorageEnabledNow("personalization")) return;
  const existing = (await listUsage()).find(
    (e) => e.value.stopId === stopId && inCity(e.value, cityId),
  );
  // Recheck consent after waiting for storage.
  if (!isOptionalStorageEnabledNow("personalization")) return;
  await putPersonal<StopUsagePayload>(TABLE, existing?.id ?? newPersonalId(), {
    stopId,
    cityId,
    tapCount: (existing?.value.tapCount ?? 0) + 1,
    lastTapped,
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
  const wanted = new Set(stopIds);
  const city = canonicalCityId(cityId);
  const staleIds: string[] = [];
  for (const { id, value } of await listUsage()) {
    if (!wanted.has(value.stopId) || !inCity(value, city)) continue;
    if (value.lastTapped < cutoff) {
      staleIds.push(id);
      continue;
    }
    result.set(value.stopId, {
      tapCount: value.tapCount,
      lastTapped: value.lastTapped,
    });
  }
  if (staleIds.length > 0) await deletePersonal(TABLE, staleIds);
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
    const count = (await listUsage()).length;
    await clearPersonal(TABLE);
    return count;
  }
  const ttl = retentionMsForStopUsage(axis);
  if (ttl === null) return 0;
  const cutoff = (opts.now ?? Date.now)() - ttl;
  // Times are sealed: decrypt, then filter.
  const staleIds = (await listUsage())
    .filter((e) => e.value.lastTapped < cutoff)
    .map((e) => e.id);
  if (staleIds.length > 0) await deletePersonal(TABLE, staleIds);
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

/** Resolves once every sweep queued by a retention change has finished. */
export async function whenStopUsageSweepsSettled(): Promise<void> {
  let sweep: Promise<unknown>;
  do {
    sweep = policySweep;
    await sweep.catch(() => {});
  } while (sweep !== policySweep);
}
