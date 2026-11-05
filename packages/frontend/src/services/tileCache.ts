import Dexie from "dexie";
import { TILE_CACHE_BUDGET_BYTES } from "@pt/shared/poi";
import {
  db,
  type PoiIndexRecord,
  type PoiTileCacheRecord,
  type PoiTileGenerationRecord,
} from "../db/index.ts";
import { registerEvictor } from "./storagePolicy.ts";
import { reportError } from "./errorReporter.ts";

export interface PoiTileGeneration {
  cityId: string;
  bundleSha256: string;
  generationId: string;
}

interface GenerationState {
  bundleSha256: string;
  generationId: string;
  ready: Promise<void>;
}

export class StalePoiTileGenerationError extends Error {
  constructor(readonly generation: PoiTileGeneration) {
    super(`stale POI tile generation for ${generation.cityId}`);
    this.name = "StalePoiTileGenerationError";
  }
}

const generationStateByCity = new Map<string, GenerationState>();
const cleanupTailByCity = new Map<string, Promise<void>>();

function sameGeneration(
  state: Pick<GenerationState, "bundleSha256" | "generationId">,
  generation: PoiTileGeneration,
): boolean {
  return (
    state.bundleSha256 === generation.bundleSha256 &&
    state.generationId === generation.generationId
  );
}

function recordMatchesGeneration(
  record: PoiTileGenerationRecord | undefined,
  generation: PoiTileGeneration,
): boolean {
  return (
    record?.deliveryActive === true &&
    record.bundleSha256 === generation.bundleSha256 &&
    record.generationId === generation.generationId
  );
}

export function generationTileKey(
  tileKey: string,
  generationId: string,
): string {
  return `${tileKey}?v=${generationId}`;
}

export async function getTile(
  tileKey: string,
  generationId?: string,
): Promise<PoiTileCacheRecord | undefined> {
  if (generationId) {
    return db.poiTileCache.get(generationTileKey(tileKey, generationId));
  }

  // The search pacer owns canonical keys only. Resolve through the active
  // generation and its cleanup barrier so stale rows are unobservable.
  const cityId = tileKey.split("/", 1)[0];
  const state = generationStateByCity.get(cityId);
  if (!state) return undefined;
  await state.ready;
  if (generationStateByCity.get(cityId) !== state) return undefined;
  const persisted = await db.poiTileGenerations.get(cityId);
  if (
    !recordMatchesGeneration(persisted, {
      cityId,
      bundleSha256: state.bundleSha256,
      generationId: state.generationId,
    })
  ) {
    return undefined;
  }
  return db.poiTileCache.get(generationTileKey(tileKey, state.generationId));
}

/** Must execute inside every transaction that writes tile-derived data. Since
 * the transaction includes `poiTileGenerations`, a concurrent tab cannot
 * change the authority between this read and commit. */
export async function assertPersistedTileGeneration(
  generation: PoiTileGeneration,
): Promise<void> {
  const active = await db.poiTileGenerations.get(generation.cityId);
  if (!recordMatchesGeneration(active, generation)) {
    throw new StalePoiTileGenerationError(generation);
  }
}

export async function putTile(
  tileKey: string,
  generation: PoiTileGeneration,
  compressedBytes: ArrayBuffer,
  loadedAt: number,
): Promise<void> {
  await db.transaction(
    "rw",
    [db.poiTileGenerations, db.poiTileCache],
    async () => {
      await assertPersistedTileGeneration(generation);
      await db.poiTileCache.put({
        tileKey: generationTileKey(tileKey, generation.generationId),
        compressedBytes,
        loadedAt,
        byteSize: compressedBytes.byteLength,
        cityId: generation.cityId,
        bundleSha256: generation.bundleSha256,
        generationId: generation.generationId,
      });
    },
  );
}

