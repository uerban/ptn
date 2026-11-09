/**
 * Converts personal data written by earlier versions to sealed storage:
 *
 * - recents, saved places/journeys and stop-use rows become opaque-id rows
 *   whose whole payload is encrypted (labels, timestamps, counts, stop IDs);
 * - favorites, the last map area and delay reports in localStorage are sealed;
 * - the geocoder dedup cache, keyed by unkeyed hashes of searches, is dropped;
 * - service-worker response caches that reveal recent activity are purged.
 *
 * Runs once per device under a cross-tab lock, before any personal reader or
 * writer in this tab proceeds (see `trackPersonalStorageMigration`). Each
 * record is converted atomically and verified before its source is removed,
 * so an interrupted run resumes where it stopped. The completion marker is
 * written only after no plaintext record remains. Nothing is ever copied to a
 * plaintext backup.
 */
import type { BaseEndpoint } from "@pt/shared";
import {
  db,
  type CityUsageStatRecord,
  type RecentLocationRecord,
  type SavedLocationRecord,
  type UsageStatRecord,
} from "../db/index.ts";
import { decrypt, type EncryptedRecord } from "./cryptoBox.ts";
import { withMigrationLock, type MigrationLockOptions } from "./crossTab.ts";
import { reportError } from "./errorReporter.ts";
import { getOrCreateInstallKey, InstallKeyError, isInstallKeyDurable } from "./installKey.ts";
import {
  PERSONAL_STORAGE_MARKER_KEY,
  PERSONAL_STORAGE_VERSION,
  isPersonalStorageMigrated,
  registerPersonalStorageMigration,
  isSealedRow,
  newPersonalId,
  openRow,
  sealRow,
  setPersonalStorageMigrationState,
  trackPersonalStorageMigration,
  type PersonalStorageFailure,
  type PersonalTable,
} from "./personalStorage.ts";
import { SEALED_LOCAL_STORAGE_KEYS } from "./privacyStorageKeys.ts";
import { runPrivacyDataMigration } from "./privacyDataMigration.ts";
import { isPrivacyDataMigrationComplete } from "./privacyDataMigrationState.ts";
import type { RecentPayload } from "./recents.ts";
import type { SavePayload } from "./saves.ts";
import { isSealedValue, openSealedString, sealString } from "./sealedLocalStorage.ts";
import { canonicalCityId, readStoredCityId } from "../utils/cityId.ts";

/**
 * A legacy row's city, moved inside the sealed payload. Rows written before
 * records carried a city take the city selected when the migration runs, so
 * they stay visible there; they stay untagged only when no city is known.
 */
function legacyCity(cityId: unknown, fallbackCityId: string | null): { cityId?: string } {
  if (typeof cityId === "string" && cityId) return { cityId: canonicalCityId(cityId) };
  return fallbackCityId ? { cityId: fallbackCityId } : {};
}


/** Response caches whose entries reveal stops, departures or map areas viewed. */
export const ACTIVITY_CACHE_PREFIXES: readonly string[] = [
  "api-departures-cache",
  "api-stops-cache",
  "carto-tiles",
];

export class PersonalStorageMigrationError extends Error {
  readonly failure: PersonalStorageFailure;
  readonly cause?: unknown;
  constructor(failure: PersonalStorageFailure, message: string, cause?: unknown) {
    super(message);
    this.name = "PersonalStorageMigrationError";
    this.failure = failure;
    this.cause = cause;
  }
}

type MigrationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

export interface PersonalStorageMigrationOptions {
  storage?: MigrationStorage;
  cacheStorage?: CacheStorageLike | null;
  lock?: MigrationLockOptions;
  /** Test hook: called after each converted record. */
  onRecordConverted?: (table: PersonalTable | "usageStats" | "localStorage") => void;
}

export type PersonalStorageMigrationResult =
  | "already-complete"
  | "migrated"
  | "failed";

