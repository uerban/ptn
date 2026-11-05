import {
  SCHEDULE_TILE_CACHE_BUDGET_BYTES,
  TILE_COORD_RE,
} from "@pt/shared/poi";
import {
  decodeScheduleTileFromText,
} from "@pt/shared/transit";
import type { DecodedScheduleTile } from "@pt/shared/schedule-tile";
import { db } from "../db/index.ts";
import { decompressBrotli } from "./brotliDecode.ts";
import { fetchScheduleTile, type FetchScheduleTileResult } from "./api.ts";
import { reportError } from "./errorReporter.ts";
import { notifyWriteGrew } from "./storagePolicy.ts";

function cacheKey(bundleHash: string, tileSize: string, tileCoords: string): string {
  return `${bundleHash}/${tileSize}/${tileCoords}`;
}

/** In-memory LRU(2) decoded-tile memo (J9).
 *
 *  Keyed by `${bundleHash}/${tileSize}/${tileCoords}`. On a hit, `getDecodedTile`
 *  returns the pre-decoded tile directly, skipping brotli decompression and
 *  JSON.parse entirely. The `bundleHash` prefix prevents cross-bundle-roll
 *  stale-tile hazards by construction — a new bundle hash is a cache miss.
 *
 *  Two slots cover the typical warm-poll pattern (a stop on the edge of two tiles)
 *  without holding more than ~2× the decoded tile size in process memory. */
const MEMO_MAX = 2;
const memoKeys: string[] = [];
const memoMap = new Map<string, DecodedScheduleTile>();

// Coalesces concurrent render-path watchdog fires (see fireStorageWatchdog below).
let watchdogInFlight = false;
let watchdogPending = false;

/** Running byte total of the scheduleTileCache table (F6). `null` = unknown —
 *  the next `ensureUnderBudget` cold-scans the table once and seeds it; after
 *  that every read-path budget check is a pure in-memory compare instead of a
 *  full-table `.each()` per departures fetch. Kept exact by the write paths in
 *  this module (put/delete/prune/evict all adjust it inside the same Dexie
 *  transaction that mutates the row) and zeroed by the storage-policy evictor's
 *  `clearAll` via `noteTileCacheCleared`. */
let totalBytesCache: number | null = null;

/** Called by scheduleTileEvictor after `db.scheduleTileCache.clear()`. */
export function noteTileCacheCleared(): void {
  totalBytesCache = 0;
}

/** Fire the cross-bucket storage watchdog after a tile write, coalesced.
 *  Leading: the first write fires immediately. Trailing: any write that lands while a
 *  watchdog call is in flight sets `watchdogPending`, so exactly ONE more run fires after
 *  the in-flight call settles — never dropping mid-flight growth, never firing N overlapping
 *  full-table evictions. Fire-and-forget: notifyWriteGrew/onQuotaNear self-catch, so the
 *  detached promise cannot reject onto the departures-render path. */
function fireStorageWatchdog(): void {
  if (watchdogInFlight) {
    watchdogPending = true;
    return;
  }
  watchdogInFlight = true;
  void notifyWriteGrew().finally(() => {
    watchdogInFlight = false;
    if (watchdogPending) {
      watchdogPending = false;
      fireStorageWatchdog(); // trailing run captures growth that arrived mid-flight
    }
  });
}

function memoGet(key: string): DecodedScheduleTile | undefined {
  return memoMap.get(key);
}

function memoSet(key: string, tile: DecodedScheduleTile): void {
  if (memoMap.has(key)) return; // already present; no eviction needed
  if (memoKeys.length >= MEMO_MAX) {
    const evict = memoKeys.shift()!;
    memoMap.delete(evict);
  }
  memoKeys.push(key);
  memoMap.set(key, tile);
}

export interface GetDecodedTileOpts {
  /** Called once, synchronously, immediately before the cache-miss network fetch
   *  is issued (regardless of the eventual HTTP status). Not called on memo hits
   *  or IDB hits. */
  onTileDownloadStart?: () => void;
  /** When true, the IDB row is stored with `loadedAt: 0` so `ensureUnderBudget`
   *  treats it as the coldest tile. A prewarm hit also skips the LRU bump. */
  prewarm?: boolean;
}