async function purgeStaleGeneration(
  generation: PoiTileGeneration,
): Promise<void> {
  const { cityId, bundleSha256, generationId } = generation;
  const cityPrefix = `${cityId}/`;
  const generationSuffix = `?v=${generationId}`;
  const staleTileKeys = await db.poiTileCache
    .filter((row) => {
      const belongsToCity = row.cityId === cityId;
      if (!belongsToCity) return false;
      return (
        row.bundleSha256 !== bundleSha256 ||
        row.generationId !== generationId ||
        !row.tileKey.startsWith(cityPrefix) ||
        !row.tileKey.endsWith(generationSuffix)
      );
    })
    .primaryKeys();
  if (staleTileKeys.length > 0) {
    await db.poiTileCache.bulkDelete(staleTileKeys);
  }

  await db.poiIndex
    .where("[cityId+name]")
    .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
    .filter(
      (row) =>
        row.loadSource === "tile" &&
        (row.bundleSha256 !== bundleSha256 ||
          row.tileGenerationId !== generationId),
    )
    .delete();
}

function installGenerationState(
  generation: PoiTileGeneration,
  ready: Promise<void>,
): GenerationState {
  const state = {
    bundleSha256: generation.bundleSha256,
    generationId: generation.generationId,
    ready,
  };
  generationStateByCity.set(generation.cityId, state);
  const settled = ready.catch(() => undefined);
  cleanupTailByCity.set(generation.cityId, settled);
  void ready.catch(() => {
    if (generationStateByCity.get(generation.cityId) === state) {
      generationStateByCity.delete(generation.cityId);
    }
  });
  return state;
}

/** Atomically authorizes a network-validated generation and purges every
 * incompatible tile/cache row — UNLESS a persisted record for this city
 * already carries a STRICTLY newer `manifestGeneratedAt` (a newer cross-tab
 * release that beat this fetch to activation): in that case the incoming
 * `record` is superseded and the EXISTING persisted record wins instead,
 * with no write/purge. The freshness check runs INSIDE the same
 * transaction as the put, so it is race-free against a concurrent tab.
 * Returns the record that actually ended up active (either `record` or the
 * newer persisted one); callers must key any follow-up tiling off the
 * RETURNED record, not the input. Callers do not observe the generation
 * until the returned promise settles. */
export function activateTileGeneration(
  record: PoiTileGenerationRecord,
): Promise<PoiTileGenerationRecord> {
  if (record.activationRevision !== undefined && (!Number.isSafeInteger(record.activationRevision) || record.activationRevision < 1)) return Promise.reject(new Error("invalid POI activation revision"));
  const prior = cleanupTailByCity.get(record.cityId) ?? Promise.resolve();
  const ready: Promise<PoiTileGenerationRecord> = prior.then(() =>
    db.transaction(
      "rw",
      [db.poiTileGenerations, db.poiTileCache, db.poiIndex],
      async () => {
        const existing = await db.poiTileGenerations.get(record.cityId);
        const existingRevision = existing?.activationRevision ?? 0;
        const incomingRevision = record.activationRevision ?? 0;
        const supersededByExisting = existing !== undefined && (
          existingRevision > incomingRevision ||
          (existingRevision > 0 && existingRevision === incomingRevision && (
            existing.activationDisabled === true ||
            existing.bundleSha256 !== record.bundleSha256 || existing.generationId !== record.generationId
          )) ||
          (existingRevision === 0 && incomingRevision === 0 &&
            existing.manifestGeneratedAt !== undefined && record.manifestGeneratedAt !== undefined &&
            existing.manifestGeneratedAt > record.manifestGeneratedAt)
        );
        if (supersededByExisting) {
          return existing;
        }
        const winningGeneration: PoiTileGeneration = {
          cityId: record.cityId,
          bundleSha256: record.bundleSha256,
          generationId: record.generationId,
        };
        await db.poiTileGenerations.put(record);
        await purgeStaleGeneration(winningGeneration);
        return record;
      },
    ),
  );
  const settleReady = ready.then(() => undefined);
  installGenerationState(
    {
      cityId: record.cityId,
      bundleSha256: record.bundleSha256,
      generationId: record.generationId,
    },
    settleReady,
  );
  // Correct the optimistic install if the transaction determined a
  // different (newer, already-persisted) generation actually won.
  void ready.then((winner) => {
    if (winner.deliveryActive !== true) {
      if (generationStateByCity.get(record.cityId)?.ready === settleReady) generationStateByCity.delete(record.cityId);
      return;
    }
    if (
      winner.bundleSha256 !== record.bundleSha256 ||
      winner.generationId !== record.generationId
    ) {
      installGenerationState(
        {
          cityId: winner.cityId,
          bundleSha256: winner.bundleSha256,
          generationId: winner.generationId,
        },
        Promise.resolve(),
      );
    }
  });
  return ready;
}