function isEncryptedShape(x: unknown): x is EncryptedRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return "iv" in r && "ct" in r && "v" in r;
}

function errorName(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function classify(e: unknown): PersonalStorageFailure {
  if (e instanceof PersonalStorageMigrationError) return e.failure;
  if (e instanceof InstallKeyError) return "key-unavailable";
  const name = errorName(e) ?? errorName((e as { inner?: unknown } | null)?.inner);
  if (name === "QuotaExceededError") return "storage-full";
  return "failed";
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Converts binary fields so an unreadable legacy row survives sealing. */
function toSealable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => {
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        const bytes =
          v instanceof ArrayBuffer
            ? new Uint8Array(v)
            : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        return { bytes: Array.from(bytes) };
      }
      return v;
    }),
  );
}

/**
 * A legacy record whose ciphertext does not decrypt with the current key. It
 * is kept, sealed whole, rather than destroyed or left with plaintext
 * metadata. Readers skip it; deleting personal data removes it.
 */
interface UnreadableLegacyRecord {
  unreadableLegacy: true;
  row: unknown;
}

async function sealVerified<T>(
  id: string,
  value: T,
  key: CryptoKey,
): Promise<{ id: string; sealed: EncryptedRecord }> {
  const row = await sealRow(id, value, key);
  const back = await openRow<unknown>(row, key);
  if (!sameJson(back, value)) {
    throw new PersonalStorageMigrationError("failed", "Sealed record did not verify");
  }
  return row;
}

async function openLegacy<T>(
  value: T | EncryptedRecord,
  key: CryptoKey,
): Promise<T> {
  return isEncryptedShape(value) ? ((await decrypt(value, key)) as T) : value;
}

async function convertRecents(
  key: CryptoKey,
  opts: PersonalStorageMigrationOptions,
  currentCityId: string | null,
) {
  const rows = (await db.recentLocations.toArray()) as unknown[];
  for (const raw of rows) {
    if (isSealedRow(raw)) continue;
    const legacy = raw as RecentLocationRecord;
    let value: RecentPayload | UnreadableLegacyRecord;
    try {
      value = {
        endpoint: await openLegacy<BaseEndpoint>(legacy.endpoint, key),
        usedAt: typeof legacy.usedAt === "number" ? legacy.usedAt : 0,
        usedAsOrigin: legacy.usedAsOrigin === true,
        ...legacyCity(legacy.cityId, currentCityId),
      };
    } catch {
      value = { unreadableLegacy: true, row: toSealable(legacy) };
    }
    // Legacy ids are endpoint fingerprints (coordinates and labels): the
    // sealed copy gets an opaque id, written and swapped in one transaction.
    const sealed = await sealVerified(newPersonalId(), value, key);
    await db.transaction("rw", db.recentLocations, async () => {
      await db.recentLocations.put(sealed);
      await db.recentLocations.delete(legacy.id);
    });
    opts.onRecordConverted?.("recentLocations");
  }
}

async function convertSaves(
  key: CryptoKey,
  opts: PersonalStorageMigrationOptions,
  currentCityId: string | null,
) {
  const rows = (await db.savedLocations.toArray()) as unknown[];
  for (const raw of rows) {
    if (isSealedRow(raw)) continue;
    const legacy = raw as SavedLocationRecord;
    let value: SavePayload | UnreadableLegacyRecord;
    try {
      const origin = await openLegacy<BaseEndpoint>(legacy.endpoint, key);
      const destination =
        legacy.destinationEndpoint !== undefined
          ? await openLegacy<BaseEndpoint>(legacy.destinationEndpoint, key)
          : undefined;
      const alias =
        legacy.aliasCipher !== undefined
          ? ((await decrypt(legacy.aliasCipher, key)) as string)
          : (legacy.alias ?? "");
      value = {
        origin,
        ...(destination !== undefined ? { destination } : {}),
        alias,
        savedAt: typeof legacy.savedAt === "number" ? legacy.savedAt : 0,
        ...(legacy.pinColor !== undefined ? { pinColor: legacy.pinColor } : {}),
        ...legacyCity(legacy.cityId, currentCityId),
      };
    } catch {
      value = { unreadableLegacy: true, row: toSealable(legacy) };
    }
    // Save ids are already random: the sealed row replaces the legacy one in
    // place, so a repeated run cannot duplicate it.
    const sealed = await sealVerified(legacy.id, value, key);
    await db.savedLocations.put(sealed);
    opts.onRecordConverted?.("savedLocations");
  }
}

