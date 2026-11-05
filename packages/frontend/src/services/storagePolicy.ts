import { reportError, reportTelemetry } from "./errorReporter.ts";

export type EvictableBucket =
  | "scheduleTileCache"
  | "poiTileCache"
  | "geocoderDedup"
  | "walkGraphArtifacts"
  | "addressSearch"
  | "poiIndex";
export type ProtectedBucket = "recentLocations" | "savedLocations";
export type StorageBucket = EvictableBucket | ProtectedBucket;

const EVICTION_ORDER: readonly EvictableBucket[] = [
  "scheduleTileCache",
  "poiTileCache",
  "geocoderDedup",
  "walkGraphArtifacts",
  "addressSearch",
  "poiIndex",
];

const PROTECTED_BUCKETS: ReadonlySet<ProtectedBucket> = new Set([
  "recentLocations",
  "savedLocations",
]);

const QUOTA_NEAR_THRESHOLD = 0.85;

export const PERSIST_FLAG_KEY = "ptn:storagePolicy:persistRequested";

type Evictor = () => Promise<void>;

const evictors = new Map<EvictableBucket, Evictor>();

export function evictionPriority(): readonly EvictableBucket[] {
  return EVICTION_ORDER;
}

export function hasEvictor(b: EvictableBucket): boolean {
  return evictors.has(b);
}

export function registerEvictor(bucket: EvictableBucket, evict: Evictor): void {
  if (PROTECTED_BUCKETS.has(bucket as unknown as ProtectedBucket)) {
    throw new Error(
      `storagePolicy: "${bucket}" is a protected bucket and must not register an evictor`,
    );
  }
  if (!EVICTION_ORDER.includes(bucket)) {
    throw new Error(`storagePolicy: unknown evictable bucket "${bucket}"`);
  }
  evictors.set(bucket, evict);
}

async function getQuotaRatio(): Promise<number | null> {
  const storage = globalThis.navigator?.storage;
  if (!storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await storage.estimate();
    if (quota <= 0) return null;
    return usage / quota;
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)), {
      context: { source: "storagePolicy.getQuotaRatio" },
    });
    return null;
  }
}

export async function onQuotaNear(): Promise<EvictableBucket[]> {
  const initial = await getQuotaRatio();
  if (initial === null || initial < QUOTA_NEAR_THRESHOLD) return [];
  const evicted: EvictableBucket[] = [];
  for (const bucket of EVICTION_ORDER) {
    const evictor = evictors.get(bucket);
    if (!evictor) continue;
    try {
      await evictor();
      evicted.push(bucket);
    } catch (error) {
      reportError(error instanceof Error ? error : new Error(String(error)), {
        context: { source: "storagePolicy.evict", bucket },
      });
    }
    const ratio = await getQuotaRatio();
    if (ratio === null || ratio < QUOTA_NEAR_THRESHOLD) break;
  }
  if (evicted.length > 0) {
    reportTelemetry("storage.evicted", { buckets: evicted, ratioBefore: initial });
  }
  return evicted;
}

export async function startWatchdog(): Promise<void> {
  await onQuotaNear();
}

export async function notifyWriteGrew(): Promise<void> {
  await onQuotaNear();
}

export async function requestPersist(): Promise<boolean> {
  if (globalThis.localStorage?.getItem(PERSIST_FLAG_KEY) !== null) return false;
  const persist = globalThis.navigator?.storage?.persist;
  if (typeof persist !== "function") {
    // Persist API unavailable — record the attempt so save paths don't keep
    // probing on every write.
    globalThis.localStorage?.setItem(PERSIST_FLAG_KEY, String(Date.now()));
    return false;
  }
  let granted = false;
  try {
    granted = await globalThis.navigator.storage.persist();
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)), {
      context: { source: "storagePolicy.requestPersist" },
    });
  }
  globalThis.localStorage?.setItem(PERSIST_FLAG_KEY, String(Date.now()));
  return granted;
}

export function __resetStoragePolicyForTests(): void {
  evictors.clear();
}