type DecodedTileResult =
  | { tile: DecodedScheduleTile; bytesDownloaded: number }
  | { fetchResult: FetchScheduleTileResult };

/** Cache hit (decompress+decode) or fetch → re-validate coord (C5) → decode-then-
 *  cache the COMPRESSED bytes. Returns the raw FetchScheduleTileResult on a non-200
 *  fetch so the read path can run its cascade.
 *
 *  Validate-before-cache (C1): the fresh 200 bytes are decoded BEFORE the `put`, so
 *  a corrupt tile never poisons the cache. A cached row that fails to decode (corrupt
 *  on disk) is self-healed — deleted, then the network is retried ONCE.
 *
 *  LRU-on-hit (C2): a successful hit bumps `loadedAt` so `ensureUnderBudget` evicts
 *  truly-cold leaves, not oldest-inserted. Skipped when `opts.prewarm` is true.
 *
 *  Memo-on-hit (J9): if the decoded tile is already in the in-memory LRU(2) memo,
 *  brotli decompression and JSON.parse are skipped entirely.
 *
 *  bytesDownloaded: non-zero only on a cache-miss network fetch (memo/IDB hits = 0).
 *
 *  onTileDownloadStart: fired immediately before a cache-miss fetch — lets callers
 *  start a hedge timer without reaching into the tile-cache internals. */
export async function getDecodedTile(
  bundleHash: string,
  tileSize: string,
  tileCoords: string,
  opts: GetDecodedTileOpts = {},
): Promise<DecodedTileResult> {
  if (!TILE_COORD_RE.test(tileCoords)) return { fetchResult: { status: 0 } };
  const key = cacheKey(bundleHash, tileSize, tileCoords);

  // J9 — in-memory memo: skip brotli+parse on warm polls.
  const memoHit = memoGet(key);
  if (memoHit) {
    if (!opts.prewarm) {
      // C2 — LRU fairness: bump the IDB row's loadedAt so ensureUnderBudget
      // (which orders by loadedAt) doesn't evict an actively-used tile just
      // because it was first fetched a long time ago. Fire-and-forget — a
      // failed bump is a non-critical LRU imprecision, not a correctness issue.
      void db.scheduleTileCache.update(key, { loadedAt: Date.now() }).catch(() => {});
    }
    return { tile: memoHit, bytesDownloaded: 0 };
  }

  const hit = await db.scheduleTileCache.get(key);
  if (hit) {
    try {
      const text = await decompressBrotli(hit.compressedBytes);
      const tile = decodeScheduleTileFromText(text);
      memoSet(key, tile);
      if (!opts.prewarm) {
        // C2 — true LRU: bump recency on a successful hit (no schema change).
        await db.scheduleTileCache.update(key, { loadedAt: Date.now() });
      }
      return { tile, bytesDownloaded: 0 };
    } catch (error) {
      // C1 — poison pill: the cached bytes are corrupt. Self-heal (delete) and
      // fall through to a single network refetch rather than serving garbage.
      reportError(error instanceof Error ? error : new Error(String(error)), {
        context: { source: "scheduleTileCache.getDecodedTile.cachedDecode", key },
      });
      // Re-read inside the delete transaction so the byte-total adjustment
      // matches the row actually removed (a concurrent re-put may have
      // replaced it since the `get` above).
      await db.transaction("rw", db.scheduleTileCache, async () => {
        const prev = await db.scheduleTileCache.get(key);
        await db.scheduleTileCache.delete(key);
        if (prev && totalBytesCache !== null) totalBytesCache -= prev.byteSize;
      });
    }
  }
  opts.onTileDownloadStart?.();
  const fetchResult = await fetchScheduleTile(bundleHash, tileSize, tileCoords);
  if (fetchResult.status !== 200 || !fetchResult.bytes) return { fetchResult };
  // C1 — validate BEFORE caching: only `put` after a successful decode.
  let tile: DecodedScheduleTile;
  try {
    const text = await decompressBrotli(fetchResult.bytes);
    tile = decodeScheduleTileFromText(text);
  } catch (error) {
    reportError(error instanceof Error ? error : new Error(String(error)), {
      context: { source: "scheduleTileCache.getDecodedTile.freshDecode", key },
    });
    // Drop (status 0) — the read-path cascade falls through to unavailable, so a
    // corrupt tile terminates the cascade rather than retrying forever.
    return { fetchResult: { status: 0 } };
  }
  memoSet(key, tile);
  const newRow = {
    key,
    compressedBytes: fetchResult.bytes,
    loadedAt: opts.prewarm ? 0 : Date.now(),
    byteSize: fetchResult.bytes.byteLength,
  };
  // put replaces any existing row under the key (e.g. two concurrent misses
  // for the same tile) — read-then-put in one transaction keeps the running
  // byte total exact instead of double-counting the replacement.
  await db.transaction("rw", db.scheduleTileCache, async () => {
    const prev = await db.scheduleTileCache.get(key);
    await db.scheduleTileCache.put(newRow);
    if (totalBytesCache !== null) {
      totalBytesCache += newRow.byteSize - (prev?.byteSize ?? 0);
    }
  });
  // Cross-bucket storage watchdog (coalesced) — mirrors poiLoader's post-write notifyWriteGrew.
  // Fire-and-forget + self-eviction-safe: the watchdog may clearAll() the row we just wrote,
  // but the decoded `tile` is already in hand (returned below), so the render is unaffected;
  // only the NEXT fetch re-downloads. See fireStorageWatchdog for the leading+trailing coalescing.
  fireStorageWatchdog();
  return { tile, bytesDownloaded: fetchResult.bytes.byteLength };
}