/** Loader-side barrier. The manifest path must have persisted and activated the
 * exact contract before a loader can read or write it. */
export function prepareTileGeneration(
  generation: PoiTileGeneration,
): Promise<void> {
  const existing = generationStateByCity.get(generation.cityId);
  if (existing && sameGeneration(existing, generation)) {
    return existing.ready;
  }

  const prior = cleanupTailByCity.get(generation.cityId) ?? Promise.resolve();
  const ready = prior.then(() =>
    db.transaction(
      "rw",
      [db.poiTileGenerations, db.poiTileCache, db.poiIndex],
      async () => {
        await assertPersistedTileGeneration(generation);
        await purgeStaleGeneration(generation);
      },
    ),
  );
  installGenerationState(generation, ready);
  return ready;
}

/** Revoke a stale/inactive city before falling back or refetching its manifest. */
export function deactivateTileGeneration(
  cityId: string,
  expected?: PoiTileGeneration,
  activationRevision?: number,
): Promise<void> {
  if (activationRevision !== undefined && (!Number.isSafeInteger(activationRevision) || activationRevision < 1)) return Promise.reject(new Error("invalid POI activation revision"));
  const local = generationStateByCity.get(cityId);
  if (!expected || (local && sameGeneration(local, expected))) {
    generationStateByCity.delete(cityId);
  }
  const prior = cleanupTailByCity.get(cityId) ?? Promise.resolve();
  const ready = prior.then(() =>
    db.transaction(
      "rw",
      [db.poiTileGenerations, db.poiTileCache, db.poiIndex],
      async () => {
        const active = await db.poiTileGenerations.get(cityId);
        if (expected && !recordMatchesGeneration(active, expected)) return;
        if ((active?.activationRevision ?? 0) > (activationRevision ?? active?.activationRevision ?? 0)) return;
        const revision = activationRevision ?? active?.activationRevision;
        if (revision !== undefined) {
          await db.poiTileGenerations.put({
            ...(active ?? { cityId, bundleSha256: "", generationId: "", schemaVersion: 1,
              edgeKm: 0, anchor: { minLat: 0, minLon: 0, refLat: 0 },
              tileBounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, tilingPolicy: "k-anon-floor" as const,
              kAnonWaived: false, validatedAt: Date.now() }),
            deliveryActive: false, activationRevision: revision,
            activationDisabled: activationRevision !== undefined,
          });
        } else { await db.poiTileGenerations.delete(cityId); }
        const tileKeys = await db.poiTileCache
          .filter((row) => row.cityId === cityId)
          .primaryKeys();
        if (tileKeys.length > 0) await db.poiTileCache.bulkDelete(tileKeys);
        await db.poiIndex
          .where("[cityId+name]")
          .between([cityId, Dexie.minKey], [cityId, Dexie.maxKey])
          .filter((row) => row.loadSource === "tile")
          .delete();
      },
    ),
  );
  cleanupTailByCity.set(cityId, ready.catch(() => undefined));
  return ready;
}

export function isCurrentTileGeneration(
  generation: PoiTileGeneration,
): boolean {
  const state = generationStateByCity.get(generation.cityId);
  return state !== undefined && sameGeneration(state, generation);
}

/** Synchronous: has ANY generation state ever been installed for this city
 * (regardless of which one)? Used to detect whether generation hydration
 * had already settled BEFORE a caller started waiting on it — e.g. the
 * search driver's warm-cache seed needs to know whether the stream's
 * earlier initial scan ran before or after hydration, to decide whether a
 * corrective re-emit is needed (see poiSearchDriver.ts). */
export function isTileGenerationHydrated(cityId: string): boolean {
  return generationStateByCity.get(cityId) !== undefined;
}

