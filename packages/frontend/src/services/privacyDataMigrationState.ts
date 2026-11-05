export const PRIVACY_DATA_MIGRATION_KEY = "ptn-privacy-data-migration";
export const PRIVACY_DATA_MIGRATION_VERSION = "1";

/**
 * Optional writers stay closed until the one-shot legacy-data cleanup has
 * completed. Reading the marker at each write boundary also fails closed when
 * storage is unavailable or a prior cleanup only completed partially.
 */
export function isPrivacyDataMigrationComplete(
  storage?: Pick<Storage, "getItem">,
): boolean {
  try {
    const activeStorage = storage ?? globalThis.localStorage;
    return activeStorage?.getItem(PRIVACY_DATA_MIGRATION_KEY) ===
      PRIVACY_DATA_MIGRATION_VERSION;
  } catch {
    return false;
  }
}
