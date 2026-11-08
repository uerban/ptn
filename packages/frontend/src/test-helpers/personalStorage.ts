/**
 * Test helpers for sealed personal storage: reset every layer between tests
 * and inspect what IndexedDB and localStorage actually hold.
 */
import { db } from "../db/index.ts";
import { __resetInstallKeyCacheForTests } from "../services/installKey.ts";
import { __resetDegradedModeForTests } from "../services/installKeyDegrade.ts";
import {
  PERSONAL_STORAGE_MARKER_KEY,
  PERSONAL_STORAGE_VERSION,
  __resetPersonalStorageForTests,
} from "../services/personalStorage.ts";
import { __resetSealedLocalStorageForTests } from "../services/sealedLocalStorage.ts";
import {
  PRIVACY_DATA_MIGRATION_KEY,
  PRIVACY_DATA_MIGRATION_VERSION,
} from "../services/privacyDataMigrationState.ts";

export interface ResetPersonalStorageOptions {
  /** Mark the device as already converted (default true). */
  migrated?: boolean;
}

/** Clears personal tables, keys, caches and markers. */
export async function resetPersonalStorage(
  opts: ResetPersonalStorageOptions = {},
): Promise<void> {
  if (!db.isOpen()) await db.open();
  await Promise.all([
    db.installKey.clear(),
    db.recentLocations.clear(),
    db.savedLocations.clear(),
    db.personalUsage.clear(),
    db.usageStats.clear(),
    db.cityUsageStats.clear(),
    db.geocoderDedup.clear(),
  ]);
  __resetInstallKeyCacheForTests();
  __resetDegradedModeForTests();
  __resetPersonalStorageForTests();
  __resetSealedLocalStorageForTests();
  localStorage.setItem(PRIVACY_DATA_MIGRATION_KEY, PRIVACY_DATA_MIGRATION_VERSION);
  if (opts.migrated ?? true) {
    localStorage.setItem(PERSONAL_STORAGE_MARKER_KEY, PERSONAL_STORAGE_VERSION);
  } else {
    localStorage.removeItem(PERSONAL_STORAGE_MARKER_KEY);
  }
}

/** Every raw row of a table, serialised the way a forensic reader would see it. */
export async function rawTableText(table: string): Promise<string> {
  const rows = await db.table(table).toArray();
  return JSON.stringify(rows, (_k, v: unknown) => {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      const bytes =
        v instanceof ArrayBuffer
          ? new Uint8Array(v)
          : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      // Decode as text so a plaintext label inside a buffer would still show.
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    return v;
  });
}

/** Every localStorage value, concatenated. */
export function rawLocalStorageText(): string {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key) out.push(`${key}=${localStorage.getItem(key) ?? ""}`);
  }
  return out.join("\n");
}

/** Asserts that none of `needles` appears in `haystack`. */
export function findLeaks(haystack: string, needles: readonly string[]): string[] {
  return needles.filter((n) => haystack.includes(n));
}