/** Every currently-cached tile key (canonical, no `?v=` suffix) for one
 * city's generation — the bounded "already have it" set `dispatchTileLoad`
 * uses to skip cached tiles when computing a prefetch/padding plan. */
export async function cachedTileKeysForGeneration(
  generation: PoiTileGeneration,
): Promise<Set<string>> {
  const suffix = generationTileKey("", generation.generationId);
  const rows = await db.poiTileCache
    .filter(
      (row) =>
        row.cityId === generation.cityId &&
        row.bundleSha256 === generation.bundleSha256 &&
        row.generationId === generation.generationId,
    )
    .primaryKeys();
  return new Set(
    rows.map((key) => (key as string).slice(0, (key as string).length - suffix.length)),
  );
}

/** Synchronous search-boundary guard. Cleanup is asynchronous, so lazy-tile
 * searches validate provenance rather than assuming stale rows are gone. */
export function isPoiRecordInCurrentTileGeneration(
  record: Pick<
    PoiIndexRecord,
    "cityId" | "loadSource" | "bundleSha256" | "tileGenerationId"
  >,
): boolean {
  if (record.loadSource !== "tile") return true;
  const state = generationStateByCity.get(record.cityId);
  return (
    state !== undefined &&
    record.bundleSha256 === state.bundleSha256 &&
    record.tileGenerationId === state.generationId
  );
}

/** Wait until every named city's current transition is stable. Callers must
 * still filter each row because a city with no active state is intentionally
 * treated as having no authorized tile corpus. */
export async function awaitTileGenerationReadBarrier(
  cityIds: readonly string[],
): Promise<void> {
  while (true) {
    const snapshot = cityIds
      .map((cityId) => [cityId, generationStateByCity.get(cityId)] as const)
      .filter(
        (entry): entry is readonly [string, GenerationState] =>
          entry[1] !== undefined,
      );
    await Promise.all(snapshot.map(([, state]) => state.ready));
    if (
      snapshot.every(
        ([cityId, state]) => generationStateByCity.get(cityId) === state,
      )
    ) {
      return;
    }
  }
}

/** Test-only: callers must await all loader work before resetting. */
export function __resetTileGenerationStateForTests(): void {
  generationStateByCity.clear();
  cleanupTailByCity.clear();
}

async function awaitActiveGenerationCleanup(): Promise<void> {
  await awaitTileGenerationReadBarrier([...generationStateByCity.keys()]);
}

export async function cacheByteTotal(): Promise<number> {
  await awaitActiveGenerationCleanup();
  let total = 0;
  await db.poiTileCache.each((row) => {
    total += row.byteSize;
  });
  return total;
}

export async function evictOldest(count: number): Promise<string[]> {
  if (count <= 0) return [];
  const oldest = await db.poiTileCache
    .orderBy("loadedAt")
    .limit(count)
    .toArray();
  if (oldest.length === 0) return [];
  const keys = oldest.map((r) => r.tileKey);
  await db.poiTileCache.bulkDelete(keys);
  return keys;
}

// Serialize eviction so two concurrent `ensureUnderBudget` calls can't both
// observe the pre-eviction total and over-evict.
let evictionLock: Promise<void> = Promise.resolve();

export async function ensureUnderBudget(
  budgetBytes: number = TILE_CACHE_BUDGET_BYTES,
): Promise<void> {
  const run = async (): Promise<void> => {
    let total = await cacheByteTotal();
    if (total <= budgetBytes) return;

    const rows = await db.poiTileCache.orderBy("loadedAt").toArray();
    const toDelete: string[] = [];
    for (const row of rows) {
      if (total <= budgetBytes) break;
      toDelete.push(row.tileKey);
      total -= row.byteSize;
    }
    if (toDelete.length > 0) {
      await db.poiTileCache.bulkDelete(toDelete);
    }
  };

  const next = evictionLock.then(run, run);
  evictionLock = next.catch(() => undefined);
  await next;
}

async function clearAll(): Promise<void> {
  try {
    await db.poiTileCache.clear();
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)), {
      context: { source: "tileCache.clearAll" },
    });
  }
}

registerEvictor("poiTileCache", clearAll);