/** Roll-prune (R20): delete every row whose key prefix != `${bundleHash}/`.
 *  Also evicts stale keys from the in-memory memo (optional memory hygiene —
 *  not a correctness requirement; the hash prefix already prevents stale hits). */
export async function pruneToBundleHash(bundleHash: string): Promise<void> {
  const prefix = `${bundleHash}/`;
  const dead: string[] = [];
  let deadBytes = 0;
  await db.scheduleTileCache.each((row) => {
    if (!row.key.startsWith(prefix)) {
      dead.push(row.key);
      deadBytes += row.byteSize;
    }
  });
  if (dead.length > 0) {
    await db.scheduleTileCache.bulkDelete(dead);
    if (totalBytesCache !== null) totalBytesCache -= deadBytes;
  }
  // Memory hygiene: drop memo entries that are now stale.
  for (const k of dead) {
    if (memoMap.delete(k)) {
      const idx = memoKeys.indexOf(k);
      if (idx !== -1) memoKeys.splice(idx, 1);
    }
  }
}

let evictionLock: Promise<void> = Promise.resolve();
export async function ensureUnderBudget(
  budgetBytes: number = SCHEDULE_TILE_CACHE_BUDGET_BYTES,
): Promise<void> {
  const run = async (): Promise<void> => {
    // F6 — the running total answers the (overwhelmingly common) under-budget
    // case without touching IDB; the full-table `.each()` runs once per
    // session (cold start), not once per departures fetch.
    let total: number;
    if (totalBytesCache === null) {
      total = 0;
      await db.scheduleTileCache.each((r) => { total += r.byteSize; });
      totalBytesCache = total;
    } else {
      total = totalBytesCache;
    }
    if (total <= budgetBytes) return;
    const rows = await db.scheduleTileCache.orderBy("loadedAt").toArray();
    const toDelete: string[] = [];
    let evictedBytes = 0;
    for (const row of rows) {
      if (total <= budgetBytes) break;
      toDelete.push(row.key);
      total -= row.byteSize;
      evictedBytes += row.byteSize;
    }
    if (toDelete.length > 0) {
      await db.scheduleTileCache.bulkDelete(toDelete);
      // Delta-subtract (not assign) so a concurrent put that landed during
      // the eviction pass keeps its contribution to the total.
      if (totalBytesCache !== null) totalBytesCache -= evictedBytes;
    }
  };
  const next = evictionLock.then(run, run);
  evictionLock = next.catch(() => undefined);
  await next;
}
