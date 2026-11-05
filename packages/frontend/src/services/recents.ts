import type { BaseEndpoint, RecentRef } from "@pt/shared";
import { LEVEL_FLOORS, type PrivacyLevel, type PrivacyPolicy } from "@pt/shared/privacy";
import { db, type RecentLocationRecord } from "../db/index.ts";
import {
  clearRamRecordsForTable,
  decrypt,
  deleteRamRecord,
  encrypt,
  listRamRecords,
  readRecord,
  writeRecord,
  type EncryptedRecord,
} from "./cryptoBox.ts";
import { getOrCreateInstallKey } from "./installKey.ts";
import { getPolicy, registerLevelChangeListener } from "../stores/privacyStore.ts";
import { isOptionalStorageEnabledNow } from "./privacyChoices.ts";

export const MAX_RECENTS = 50;

export const RECENTS_LIST_LIMIT = 25;

export const RECENTS_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Decrypted snapshot cache (hot-path: listRecents runs per keystroke). Invalidated
// by every mutation (recordRecent / clearRecents / migrateRecentsForLevelChange).
let _recentsCache: RecentRef[] | null = null;
function invalidateRecentsCache(): void {
  _recentsCache = null;
}

export type RecentsTier = "plaintext" | "encrypted" | "ram-only";

/** Collapse the 5-way `recentsEncryption` axis onto the 3 storage tiers. */
export function tierForRecentsAxis(
  axis: PrivacyPolicy["recentsEncryption"],
): RecentsTier {
  if (axis === "plaintext") return "plaintext";
  if (axis === "ram-only") return "ram-only";
  // "off" never reaches storage (recordRecent/listRecents short-circuit first);
  // collapse defensively to ram-only so a stray call cannot persist a plaintext row.
  if (axis === "off") return "ram-only";
  return "encrypted";
}

/**
 * Maximum age before a persisted recent is swept, or `null` if the axis
 * imposes no TTL. Hardened → 30d, Strict → 7d; other axes retain indefinitely
 * (the LRU cap still bounds growth).
 */
export function ttlForRecentsAxis(
  axis: PrivacyPolicy["recentsEncryption"],
): number | null {
  if (axis === "encrypted-30d") return 30 * DAY_MS;
  if (axis === "encrypted-7d") return 7 * DAY_MS;
  return null;
}

export interface RecordRecentOptions {
  usedAsOrigin: boolean;
  /** Test hook: override clock. */
  now?: () => number;
  /** Test hook: override the resolved tier (bypasses policy lookup). */
  tier?: RecentsTier;
}

/**
 * Deterministic id for a `BaseEndpoint`. Identical endpoints collapse onto the
 * same row so re-visiting a location updates `usedAt` in place rather than
 * producing duplicate recents.
 */
export function endpointFingerprint(ep: BaseEndpoint): string {
  switch (ep.kind) {
    case "stop":
      return `stop:${ep.stopId}`;
    case "geocoded":
      return `geo:${ep.lat.toFixed(5)}:${ep.lon.toFixed(5)}:${ep.label}`;
    case "mappoint":
      return `map:${ep.lat.toFixed(5)}:${ep.lon.toFixed(5)}`;
    case "stopGroup":
      // Member-set identity: same siblings collapse onto one recents row
      // regardless of which sibling/centroid produced the tap.
      return `group:${[...ep.stopIds].sort().join(",")}`;
    default: {
      // Exhaustiveness gate: a new BaseEndpoint kind with no case above fails
      // tsc here (not assignable to `never`), independent of the `: string`
      // return annotation. Matches the repo's `_exhaustive` idiom.
      const _exhaustive: never = ep;
      return _exhaustive;
    }
  }
}

export async function recordRecent(
  endpoint: BaseEndpoint,
  opts: RecordRecentOptions,
): Promise<void> {
  if (!isOptionalStorageEnabledNow("recents")) return;
  const axis = getPolicy().recentsEncryption;
  if (opts.tier === undefined && axis === "off") return; // Off: never record
  const tier = opts.tier ?? tierForRecentsAxis(axis);
  const now = opts.now ? opts.now() : Date.now();
  const id = endpointFingerprint(endpoint);

  if (tier === "ram-only") {
    const record: RecentLocationRecord = {
      id,
      endpoint,
      usedAt: now,
      usedAsOrigin: opts.usedAsOrigin,
    };
    await writeRecord(db.recentLocations, record, { tier: "ram-only" });
    evictRamIfNeeded();
    invalidateRecentsCache();
    return;
  }

  let storedEndpoint: BaseEndpoint | EncryptedRecord;
  if (tier === "encrypted") {
    const key = await getOrCreateInstallKey();
    storedEndpoint = await encrypt(endpoint, key);
  } else {
    storedEndpoint = endpoint;
  }

  await db.recentLocations.put({
    id,
    endpoint: storedEndpoint,
    usedAt: now,
    usedAsOrigin: opts.usedAsOrigin,
  });
  await evictIfNeeded();
  invalidateRecentsCache();
}