async function convertUsage(
  key: CryptoKey,
  opts: PersonalStorageMigrationOptions,
  currentCityId: string | null,
) {
  const rows = (await db.usageStats.toArray()) as UsageStatRecord[];
  for (const legacy of rows) {
    const sealed = await sealVerified(
      newPersonalId(),
      {
        stopId: legacy.stopId,
        tapCount: typeof legacy.tapCount === "number" ? legacy.tapCount : 0,
        lastTapped: typeof legacy.lastTapped === "number" ? legacy.lastTapped : 0,
      },
      key,
    );
    await db.transaction("rw", db.usageStats, db.personalUsage, async () => {
      await db.personalUsage.put(sealed);
      await db.usageStats.delete(legacy.stopId);
    });
    opts.onRecordConverted?.("usageStats");
  }
  // Per-city rows: the city and stop move inside the ciphertext.
  const cityRows = (await db.cityUsageStats.toArray()) as CityUsageStatRecord[];
  for (const legacy of cityRows) {
    const sealed = await sealVerified(
      newPersonalId(),
      {
        stopId: legacy.stopId,
        ...legacyCity(legacy.cityId, currentCityId),
        tapCount: typeof legacy.tapCount === "number" ? legacy.tapCount : 0,
        lastTapped: typeof legacy.lastTapped === "number" ? legacy.lastTapped : 0,
      },
      key,
    );
    await db.transaction("rw", db.cityUsageStats, db.personalUsage, async () => {
      await db.personalUsage.put(sealed);
      await db.cityUsageStats.delete(legacy.id);
    });
    opts.onRecordConverted?.("usageStats");
  }
}

function readItem(storage: MigrationStorage, name: string): string | null {
  try {
    return storage.getItem(name);
  } catch (cause) {
    throw new PersonalStorageMigrationError("failed", `Could not read ${name}`, cause);
  }
}

async function convertLocalStorage(
  key: CryptoKey,
  storage: MigrationStorage,
  opts: PersonalStorageMigrationOptions,
) {
  for (const name of SEALED_LOCAL_STORAGE_KEYS) {
    const raw = readItem(storage, name);
    if (raw === null || isSealedValue(raw)) continue;
    const sealed = await sealString(raw, key);
    if ((await openSealedString(sealed, key)) !== raw) {
      throw new PersonalStorageMigrationError("failed", `Sealed ${name} did not verify`);
    }
    // setItem replaces the value atomically; no plaintext copy is kept.
    storage.setItem(name, sealed);
    opts.onRecordConverted?.("localStorage");
  }
}

async function hasLegacyData(storage: MigrationStorage): Promise<boolean> {
  for (const table of ["recentLocations", "savedLocations"] as const) {
    const rows = (await db.table(table).toArray()) as unknown[];
    if (rows.some((row) => !isSealedRow(row))) return true;
  }
  if ((await db.usageStats.count()) > 0) return true;
  if ((await db.cityUsageStats.count()) > 0) return true;
  return SEALED_LOCAL_STORAGE_KEYS.some((name) => {
    const raw = readItem(storage, name);
    return raw !== null && !isSealedValue(raw);
  });
}

