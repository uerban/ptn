/**
 * What the rider can do when personal data could not be encrypted or read:
 * retry, delete the unreadable part, or delete everything personal and start
 * over with a new key.
 */
import { db } from "../db/index.ts";
import { useDelayReportStore } from "../stores/delayReportStore.ts";
import { useFavoritesStore } from "../stores/favoritesStore.ts";
import { resetInstallKeys, retryInstallKeyReadNow } from "./installKey.ts";
import {
  PERSONAL_TABLES,
  clearPersonal,
  deleteUnreadablePersonal,
  runRegisteredPersonalStorageMigration,
  usePersonalStorageStatus,
} from "./personalStorage.ts";
import type { PersonalStorageMigrationResult } from "./personalStorageMigration.ts";
import { SEALED_LOCAL_STORAGE_KEYS } from "./privacyStorageKeys.ts";
import {
  mapViewportItem,
  readSealedItem,
  removeSealedItem,
} from "./sealedLocalStorage.ts";

type Storage_ = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Reloads sealed localStorage state into the stores that show it. */
export async function rehydrateSealedStores(): Promise<void> {
  await Promise.all([
    useFavoritesStore.persist.rehydrate(),
    useDelayReportStore.persist.rehydrate(),
    mapViewportItem.load(),
  ]);
}

/** Retries a failed key read and the storage migration, then reloads. */
export async function retryPersonalStorage(): Promise<PersonalStorageMigrationResult> {
  retryInstallKeyReadNow();
  const result = await runRegisteredPersonalStorageMigration();
  if (result !== "failed") await rehydrateSealedStores();
  return result;
}

/**
 * Deletes stored records that cannot be decrypted and keeps readable ones.
 * When the key itself is unusable nothing is readable, so this deletes all
 * personal data and the key (see `deleteAllPersonalData`).
 */
export async function deleteUnreadablePersonalData(
  storage: Storage_ = globalThis.localStorage,
): Promise<void> {
  if (usePersonalStorageStatus.getState().keyMode === "key-unreadable") {
    await deleteAllPersonalData(storage);
    return;
  }
  for (const table of PERSONAL_TABLES) await deleteUnreadablePersonal(table);
  for (const name of SEALED_LOCAL_STORAGE_KEYS) {
    const raw = storage.getItem(name);
    if (raw !== null && (await readSealedItem(name, storage)) === null) {
      removeSealedItem(name, storage);
    }
  }
  await rehydrateSealedStores();
}

/**
 * Deletes every personal record on this device (saved places, favorites,
 * recents, stop use, delay reports, last map area), readable or not, and the
 * keys that sealed them; then finishes the storage migration with nothing
 * left to convert.
 */
export async function deleteAllPersonalData(
  storage: Storage_ = globalThis.localStorage,
): Promise<void> {
  for (const table of PERSONAL_TABLES) await clearPersonal(table);
  // Stop use from before it was sealed: left in place, the migration below
  // would convert it into fresh personal records.
  await Promise.all([db.usageStats.clear(), db.cityUsageStats.clear()]);
  await db.geocoderDedup.clear();
  for (const name of SEALED_LOCAL_STORAGE_KEYS) removeSealedItem(name, storage);
  useFavoritesStore.setState({ favorites: [] });
  useDelayReportStore.setState({ reports: [] });
  await resetInstallKeys();
  await runRegisteredPersonalStorageMigration({ storage });
  await rehydrateSealedStores();
}