async function evictIfNeeded(): Promise<void> {
  const count = await db.recentLocations.count();
  if (count <= MAX_RECENTS) return;
  const excess = count - MAX_RECENTS;
  const oldestIds = await db.recentLocations
    .orderBy("usedAt")
    .limit(excess)
    .primaryKeys();
  if (oldestIds.length > 0) {
    await db.recentLocations.bulkDelete(oldestIds);
  }
}

function evictRamIfNeeded(): void {
  const entries = listRamRecords<RecentLocationRecord>(db.recentLocations);
  if (entries.length <= MAX_RECENTS) return;
  entries.sort((a, b) => a.usedAt - b.usedAt);
  const excess = entries.length - MAX_RECENTS;
  for (let i = 0; i < excess; i++) {
    deleteRamRecord(db.recentLocations, entries[i]!.id);
  }
}

/**
 * Reads a ram-only recent by fingerprint. Returns `null` if no record exists
 * (e.g. after page reload — the ram store is module-scoped and not persisted).
 */
export async function readRamRecent(
  id: string,
): Promise<RecentLocationRecord | null> {
  return readRecord<RecentLocationRecord>(db.recentLocations, id, {
    tier: "ram-only",
  });
}

/**
 * Returns all recents as `RecentRef[]`, newest-first, decrypting per tier.
 * Capped at `RECENTS_LIST_LIMIT` entries. Results are cached in module scope
 * (invalidated on every write) so this is safe to call per debounced keystroke.
 * Returns `[]` immediately when the `recentsEncryption` axis is `"off"`.
 */
export async function listRecents(): Promise<RecentRef[]> {
  if (!isOptionalStorageEnabledNow("recents")) return [];
  const axis = getPolicy().recentsEncryption;
  if (axis === "off") return [];
  if (_recentsCache) return _recentsCache;
  const tier = tierForRecentsAxis(axis);
  const out: RecentRef[] = [];
  if (tier === "ram-only") {
    for (const rec of listRamRecords<RecentLocationRecord>(db.recentLocations)) {
      out.push({ kind: "recent", base: rec.endpoint as BaseEndpoint, usedAt: rec.usedAt, usedAsOrigin: rec.usedAsOrigin });
    }
  } else {
    const rows = await db.recentLocations.toArray();
    let key: CryptoKey | null = null;
    for (const row of rows) {
      let base: BaseEndpoint;
      if (isEncryptedShape(row.endpoint)) {
        if (key === null) key = await getOrCreateInstallKey().catch(() => null);
        if (!key) continue;
        try {
          base = (await decrypt(row.endpoint, key)) as BaseEndpoint;
        } catch {
          continue;
        }
      } else {
        base = row.endpoint as BaseEndpoint;
      }
      out.push({ kind: "recent", base, usedAt: row.usedAt, usedAsOrigin: row.usedAsOrigin });
    }
  }
  out.sort((a, b) => b.usedAt - a.usedAt);
  _recentsCache = out.slice(0, RECENTS_LIST_LIMIT);
  return _recentsCache;
}

/**
 * Cheap count for the Off-switch confirm. Persisted count can exceed what
 * `listRecents` surfaces if some rows fail to decrypt; acceptable for a
 * purge-all confirm. Returns 0 when the axis is `"off"`.
 */
export async function countRecents(): Promise<number> {
  const axis = getPolicy().recentsEncryption;
  if (axis === "off") return 0;
  if (tierForRecentsAxis(axis) === "ram-only") {
    return listRamRecords<RecentLocationRecord>(db.recentLocations).length;
  }
  return db.recentLocations.count();
}

export interface SweepRecentsOptions {
  now?: () => number;
  /** Override the axis used to derive the TTL (defaults to current policy). */
  axis?: PrivacyPolicy["recentsEncryption"];
}

/**
 * Removes persisted recents older than the TTL implied by the current
 * `recentsEncryption` axis. Returns the number of rows deleted. RAM-only
 * records disappear on reload so the sweep does not touch them.
 */