async function purgeActivityCaches(cacheStorage: CacheStorageLike | null | undefined) {
  if (!cacheStorage) return;
  try {
    const names = await cacheStorage.keys();
    await Promise.all(
      names
        .filter((name) => ACTIVITY_CACHE_PREFIXES.some((p) => name.startsWith(p)))
        .map((name) => cacheStorage.delete(name)),
    );
  } catch (err) {
    // Response caches expire on their own; their purge must not block the
    // personal-record conversion.
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: { source: "personalStorageMigration.purgeCaches" },
    });
  }
}

function defaultCaches(): CacheStorageLike | null {
  try {
    return (globalThis.caches as CacheStorageLike | undefined) ?? null;
  } catch {
    return null;
  }
}

async function convertAll(
  storage: MigrationStorage,
  opts: PersonalStorageMigrationOptions,
): Promise<void> {
  // History written before optional-storage choices existed is deleted, not
  // converted: that cleanup must have run first.
  if (!isPrivacyDataMigrationComplete(storage)) {
    await runPrivacyDataMigration({ storage });
  }
  // Searches keyed by unkeyed hashes could confirm a guessed query.
  await db.geocoderDedup.clear();
  await purgeActivityCaches(
    opts.cacheStorage === undefined ? defaultCaches() : opts.cacheStorage,
  );

  if (await hasLegacyData(storage)) {
    const key = await getOrCreateInstallKey();
    if (!isInstallKeyDurable()) {
      throw new PersonalStorageMigrationError(
        "key-unavailable",
        "The install key cannot be stored on this device",
      );
    }
    const currentCityId = readStoredCityId(storage);
    await convertRecents(key, opts, currentCityId);
    await convertSaves(key, opts, currentCityId);
    await convertUsage(key, opts, currentCityId);
    await convertLocalStorage(key, storage, opts);
    if (await hasLegacyData(storage)) {
      throw new PersonalStorageMigrationError("failed", "Plaintext records remain");
    }
  }
  storage.setItem(PERSONAL_STORAGE_MARKER_KEY, PERSONAL_STORAGE_VERSION);
}

let running: Promise<PersonalStorageMigrationResult> | null = null;

/**
 * Runs the conversion unless this device already completed it. On failure
 * transit keeps working, personal records are kept for this session only, and
 * the status reports that securing existing data is not complete.
 */
export function runPersonalStorageMigration(
  opts: PersonalStorageMigrationOptions = {},
): Promise<PersonalStorageMigrationResult> {
  if (running) return running;
  let storage: MigrationStorage;
  try {
    // Reading `localStorage` itself throws where site data is blocked.
    storage = opts.storage ?? globalThis.localStorage;
    if (!storage) throw new Error("localStorage is not available");
  } catch {
    // Nothing durable can be written: personal records stay session-only
    // and no reader retries the conversion in this session.
    setPersonalStorageMigrationState("failed", "key-unavailable");
    return Promise.resolve("failed");
  }
  if (isPersonalStorageMigrated(storage)) {
    setPersonalStorageMigrationState("complete");
    return Promise.resolve("already-complete");
  }
  setPersonalStorageMigrationState("running");
  const work = withMigrationLock(
    "personal-storage",
    async (): Promise<PersonalStorageMigrationResult> => {
      // Another tab may have finished while this one waited for the lock.
      if (isPersonalStorageMigrated(storage)) return "already-complete";
      await convertAll(storage, opts);
      return "migrated";
    },
    opts.lock,
  );
  running = trackPersonalStorageMigration(
    work.then(
      (result) => {
        setPersonalStorageMigrationState("complete");
        return result;
      },
      (err: unknown) => {
        setPersonalStorageMigrationState("failed", classify(err));
        reportError(err instanceof Error ? err : new Error(String(err)), {
          context: { where: "personalStorageMigration" },
        });
        return "failed" as const;
      },
    ),
  ).finally(() => {
    running = null;
  });
  return running;
}

registerPersonalStorageMigration(runPersonalStorageMigration);
