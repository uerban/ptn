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
import { useCityStore } from "../stores/cityStore.ts";
import { canonicalCityId } from "../utils/cityId.ts";
import { isOptionalStorageEnabledNow } from "./privacyChoices.ts";

export const MAX_RECENTS = 50;

export const RECENTS_LIST_LIMIT = 25;

export const RECENTS_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Decrypted snapshot cache (hot-path: listRecents runs per keystroke). Invalidated
// by every mutation (recordRecent / clearRecents / migrateRecentsForLevelChange).
let _recentsCache: {cityId: string; axis: PrivacyPolicy["recentsEncryption"]; values: RecentRef[]} | null = null;
let recentsRevision = 0;
function invalidateRecentsCache(): void {
  _recentsCache = null;
  recentsRevision++;
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

/** Opaque city-qualified storage key; coordinates/labels never become indexes. */
export async function recentStorageId(endpoint: BaseEndpoint, cityId = canonicalCityId(useCityStore.getState().activeCity.id)): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([cityId, endpointFingerprint(endpoint)]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
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
  const cityId = canonicalCityId(useCityStore.getState().activeCity.id);
  const id = await recentStorageId(endpoint, cityId);
  if (!isOptionalStorageEnabledNow("recents")) return;

  if (tier === "ram-only") {
    const record: RecentLocationRecord = {
      id,
      cityId,
      endpoint,
      usedAt: now,
      usedAsOrigin: opts.usedAsOrigin,
    };
    await writeRecord(db.recentLocations, record, { tier: "ram-only" });
    evictRamIfNeeded(cityId);
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

  if (!isOptionalStorageEnabledNow("recents") || getPolicy().recentsEncryption !== axis) return;
  await db.recentLocations.put({
    id,
    cityId,
    endpoint: storedEndpoint,
    usedAt: now,
    usedAsOrigin: opts.usedAsOrigin,
  });
  await evictIfNeeded(cityId);
  invalidateRecentsCache();
}

async function evictIfNeeded(cityId: string): Promise<void> {
  const rows = await db.recentLocations.where("cityId").equals(cityId).sortBy("usedAt");
  const excess = rows.length - MAX_RECENTS;
  if (excess > 0) await db.recentLocations.bulkDelete(rows.slice(0, excess).map(row => row.id));
}

function evictRamIfNeeded(cityId: string): void {
  const entries = listRamRecords<RecentLocationRecord>(db.recentLocations).filter(row => row.cityId === cityId);
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
  const cityId = canonicalCityId(useCityStore.getState().activeCity.id);
  const revision = recentsRevision;
  if (_recentsCache?.cityId === cityId && _recentsCache.axis === axis) return _recentsCache.values;
  const tier = tierForRecentsAxis(axis);
  const out: RecentRef[] = [];
  if (tier === "ram-only") {
    for (const rec of listRamRecords<RecentLocationRecord>(db.recentLocations)) {
      if (rec.cityId !== cityId || isEncryptedShape(rec.endpoint)) continue;
      out.push({ kind: "recent", base: rec.endpoint as BaseEndpoint, usedAt: rec.usedAt, usedAsOrigin: rec.usedAsOrigin });
    }
  } else {
    const rows = await db.recentLocations.where("cityId").anyOf(cityId === "tricity" ? [cityId, "gdansk"] : [cityId]).toArray();
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
  if (!isOptionalStorageEnabledNow("recents") || getPolicy().recentsEncryption !== axis || canonicalCityId(useCityStore.getState().activeCity.id) !== cityId) return [];
  if (revision !== recentsRevision) return listRecents();
  const values = out.slice(0, RECENTS_LIST_LIMIT);
  _recentsCache = {cityId, axis, values};
  return values;
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

  const source = prevTier === "ram-only"
    ? listRamRecords<RecentLocationRecord>(db.recentLocations)
    : await db.recentLocations.toArray();
  if (!source.length) return;
  const version = (row: RecentLocationRecord) => JSON.stringify(row, (_key, value) =>
    Object.prototype.toString.call(value) === "[object ArrayBuffer]"
      ? Array.from(new Uint8Array(value as ArrayBuffer)) : value);
  const rewritten = new Map<string, RecentLocationRecord>();
  let key: CryptoKey | null = null;
  for (const row of source) {
    let endpoint = row.endpoint;
    if (isEncryptedShape(endpoint)) {
      key ??= await getOrCreateInstallKey();
      try { endpoint = await decrypt(endpoint, key) as BaseEndpoint; }
      catch {
        // Retain the opaque record for recovery. RAM-only policy moves even
        // unreadable ciphertext off disk; listRecents does not expose it.
        rewritten.set(row.id, row);
        continue;
      }
    }
    if (nextTier === "encrypted") {
      key ??= await getOrCreateInstallKey();
      endpoint = await encrypt(endpoint, key);
    }
    rewritten.set(row.id, {...row, endpoint});
  }
  if (!isOptionalStorageEnabledNow("recents")) { await clearRecents(); return; }
  const moved: RecentLocationRecord[] = [];
  await db.transaction("rw", db.recentLocations, async () => {
    for (const original of source) {
      const current = await db.recentLocations.get(original.id);
      if (prevTier === "ram-only") {
        // A newly persisted visit must not be replaced by the older RAM copy.
        if (current && current.usedAt > original.usedAt) continue;
      } else if (!current || version(current) !== version(original)) continue;
      const nextRow = rewritten.get(original.id)!;
      if (nextTier === "ram-only") await db.recentLocations.delete(original.id);
      else await db.recentLocations.put(nextRow);
      moved.push(nextRow);
    }
  });
  // Only committed rows move between stores. Encryption/quota/transaction
  // failure leaves the source intact; concurrent visits and deletes survive.
  if (!isOptionalStorageEnabledNow("recents")) { await clearRecents(); return; }
  if (nextTier === "ram-only") {
    for (const row of moved) {
      if (!isOptionalStorageEnabledNow("recents")) { await clearRecents(); return; }
      const current = listRamRecords<RecentLocationRecord>(db.recentLocations).find(value => value.id === row.id);
      if (!current || current.usedAt <= row.usedAt) await writeRecord(db.recentLocations, row, {tier: "ram-only"});
    }
  }
  if (prevTier === "ram-only") {
    const currentRam = new Map(listRamRecords<RecentLocationRecord>(db.recentLocations).map(row => [row.id, row]));
    for (const original of source) {
      const current = currentRam.get(original.id);
      if (current && version(current) === version(original)) deleteRamRecord(db.recentLocations, original.id);
    }
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