export async function sweepRecents(
  opts: SweepRecentsOptions = {},
): Promise<number> {
  const axis = opts.axis ?? getPolicy().recentsEncryption;
  const ttl = ttlForRecentsAxis(axis);
  if (ttl === null) return 0;
  const now = opts.now ? opts.now() : Date.now();
  const cutoff = now - ttl;
  const staleIds = await db.recentLocations
    .where("usedAt")
    .below(cutoff)
    .primaryKeys();
  if (staleIds.length === 0) return 0;
  await db.recentLocations.bulkDelete(staleIds);
  invalidateRecentsCache();
  return staleIds.length;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Runs a sweep immediately, then schedules hourly sweeps. Returns a stopper.
 * Calling twice without stopping replaces the prior schedule.
 */
export function startRecentsSweep(opts: {
  intervalMs?: number;
} = {}): () => void {
  stopRecentsSweep();
  void sweepRecents().catch(() => {});
  const interval = opts.intervalMs ?? RECENTS_SWEEP_INTERVAL_MS;
  sweepTimer = setInterval(() => {
    void sweepRecents().catch(() => {});
  }, interval);
  return stopRecentsSweep;
}

export function stopRecentsSweep(): void {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

/**
 * Drops every recent the user has — both the persisted Dexie rows and the
 * RAM-only Paranoid-tier entries. Bound to the "purge recents" Settings
 * button. The caller is responsible for any user confirmation.
 */
export async function clearRecents(): Promise<void> {
  await db.recentLocations.clear();
  clearRamRecordsForTable(db.recentLocations);
  invalidateRecentsCache();
}

function isEncryptedShape(x: unknown): x is EncryptedRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return "iv" in r && "ct" in r && "v" in r;
}

/**
 * Re-encodes every recent so it lives at the storage tier implied by `next`.
 * Triggered by the privacyStore level-change listener (registered below) — but
 * exported so callers and tests can drive it directly.
 *
 * Behaviour by transition:
 * - persisted → persisted (plaintext ↔ encrypted): rewrites every row at the
 *   new tier in place.
 * - persisted → ram-only: copies rows into the RAM store, then drops the
 *   persisted copy.
 * - ram-only → persisted: persists what's currently in RAM, then clears RAM.
 *
 * Existing records whose endpoint shape doesn't match the assumed previous
 * tier (e.g. the test seed bypassing `recordRecent`) are passed through as
 * plaintext rather than failing.
 */
export async function migrateRecentsForLevelChange(
  prev: PrivacyLevel,
  next: PrivacyLevel,
): Promise<void> {
  if (!isOptionalStorageEnabledNow("recents")) {
    await clearRecents();
    return;
  }
  const prevTier = tierForRecentsAxis(LEVEL_FLOORS[prev].recentsEncryption);
  const nextTier = tierForRecentsAxis(LEVEL_FLOORS[next].recentsEncryption);
  if (prevTier === nextTier) return;

  const collected: RecentLocationRecord[] = [];

  if (prevTier === "ram-only") {
    for (const rec of listRamRecords<RecentLocationRecord>(
      db.recentLocations,
    )) {
      collected.push(rec);
    }
    clearRamRecordsForTable(db.recentLocations);
  } else {
    const rows = await db.recentLocations.toArray();
    if (rows.length === 0) return;
    let key: CryptoKey | null = null;
    for (const row of rows) {
      let endpoint: BaseEndpoint;
      if (isEncryptedShape(row.endpoint)) {
        if (key === null) key = await getOrCreateInstallKey();
        try {
          endpoint = (await decrypt(row.endpoint, key)) as BaseEndpoint;
        } catch {
          continue;
        }
      } else {
        endpoint = row.endpoint;
      }
      collected.push({
        id: row.id,
        endpoint,
        usedAt: row.usedAt,
        usedAsOrigin: row.usedAsOrigin,
      });
    }
    await db.recentLocations.clear();
  }

  // collected empty: RAM store was already empty, nothing changed — cache stays valid.
  if (collected.length === 0) return;

  if (nextTier === "ram-only") {
    for (const rec of collected) {
      await writeRecord(db.recentLocations, rec, { tier: "ram-only" });
    }
    invalidateRecentsCache();
    return;
  }

  if (nextTier === "encrypted") {
    const key = await getOrCreateInstallKey();
    for (const rec of collected) {
      const ct = await encrypt(rec.endpoint, key);
      await db.recentLocations.put({
        id: rec.id,
        endpoint: ct,
        usedAt: rec.usedAt,
        usedAsOrigin: rec.usedAsOrigin,
      });
    }
    invalidateRecentsCache();
    return;
  }

  // plaintext
  for (const rec of collected) {
    await db.recentLocations.put(rec);
  }
  invalidateRecentsCache();
}

registerLevelChangeListener(migrateRecentsForLevelChange);

/** Test-only: drops the RAM-only recents for this table. */
export function __clearRamRecentsForTests(): void {
  clearRamRecordsForTable(db.recentLocations);
}

/** Test-only: resets the module-scope listRecents cache. */
export function __resetRecentsCacheForTests(): void {
  _recentsCache = null;
}

/** Test-only: peek at the RAM-only recents as a fingerprint→record map. */
export function __getRamRecentsForTests(): ReadonlyMap<
  string,
  RecentLocationRecord
> {
  const map = new Map<string, RecentLocationRecord>();
  for (const rec of listRamRecords<RecentLocationRecord>(db.recentLocations)) {
    map.set(rec.id, rec);
  }
  return map;
}
